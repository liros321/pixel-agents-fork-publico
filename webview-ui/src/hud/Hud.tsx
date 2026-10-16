// HUD moderno do escritório: barra superior com contadores, painel lateral com
// os agentes (clique para seguir no mapa), histórico de atividade e alertas
// quando alguma sessão está esperando o usuário.
import { useEffect, useMemo, useRef, useState } from 'react';

import type { OfficeState } from '../office/engine/officeState.js';
import type { ToolActivity } from '../office/types.js';
import './hud.css';

type Estado = 'trabalhando' | 'esperando' | 'ocioso';
type Filtro = 'todos' | Estado;

interface Linha { t: number; texto: string }
interface AgenteVisto {
  id: number;
  nome: string;
  estado: Estado;
  atividade: string;
  desde: number;
  ultimo: number;
}

interface HudProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
}

const ROTULO: Record<Estado, string> = {
  trabalhando: 'Trabalhando',
  esperando: 'Esperando você',
  ocioso: 'Ocioso',
};

function lerLS(k: string, d: string): string {
  try { return localStorage.getItem(k) ?? d; } catch { return d; }
}
function gravarLS(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* sem storage */ }
}

function tempo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}`;
}

function hora(t: number): string {
  return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function Hud({ officeState, agents, agentTools }: HudProps) {
  const [, setTick] = useState(0);
  const [aberto, setAberto] = useState(() => lerLS('hud.aberto', '1') === '1');
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [expandido, setExpandido] = useState<number | null>(null);
  const [alertas, setAlertas] = useState(() => lerLS('hud.alertas', '0') === '1');
  const [toasts, setToasts] = useState<{ id: number; texto: string }[]>([]);
  const historico = useRef(new Map<number, Linha[]>());
  const anterior = useRef(new Map<number, { estado: Estado; atividade: string; desde: number; ultimo: number }>());

  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(iv);
  }, []);

  const agora = Date.now();
  const lista: AgenteVisto[] = [];
  for (const id of agents) {
    const ch = officeState.characters.get(id);
    if (!ch || ch.isSubagent) continue;
    const tools = agentTools[id] ?? [];
    const permissao = tools.some((t) => t.permissionWait && !t.done) || ch.bubbleType === 'permission';
    const esperando = permissao || (ch.bubbleType === 'waiting' && !!ch.waitingAwaitingInput);
    const estado: Estado = esperando ? 'esperando' : ch.isActive ? 'trabalhando' : 'ocioso';
    const ativa = [...tools].reverse().find((t) => !t.done) ?? (ch.isActive ? tools[tools.length - 1] : undefined);
    const atividade = estado === 'esperando'
      ? (permissao ? 'Precisa da sua aprovação' : 'Esperando sua resposta')
      : estado === 'ocioso' ? 'Ocioso' : (ativa?.status ?? 'Pensando…');
    const prev = anterior.current.get(id);
    const desde = prev && prev.estado === estado ? prev.desde : agora;
    const ultimo = prev && prev.atividade === atividade ? prev.ultimo : agora;
    lista.push({ id, nome: ch.folderName || `Agente ${id}`, estado, atividade, desde, ultimo });
  }

  // Detecta mudanças: histórico + alertas (fora do render, num efeito).
  const assinatura = lista.map((a) => `${a.id}:${a.estado}:${a.atividade}`).join('|');
  useEffect(() => {
    const novos: string[] = [];
    for (const a of lista) {
      const prev = anterior.current.get(a.id);
      if (!prev || prev.atividade !== a.atividade) {
        const h = historico.current.get(a.id) ?? [];
        h.unshift({ t: Date.now(), texto: a.atividade });
        historico.current.set(a.id, h.slice(0, 30));
      }
      if (a.estado === 'esperando' && prev && prev.estado !== 'esperando') novos.push(a.nome);
      anterior.current.set(a.id, { estado: a.estado, atividade: a.atividade, desde: a.desde, ultimo: a.ultimo });
    }
    for (const id of [...anterior.current.keys()]) if (!agents.includes(id)) anterior.current.delete(id);
    for (const nome of novos) {
      const tid = Date.now() + Math.random();
      setToasts((t) => [...t, { id: tid, texto: `${nome} está esperando você` }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== tid)), 7000);
      if (alertas && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('Escritório dos agentes', { body: `${nome} está esperando você` }); } catch { /* ignore */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assinatura]);

  const cont = useMemo(() => {
    const c = { trabalhando: 0, esperando: 0, ocioso: 0 };
    for (const a of lista) c[a.estado]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assinatura]);

  useEffect(() => {
    document.title = cont.esperando ? `(${cont.esperando}) Escritório dos agentes` : 'Escritório dos agentes';
  }, [cont.esperando]);

  const ordem: Record<Estado, number> = { esperando: 0, trabalhando: 1, ocioso: 2 };
  const visiveis = lista
    .filter((a) => filtro === 'todos' || a.estado === filtro)
    .sort((x, y) => ordem[x.estado] - ordem[y.estado] || x.nome.localeCompare(y.nome, 'pt-BR'));

  const selecionado = officeState.selectedAgentId;
  const seguir = (id: number) => {
    if (officeState.selectedAgentId === id) {
      officeState.selectedAgentId = null;
      officeState.cameraFollowId = null;
    } else {
      officeState.selectedAgentId = id;
      officeState.cameraFollowId = id;
    }
    setTick((n) => n + 1);
  };

  const alternarPainel = () => { setAberto((v) => { gravarLS('hud.aberto', v ? '0' : '1'); return !v; }); };
  const alternarAlertas = async () => {
    if (!alertas && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
    setAlertas((v) => { gravarLS('hud.alertas', v ? '0' : '1'); return !v; });
  };

  return (
    <>
      <header className="hud-top">
        <div className="hud-brand">
          <span className="hud-logo">◆</span>
          <div>
            <strong>Escritório dos agentes</strong>
            <small>{lista.length} {lista.length === 1 ? 'sessão' : 'sessões'} conectadas</small>
          </div>
        </div>
        <div className="hud-chips">
          {(['trabalhando', 'esperando', 'ocioso'] as Estado[]).map((e) => (
            <button
              key={e}
              className={`hud-chip hud-chip--${e} ${filtro === e ? 'is-on' : ''} ${e === 'esperando' && cont.esperando ? 'hud-chip--pulse' : ''}`}
              onClick={() => setFiltro(filtro === e ? 'todos' : e)}
              title={`Filtrar: ${ROTULO[e]}`}
            >
              <i />{ROTULO[e]}<b>{cont[e]}</b>
            </button>
          ))}
        </div>
        <div className="hud-actions">
          <button className={`hud-icon ${alertas ? 'is-on' : ''}`} onClick={alternarAlertas} title={alertas ? 'Alertas na área de trabalho: ligados' : 'Ligar alertas na área de trabalho'}>
            {alertas ? '🔔' : '🔕'}
          </button>
          <button className={`hud-icon ${aberto ? 'is-on' : ''}`} onClick={alternarPainel} title={aberto ? 'Esconder painel' : 'Mostrar painel'}>☰</button>
        </div>
      </header>

      {aberto && (
        <aside className="hud-panel">
          <div className="hud-panel-head">
            <span>Sessões</span>
            {filtro !== 'todos' && <button className="hud-link" onClick={() => setFiltro('todos')}>ver todas</button>}
          </div>
          {visiveis.length === 0 && <p className="hud-empty">Nenhuma sessão {filtro === 'todos' ? 'conectada' : `com status "${ROTULO[filtro as Estado]}"`}.</p>}
          {visiveis.map((a) => {
            const hist = historico.current.get(a.id) ?? [];
            const aberta = expandido === a.id;
            return (
              <div key={a.id} className={`hud-card hud-card--${a.estado} ${selecionado === a.id ? 'is-sel' : ''}`}>
                <button className="hud-card-main" onClick={() => seguir(a.id)} title={selecionado === a.id ? 'Parar de seguir' : 'Seguir no escritório'}>
                  <i className="hud-card-dot" />
                  <div className="hud-card-txt">
                    <strong>{a.nome}</strong>
                    <span>{a.atividade}</span>
                  </div>
                  <em>{tempo(agora - (a.estado === 'trabalhando' ? a.ultimo : a.desde))}</em>
                </button>
                <button className="hud-card-more" onClick={() => setExpandido(aberta ? null : a.id)} title="Histórico">
                  {aberta ? '▴' : '▾'}
                </button>
                {aberta && (
                  <ol className="hud-hist">
                    {hist.length === 0 && <li><span>Sem atividade registrada ainda.</span></li>}
                    {hist.slice(0, 12).map((l, i) => (
                      <li key={i}><time>{hora(l.t)}</time><span>{l.texto}</span></li>
                    ))}
                  </ol>
                )}
              </div>
            );
          })}
          <p className="hud-hint">Clique numa sessão para seguir o boneco. Clique de novo para soltar.</p>
        </aside>
      )}

      <div className="hud-toasts">
        {toasts.map((t) => <div key={t.id} className="hud-toast"><b>!</b>{t.texto}</div>)}
      </div>
    </>
  );
}
