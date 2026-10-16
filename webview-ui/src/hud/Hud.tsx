// HUD moderno do escritório: barra superior com contadores, painel lateral com
// os agentes (clique para seguir no mapa), histórico de atividade e alertas
// quando alguma sessão está esperando o usuário.
import { useEffect, useMemo, useRef, useState } from 'react';

import { isSoundEnabled, playPermissionSound, setSoundEnabled, unlockAudio } from '../notificationSound.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { transport } from '../transport/index.js';
import type { ToolActivity } from '../office/types.js';
import './hud.css';

/** Texto mostrado quando alguém tenta desligar o som (também usado nas Configurações). */
export const POR_QUE_SOM =
  'O som é o que avisa quando uma sessão para esperando você — uma pergunta ou uma aprovação. ' +
  'Sem ele, você só percebe se estiver olhando a tela, e a sessão fica parada até lá: ' +
  'é aí que se perde mais tempo. Recomendamos deixar ligado.';

type Estado = 'trabalhando' | 'esperando' | 'ocioso';
interface Social {
  eu: string;
  visitando: string | null;
  amigos: { nome: string; sessoes: number }[];
  recebidos: string[];
  enviados: string[];
}

async function api(caminho: string, corpo?: unknown): Promise<Social | null> {
  try {
    const r = await fetch(caminho, corpo === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo),
    });
    if (!r.ok) {
      if (r.headers.get('content-type')?.includes('json')) {
        const j = (await r.json()) as { erro?: string };
        if (j.erro) throw new Error(j.erro);
      }
      return null;
    }
    return (await r.json()) as Social;
  } catch (e) {
    if (e instanceof Error && e.message && !e.message.includes('fetch')) throw e;
    return null;
  }
}
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
  const [alertas, setAlertas] = useState(() => lerLS('hud.alertas', '1') === '1');
  const [som, setSom] = useState(isSoundEnabled);
  const [confirmarSom, setConfirmarSom] = useState(false);
  const [audioTravado, setAudioTravado] = useState(true);
  const [toasts, setToasts] = useState<{ id: number; texto: string }[]>([]);
  const [social, setSocial] = useState<Social | null>(null);
  const [aba, setAba] = useState<'sessoes' | 'conectados'>('sessoes');
  const [pedirNome, setPedirNome] = useState('');
  const [erroSocial, setErroSocial] = useState('');
  const pedidosVistos = useRef<Set<string> | null>(null);
  const historico = useRef(new Map<number, Linha[]>());
  const anterior = useRef(new Map<number, { estado: Estado; atividade: string; desde: number; ultimo: number }>());

  useEffect(() => {
    const iv = setInterval(() => { setTick((n) => n + 1); setSom(isSoundEnabled()); }, 500);
    return () => clearInterval(iv);
  }, []);

  // Navegadores só liberam áudio depois de um clique: libera no primeiro gesto e, de quebra,
  // pede permissão para as notificações da área de trabalho (ligadas por padrão).
  useEffect(() => {
    const liberar = () => {
      unlockAudio();
      setAudioTravado(false);
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission().catch(() => undefined);
      }
    };
    window.addEventListener('pointerdown', liberar, { once: true });
    window.addEventListener('keydown', liberar, { once: true });
    return () => { window.removeEventListener('pointerdown', liberar); window.removeEventListener('keydown', liberar); };
  }, []);

  const mudarSom = (ligado: boolean) => {
    setSoundEnabled(ligado);
    transport.send({ type: 'setSoundEnabled', enabled: ligado });
    setSom(ligado);
    if (ligado) { unlockAudio(); void playPermissionSound(); }
  };

  // Escritórios conectados: só existe na versão hospedada (a local não tem /api/social).
  useEffect(() => {
    let vivo = true;
    const puxar = async () => {
      const r = await api('/api/social').catch(() => null);
      if (vivo && r) setSocial(r);
    };
    void puxar();
    const iv = setInterval(puxar, 5000);
    return () => { vivo = false; clearInterval(iv); };
  }, []);

  useEffect(() => {
    if (!social) return;
    const atuais = new Set(social.recebidos);
    if (pedidosVistos.current) {
      for (const n of atuais) {
        if (pedidosVistos.current.has(n)) continue;
        const tid = Date.now() + Math.random();
        setToasts((t) => [...t, { id: tid, texto: `${n} quer conectar os escritórios` }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== tid)), 9000);
        if (alertas && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try { new Notification('Adaptus Agentes', { body: `${n} quer conectar os escritórios` }); } catch { /* ignore */ }
        }
      }
    }
    pedidosVistos.current = atuais;
  }, [social, alertas]);

  const acaoSocial = async (caminho: string, nome: string, extra: Record<string, unknown> = {}) => {
    setErroSocial('');
    try {
      const r = await api(caminho, { nome, ...extra });
      if (r) setSocial(r);
      return true;
    } catch (e) {
      setErroSocial(e instanceof Error ? e.message : 'Não deu certo.');
      return false;
    }
  };
  const visitar = async (nome: string) => {
    try { await api('/api/social/visitar', { nome }); location.reload(); } catch (e) { setErroSocial(e instanceof Error ? e.message : 'Não deu certo.'); }
  };
  const voltar = async () => { await api('/api/social/voltar', {}).catch(() => null); location.reload(); };

  // Centro do mapa = centro da área livre (descontando painel lateral e barra do topo).
  useEffect(() => {
    const w = window as unknown as { __hudCenterOffsetX?: number; __hudCenterOffsetY?: number };
    w.__hudCenterOffsetX = aberto && window.innerWidth > 760 ? -(300 + 24) / 2 : 0;
    w.__hudCenterOffsetY = 76 / 2;
  }, [aberto]);

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
        try { new Notification('Adaptus Agentes', { body: `${nome} está esperando você` }); } catch { /* ignore */ }
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
    const base = social?.visitando ? `Escritório de ${social.visitando}` : 'Adaptus Agentes';
    const n = cont.esperando + (social && !social.visitando ? social.recebidos.length : 0);
    document.title = n ? `(${n}) ${base}` : base;
  }, [cont.esperando, social]);

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
  const clicarSino = () => {
    if (som) { setConfirmarSom(true); return; }
    mudarSom(true);
    if (!alertas) { setAlertas(true); gravarLS('hud.alertas', '1'); }
  };

  return (
    <>
      <header className="hud-top">
        <div className="hud-brand">
          <span className="hud-logo"><svg viewBox="0 0 120 120" width="30" height="30" aria-hidden="true"><rect width="120" height="120" rx="26" fill="#0F1628"/><path d="M60 22 98 102H80L60 60 40 102H22Z" fill="#EEF2F8"/><circle cx="60" cy="84" r="10" fill="#070A12"/><circle cx="60" cy="84" r="6" fill="#22D3EE"/></svg></span>
          <div>
            <strong>{social?.visitando ? `Escritório de ${social.visitando}` : 'Adaptus Agentes'}</strong>
            <small>{lista.length} {lista.length === 1 ? 'sessão' : 'sessões'}{social?.visitando ? ' · só visualização' : lista.length === 1 ? ' conectada' : ' conectadas'}</small>
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
        {social?.visitando && (
          <button className="hud-visit" onClick={voltar} title="Voltar para o seu escritório">
            👀 Visitando <b>{social.visitando}</b> · Voltar
          </button>
        )}
        <div className="hud-actions">
          {social && (
            <button
              className={`hud-icon ${aberto && aba === 'conectados' ? 'is-on' : ''}`}
              onClick={() => { if (aberto && aba === 'conectados') { setAba('sessoes'); } else { setAba('conectados'); if (!aberto) alternarPainel(); } }}
              title="Escritórios conectados"
            >
              👥{social.recebidos.length > 0 && !social.visitando && <span className="hud-badge">{social.recebidos.length}</span>}
            </button>
          )}
          <button className={`hud-icon ${som ? 'is-on' : 'hud-icon--off'}`} onClick={clicarSino} title={som ? 'Som dos alertas: ligado' : 'Som dos alertas: desligado — clique para ligar'}>
            {som ? '🔔' : '🔕'}
          </button>
          <button className={`hud-icon ${aberto ? 'is-on' : ''}`} onClick={alternarPainel} title={aberto ? 'Esconder painel' : 'Mostrar painel'}>☰</button>
        </div>
      </header>

      {aberto && aba === 'conectados' && social && (
        <aside className="hud-panel">
          <div className="hud-panel-head">
            <span>Escritórios conectados</span>
            <button className="hud-link" onClick={() => setAba('sessoes')}>sessões</button>
          </div>
          <div className="hud-me">Seu escritório: <b>{social.eu}</b><small>Passe esse nome para quem quiser se conectar.</small></div>
          {!social.visitando && (
            <form className="hud-add" onSubmit={async (e) => {
              e.preventDefault();
              const n = pedirNome.trim().toLowerCase();
              if (n && (await acaoSocial('/api/social/pedir', n))) setPedirNome('');
            }}>
              <input value={pedirNome} onChange={(e) => setPedirNome(e.target.value)} placeholder="Nome do escritório do amigo" />
              <button>Pedir</button>
            </form>
          )}
          {erroSocial && <p className="hud-err">{erroSocial}</p>}
          {social.recebidos.length > 0 && !social.visitando && (
            <>
              <div className="hud-sub">Pedidos para você</div>
              {social.recebidos.map((n) => (
                <div key={n} className="hud-friend hud-friend--pedido">
                  <div><strong>{n}</strong><span>quer ver seu escritório e mostrar o dele</span></div>
                  <div className="hud-friend-btns">
                    <button className="hud-btn hud-btn--ok" onClick={() => acaoSocial('/api/social/responder', n, { aceitar: true })}>Aceitar</button>
                    <button className="hud-btn" onClick={() => acaoSocial('/api/social/responder', n, { aceitar: false })}>Recusar</button>
                  </div>
                </div>
              ))}
            </>
          )}
          <div className="hud-sub">Amigos</div>
          {social.amigos.length === 0 && <p className="hud-empty">Nenhum escritório conectado ainda.</p>}
          {social.amigos.map((a) => (
            <div key={a.nome} className="hud-friend">
              <div><strong>{a.nome}</strong><span>{a.sessoes} {a.sessoes === 1 ? 'sessão' : 'sessões'}</span></div>
              <div className="hud-friend-btns">
                {social.visitando === a.nome
                  ? <button className="hud-btn" onClick={voltar}>Voltar</button>
                  : <button className="hud-btn hud-btn--ok" onClick={() => visitar(a.nome)}>Visitar</button>}
                {!social.visitando && (
                  <button className="hud-btn" title="Desconectar" onClick={() => { if (confirm(`Desconectar do escritório de ${a.nome}?`)) void acaoSocial('/api/social/remover', a.nome); }}>✕</button>
                )}
              </div>
            </div>
          ))}
          {social.enviados.length > 0 && (
            <>
              <div className="hud-sub">Aguardando resposta</div>
              {social.enviados.map((n) => <div key={n} className="hud-friend hud-friend--espera"><div><strong>{n}</strong><span>pedido enviado</span></div></div>)}
            </>
          )}
          <p className="hud-hint">Quem visita só assiste: não move nada nem muda configurações.</p>
        </aside>
      )}

      {aberto && aba === 'sessoes' && (
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

      {!som && (
        <button className="hud-nudge" onClick={() => mudarSom(true)}>
          🔕 O som dos alertas está desligado — você pode não perceber quando uma sessão precisar de você. <b>Ligar</b>
        </button>
      )}
      {som && audioTravado && (
        <div className="hud-nudge hud-nudge--soft">🔔 Clique em qualquer lugar da tela para liberar o som dos alertas.</div>
      )}

      {confirmarSom && (
        <div className="hud-modal-bg" onClick={() => setConfirmarSom(false)}>
          <div className="hud-modal" onClick={(e) => e.stopPropagation()}>
            <strong>Desligar o som dos alertas?</strong>
            <p>{POR_QUE_SOM}</p>
            <div className="hud-modal-btns">
              <button className="hud-btn hud-btn--ok" onClick={() => setConfirmarSom(false)}>Manter ligado</button>
              <button className="hud-btn" onClick={() => { mudarSom(false); setConfirmarSom(false); }}>Desligar mesmo assim</button>
            </div>
          </div>
        </div>
      )}

      <div className="hud-toasts">
        {toasts.map((t) => <div key={t.id} className="hud-toast"><b>!</b>{t.texto}</div>)}
      </div>
    </>
  );
}
