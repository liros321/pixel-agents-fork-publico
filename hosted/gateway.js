// Escritório Adaptus — versão hospedada (Railway).
// Um portão HTTP na frente de um servidor Pixel Agents por sala (cada pessoa = uma sala).
//
//   GET  /                         página de entrada (pede a chave) ou o escritório da sala do cookie
//   GET  /o/<chave>                entra na sala (grava cookie) e abre o escritório
//   GET  /sair                     sai da sala
//   POST /in                       eventos de hook (Authorization: Bearer <chave>)
//   GET  /plugin/<chave>/escritorio-adaptus.plugin   plugin do Cowork já configurado
//   GET  /instalar/<chave>/claude-code.sh|.ps1       instalação para o Claude Code (uma vez)
//   GET  /instalar/<chave>/sessao.sh                 liga uma sessão do Cowork já aberta
//   GET  /cliente/<arquivo>.js                       scripts do cliente (sem segredo)
//   POST /admin/salas {nome}  |  GET /admin/salas   (Authorization: Bearer $ADMIN_TOKEN)
//
// Tudo o que é "apresentação" (nome curto, status curto, aviso de espera, turno
// encerrado por inatividade) é feito aqui, então o plugin quase nunca muda.
'use strict';
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 8080;
const DATA = process.env.DATA_DIR || '/data';
const ADMIN = process.env.ADMIN_TOKEN || '';
const CLI = process.env.PIXEL_AGENTS_CLI || path.join(__dirname, '..', 'dist', 'cli.js');
const CLIENTE = path.join(__dirname, 'cliente');
const SALAS_FILE = path.join(DATA, 'salas.json');
const IDLE_MS = 90 * 1000;          // sem evento após ferramenta = turno encerrado
const AUSENTE_MS = 5 * 60 * 1000;   // sem evento = boneco sai do escritório (volta na próxima atividade)
const FERRAMENTA_MAX_MS = 30 * 60 * 1000;
const MAX_CMD = 34;
const COOKIE = 'ea_sala';

fs.mkdirSync(path.join(DATA, 'salas'), { recursive: true });

// ── Salas ───────────────────────────────────────────────────────────────
let salas = {};
try { salas = JSON.parse(fs.readFileSync(SALAS_FILE, 'utf8')).salas || {}; } catch {}
const salvarSalas = () => fs.writeFileSync(SALAS_FILE, JSON.stringify({ salas }, null, 2));
const porChave = (chave) => {
  if (typeof chave !== 'string' || chave.length < 20) return null;
  for (const [nome, s] of Object.entries(salas)) {
    const a = Buffer.from(s.chave), b = Buffer.from(chave);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return nome;
  }
  return null;
};

// ── Um servidor Pixel Agents por sala ──────────────────────────────────
const rodando = new Map(); // nome -> { port, home, proc, token, sessions, pronto }
let proximaPorta = 5100;

function semearConfig(home) {
  const dir = path.join(home, '.pixel-agents');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  cfg.standalone = { soundEnabled: true, lastSeenVersion: '1.4', alwaysShowLabels: true, ghostHeadlessAgents: false,
    hooksInfoShown: true, showAreas: false, areaMappings: {}, ...(cfg.standalone || {}), watchAllSessions: true };
  cfg.externalAssetDirectories = [];
  cfg.hooksConsent = { claude: 'declined' };
  cfg.hooksEnabled = { claude: false };
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
}

function lerToken(sala) {
  const dir = path.join(sala.home, '.pixel-agents', 'servers');
  try {
    for (const f of fs.readdirSync(dir)) {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (e.port === sala.port && e.token) return e.token;
    }
  } catch {}
  return null;
}

function iniciarSala(nome) {
  let sala = rodando.get(nome);
  if (sala) return sala;
  const home = path.join(DATA, 'salas', nome.replace(/[^\w-]/g, '_'));
  sala = { nome, home, port: proximaPorta++, proc: null, token: null, sessions: new Map(), pronto: null };
  rodando.set(nome, sala);
  const subir = () => {
    semearConfig(home);
    try { fs.rmSync(path.join(home, '.pixel-agents', 'servers'), { recursive: true, force: true }); } catch {}
    sala.token = null;
    sala.proc = spawn(process.execPath, [CLI, '--port', String(sala.port), '--host', '127.0.0.1'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, PIXEL_AGENTS_HOSTED: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    sala.proc.stderr.on('data', (d) => process.stderr.write(`[${nome}] ${d}`));
    sala.proc.on('exit', (code) => {
      console.error(`[${nome}] servidor saiu (${code}); reiniciando em 3 s`);
      sala.pronto = null;
      setTimeout(subir, 3000);
    });
    sala.pronto = (async () => {
      for (let i = 0; i < 100 && !sala.token; i++) { await sleep(200); sala.token = lerToken(sala); }
      if (sala.token) await recriarAgentes(sala);
      return sala.token;
    })();
  };
  subir();
  return sala;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postHook(sala, hook) {
  if (!sala.token) await sala.pronto;
  if (!sala.token) return;
  const body = JSON.stringify(hook);
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: sala.port, path: '/api/hooks/claude', method: 'POST', timeout: 3000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${sala.token}` } },
    (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
    req.end(body);
  });
}

// ── Apresentação (igual à ponte local) ──────────────────────────────────
const SAFE_INPUT = ['file_path', 'pattern', 'path', 'command', 'query', 'url', 'description', 'subagent_type'];
const SAFE_KEYS = ['tool_name', 'notification_type', 'source', 'agent_id', 'agent_type', 'reason', 'message'];
const cut = (v, n) => (v.length > n ? v.slice(0, n - 1).trimEnd() + '…' : v);
const str = (v, n = 160) => (typeof v === 'string' && v ? v.slice(0, n) : undefined);

function limpar(h) {
  if (!h || typeof h.hook_event_name !== 'string' || typeof h.session_id !== 'string') return null;
  if (h.hook_event_name === 'UserPromptSubmit') return null;
  const nome = String(h.cwd || '').split('/').pop().replace(/^Cowork\s*[·-]\s*/, '').slice(0, 40) || 'Sessão';
  const hook = { hook_event_name: str(h.hook_event_name, 40), session_id: str(h.session_id, 80), cwd: '/sessao/' + nome };
  for (const k of SAFE_KEYS) if (typeof h[k] === 'string') hook[k] = str(h[k]);
  if (typeof h.stop_hook_active === 'boolean') hook.stop_hook_active = h.stop_hook_active;
  if (h.tool_input && typeof h.tool_input === 'object') {
    hook.tool_input = {};
    for (const k of SAFE_INPUT) if (typeof h.tool_input[k] === 'string') hook.tool_input[k] = str(h.tool_input[k]);
  }
  if (typeof hook.tool_name === 'string') {
    const m = hook.tool_name.match(/^mcp__.+?__(.+)$/);
    if (m) hook.tool_name = m[1].replace(/^(Desktop_Commander|Claude_Browser)__/, '');
  }
  if (hook.tool_name === 'Bash' && hook.tool_input) {
    hook.tool_input.command = cut(hook.tool_input.description || hook.tool_input.command || '', MAX_CMD);
  }
  return hook;
}

async function entregar(sala, hook) {
  const sid = hook.session_id;
  let s = sala.sessions.get(sid);
  if (!s) {
    s = { last: 0, cwd: hook.cwd, turnOpen: false };
    sala.sessions.set(sid, s);
    if (hook.hook_event_name !== 'SessionStart' && hook.hook_event_name !== 'SessionEnd') {
      await postHook(sala, { hook_event_name: 'SessionEnd', session_id: sid, cwd: hook.cwd, reason: 'other' });
      await postHook(sala, { hook_event_name: 'SessionStart', session_id: sid, cwd: hook.cwd, source: 'resume' });
    }
  }
  s.last = Date.now(); s.cwd = hook.cwd;
  const ev = hook.hook_event_name;
  if (ev === 'Stop' || ev === 'SessionEnd') s.turnOpen = false;
  else if (ev === 'PreToolUse' || ev === 'PostToolUse') s.turnOpen = true;
  s.ferramenta = ev === 'PreToolUse';
  s.esperando = (ev === 'PreToolUse' && hook.tool_name === 'AskUserQuestion') || ev === 'PermissionRequest'
    || (ev === 'Notification' && hook.notification_type === 'permission_prompt');
  if (ev === 'SessionEnd') sala.sessions.delete(sid);
  await postHook(sala, hook);
  if (ev === 'PreToolUse' && hook.tool_name === 'AskUserQuestion') {
    await postHook(sala, { hook_event_name: 'Notification', session_id: sid, cwd: hook.cwd,
      notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  }
}

// Ao subir a sala: agentes que ficaram salvos saem; voltam quando a sessão tiver atividade.
async function recriarAgentes(sala) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(sala.home, '.pixel-agents', 'standalone-state.json'), 'utf8'));
    for (const a of st.agents || []) {
      if (!a.isExternal || typeof a.projectDir !== 'string' || !a.projectDir.startsWith('/sessao/')) continue;
      if (sala.sessions.has(a.sessionId)) continue;
      await postHook(sala, { session_id: a.sessionId, cwd: a.projectDir, hook_event_name: 'SessionEnd', reason: 'other' });
    }
  } catch {}
}

setInterval(() => {
  const now = Date.now();
  for (const sala of rodando.values()) {
    for (const [sid, s] of sala.sessions) {
      const parado = now - s.last;
      if (!s.esperando && parado > AUSENTE_MS && (!s.ferramenta || parado > FERRAMENTA_MAX_MS)) {
        sala.sessions.delete(sid);
        postHook(sala, { hook_event_name: 'SessionEnd', session_id: sid, cwd: s.cwd, reason: 'other' });
        continue;
      }
      if (s.turnOpen && parado > IDLE_MS && !s.ferramenta) {
        s.turnOpen = false;
        postHook(sala, { hook_event_name: 'Stop', session_id: sid, cwd: s.cwd, stop_hook_active: false });
      }
    }
  }
}, 5000);

// Fila por sala para manter a ordem dos eventos.
const filas = new Map();
function enfileirar(sala, hooks) {
  const anterior = filas.get(sala.nome) || Promise.resolve();
  const p = anterior.then(async () => { for (const h of hooks) await entregar(sala, h); }).catch(() => {});
  filas.set(sala.nome, p);
}

// ── Pacotes para o cliente ──────────────────────────────────────────────
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'SubagentStart', 'SubagentStop'];
const COM_MATCHER = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);

function hooksJson(cmd) {
  const hooks = {};
  for (const ev of HOOK_EVENTS) {
    const e = { hooks: [{ type: 'command', command: cmd, timeout: 5 }] };
    hooks[ev] = [COM_MATCHER.has(ev) ? { matcher: '*', ...e } : e];
  }
  return { hooks };
}

const lerCliente = (f) => fs.readFileSync(path.join(CLIENTE, f));

let crcTab;
function crc32(buf) {
  if (!crcTab) { crcTab = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTab[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (const b of buf) c = crcTab[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ZIP sem compressão (suficiente para um plugin de poucos KB).
function zip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, data] of files) {
    const nb = Buffer.from(name); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nb, data); centrals.push(ch, nb);
    offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function pluginZip(nome, chave, url) {
  const manifest = { name: 'escritorio-adaptus', version: '1.0.0',
    description: 'Mostra suas sessões do Claude no Escritório Adaptus.', author: { name: 'Adaptus Tecnologia' } };
  const readme = `# Escritório Adaptus\n\nMostra cada sessão do Claude como um agente no seu escritório: ${url}/o/${chave}\n\nSó envia o nome da ferramenta e o arquivo/comando/busca (até 160 caracteres). Nunca o texto das mensagens nem o conteúdo dos arquivos.\n`;
  return zip([
    ['.claude-plugin/plugin.json', Buffer.from(JSON.stringify(manifest, null, 2))],
    ['hooks/hooks.json', Buffer.from(JSON.stringify(hooksJson('node "${CLAUDE_PLUGIN_ROOT}/scripts/emit.js"'), null, 2))],
    ['scripts/emit.js', lerCliente('emit.js')],
    ['scripts/sender.js', lerCliente('sender.js')],
    ['scripts/tail-transcript.js', lerCliente('tail-transcript.js')],
    ['config.json', Buffer.from(JSON.stringify({ url, chave, sala: nome }))],
    ['README.md', Buffer.from(readme)],
  ]);
}

function setupSh(chave, url) {
  return `#!/bin/bash
# Escritório Adaptus — instala no Claude Code (macOS/Linux/Git Bash). Rode uma vez.
set -e
command -v node >/dev/null 2>&1 || { echo "Precisa do Node.js 18+ instalado."; exit 1; }
D="$HOME/.escritorio-adaptus"; mkdir -p "$D/scripts"
for f in emit.js sender.js tail-transcript.js instalar-hooks.js; do curl -fsSL "${url}/cliente/$f" -o "$D/scripts/$f"; done
printf '%s' '${JSON.stringify({ url, chave })}' > "$D/config.json"
node "$D/scripts/instalar-hooks.js"
echo "Pronto. Abra ${url}/o/${chave} e inicie uma sessão nova do Claude Code."
`;
}

function setupPs1(chave, url) {
  return `# Escritório Adaptus — instala no Claude Code (Windows). Rode uma vez no PowerShell.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Precisa do Node.js 18+ instalado.'; exit 1 }
$D = Join-Path $env:USERPROFILE '.escritorio-adaptus'
New-Item -ItemType Directory -Force (Join-Path $D 'scripts') | Out-Null
foreach ($f in 'emit.js','sender.js','tail-transcript.js','instalar-hooks.js') { Invoke-WebRequest -UseBasicParsing "${url}/cliente/$f" -OutFile (Join-Path $D "scripts\\$f") }
[IO.File]::WriteAllText((Join-Path $D 'config.json'), '${JSON.stringify({ url, chave })}')
node (Join-Path $D 'scripts\\instalar-hooks.js')
Write-Host "Pronto. Abra ${url}/o/${chave} e inicie uma sessão nova do Claude Code."
`;
}

function sessaoSh(chave, url) {
  return `#!/bin/bash
# Escritório Adaptus — liga uma sessão do Cowork JÁ ABERTA (sem o plugin).
set -e
D=/tmp/escritorio-adaptus-plugin; mkdir -p "$D/scripts"
for f in emit.js sender.js tail-transcript.js; do curl -fsSL "${url}/cliente/$f" -o "$D/scripts/$f"; done
printf '%s' '${JSON.stringify({ url, chave })}' > "$D/config.json"
T=$(ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null | head -1)
[ -n "$T" ] || { echo "transcript não encontrado"; exit 1; }
if pgrep -f "tail-transcript.js $T" >/dev/null; then echo "já ligado: $(basename "$T" .jsonl)"; exit 0; fi
setsid nohup node "$D/scripts/tail-transcript.js" "$T" >/dev/null 2>&1 < /dev/null &
echo "ligado ao Escritório Adaptus: $(basename "$T" .jsonl)"
`;
}

// ── Páginas ─────────────────────────────────────────────────────────────
function paginaEntrada(erro) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Escritório Adaptus</title><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 70% -10%,#16204a 0%,#070a12 60%);color:#e6ebf5;font-family:Manrope,system-ui,sans-serif;padding:16px}
.c{width:100%;max-width:380px;background:rgba(10,14,26,.8);border:1px solid rgba(148,163,184,.18);border-radius:18px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
.l{display:flex;gap:12px;align-items:center;margin-bottom:18px}.l b{font-size:20px;font-weight:800}p{color:#8b95ab;font-size:14px;margin:0 0 18px}
input{width:100%;padding:12px 14px;border-radius:12px;border:1px solid rgba(148,163,184,.25);background:#0b1020;color:#e6ebf5;font:600 14px Manrope,sans-serif;margin-bottom:12px}
button{width:100%;padding:12px;border:0;border-radius:12px;background:linear-gradient(135deg,#22d3ee,#8b5cf6);color:#06101f;font:800 15px Manrope,sans-serif;cursor:pointer}.e{color:#f59e0b;font-size:13px;margin-bottom:12px}</style></head>
<body><form class="c" onsubmit="event.preventDefault();location.href='/o/'+encodeURIComponent(this.k.value.trim())">
<div class="l"><svg viewBox="0 0 120 120" width="36" height="36"><rect width="120" height="120" rx="26" fill="#0F1628"/><path d="M60 22 98 102H80L60 60 40 102H22Z" fill="#EEF2F8"/><circle cx="60" cy="84" r="10" fill="#070A12"/><circle cx="60" cy="84" r="6" fill="#22D3EE"/></svg><b>Escritório Adaptus</b></div>
<p>Cole a chave da sua sala para ver seus agentes trabalhando.</p>${erro ? `<div class="e">${erro}</div>` : ''}
<input name="k" placeholder="Chave da sala" autocomplete="off" required><button>Entrar</button></form></body></html>`;
}


// ── Escritórios conectados (amizades) ──────────────────────────────────
// salas[nome].amigos = [nomes]  (mútuo)   salas[nome].pedidos = [nomes que pediram]
const COOKIE_VISITA = 'ea_visita';
const garantir = (n) => { const s = salas[n]; s.amigos = s.amigos || []; s.pedidos = s.pedidos || []; return s; };
const saoAmigos = (a, b) => !!(salas[a] && salas[b] && garantir(a).amigos.includes(b));
function visitaDe(req, nome) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE_VISITA}=([^;]+)`));
  const alvo = m ? decodeURIComponent(m[1]) : null;
  return alvo && alvo !== nome && saoAmigos(nome, alvo) ? alvo : null;
}
function estadoSocial(nome, req) {
  const eu = garantir(nome);
  const enviados = Object.keys(salas).filter((n) => n !== nome && garantir(n).pedidos.includes(nome));
  const agentes = (n) => { const r = rodando.get(n); return r ? r.sessions.size : 0; };
  return { eu: nome, visitando: visitaDe(req, nome),
    amigos: eu.amigos.filter((n) => salas[n]).map((n) => ({ nome: n, sessoes: agentes(n) })),
    recebidos: eu.pedidos.filter((n) => salas[n]), enviados };
}
async function rotaSocial(req, res, p, nome) {
  if (req.method === 'GET' && p === '/api/social') return enviar(res, 200, JSON.stringify(estadoSocial(nome, req)), 'application/json');
  if (req.method !== 'POST') return enviar(res, 405, '{}', 'application/json');
  let body = {}; try { body = JSON.parse(await lerCorpo(req, 4096)); } catch {}
  const alvo = String(body.nome || '').toLowerCase().trim();
  const eu = garantir(nome);
  if (p === '/api/social/pedir') {
    if (!salas[alvo] || alvo === nome) return enviar(res, 404, JSON.stringify({ erro: 'Escritório não encontrado.' }), 'application/json');
    const ele = garantir(alvo);
    if (eu.pedidos.includes(alvo)) { // ele já tinha pedido: vira amizade
      eu.pedidos = eu.pedidos.filter((n) => n !== alvo);
      if (!eu.amigos.includes(alvo)) eu.amigos.push(alvo);
      if (!ele.amigos.includes(nome)) ele.amigos.push(nome);
    } else if (!eu.amigos.includes(alvo) && !ele.pedidos.includes(nome)) ele.pedidos.push(nome);
  } else if (p === '/api/social/responder') {
    if (!eu.pedidos.includes(alvo)) return enviar(res, 404, JSON.stringify({ erro: 'Pedido não encontrado.' }), 'application/json');
    eu.pedidos = eu.pedidos.filter((n) => n !== alvo);
    if (body.aceitar && salas[alvo]) {
      const ele = garantir(alvo);
      if (!eu.amigos.includes(alvo)) eu.amigos.push(alvo);
      if (!ele.amigos.includes(nome)) ele.amigos.push(nome);
    }
  } else if (p === '/api/social/remover') {
    eu.amigos = eu.amigos.filter((n) => n !== alvo);
    if (salas[alvo]) garantir(alvo).amigos = garantir(alvo).amigos.filter((n) => n !== nome);
  } else if (p === '/api/social/visitar') {
    if (!saoAmigos(nome, alvo)) return enviar(res, 403, JSON.stringify({ erro: 'Vocês ainda não estão conectados.' }), 'application/json');
    iniciarSala(alvo);
    return enviar(res, 200, '{"ok":true}', 'application/json', { 'set-cookie': `${COOKIE_VISITA}=${encodeURIComponent(alvo)}; Path=/; HttpOnly; Secure; SameSite=Lax` });
  } else if (p === '/api/social/voltar') {
    return enviar(res, 200, '{"ok":true}', 'application/json', { 'set-cookie': `${COOKIE_VISITA}=; Path=/; Max-Age=0` });
  } else return enviar(res, 404, '{}', 'application/json');
  salvarSalas();
  return enviar(res, 200, JSON.stringify(estadoSocial(nome, req)), 'application/json');
}

// Visitante só assiste: do navegador para o servidor da sala visitada passam apenas
// mensagens de leitura. Lê os quadros WebSocket (mascarados) do cliente.
const LIBERADO_VISITANTE = new Set(['webviewReady', 'requestDiagnostics']);
function filtrarVisitante(cliente, up) {
  let buf = Buffer.alloc(0);
  cliente.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) break;
      const b0 = buf[0], b1 = buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = (b1 & 0x80) !== 0;
      const dados = off + (masked ? 4 : 0);
      if (buf.length < dados + len) break;
      const frame = buf.subarray(0, dados + len);
      let ok = true;
      if ((b0 & 0x0f) === 1) {
        const payload = Buffer.from(buf.subarray(dados, dados + len));
        if (masked) { const k = buf.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= k[i & 3]; }
        try { ok = LIBERADO_VISITANTE.has(JSON.parse(payload.toString('utf8')).type); } catch { ok = false; }
      }
      if (ok) up.write(frame);
      buf = buf.subarray(dados + len);
    }
  });
}

// ── HTTP ────────────────────────────────────────────────────────────────
function cookieSala(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? porChave(decodeURIComponent(m[1])) : null;
}
function urlPublica(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
function enviar(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}
function lerCorpo(req, max = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const admin = (req) => ADMIN.length >= 24 && (req.headers.authorization || '') === `Bearer ${ADMIN}`;

function proxy(req, res, sala) {
  const up = http.request({ host: '127.0.0.1', port: sala.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) enviar(res, 502, 'Sala iniciando, recarregue em alguns segundos.'); else res.end(); });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/health') return enviar(res, 200, JSON.stringify({ ok: true, salas: Object.keys(salas).length }), 'application/json');

    if (req.method === 'POST' && p === '/in') {
      const chave = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
      const nome = porChave(chave);
      if (!nome) return enviar(res, 401, '{"error":"unauthorized"}', 'application/json');
      let body; try { body = JSON.parse(await lerCorpo(req)); } catch { return enviar(res, 400, '{"error":"json"}', 'application/json'); }
      const hooks = (Array.isArray(body) ? body : [body]).slice(0, 100).map((e) => limpar(e && e.hook)).filter(Boolean);
      const sala = iniciarSala(nome);
      enfileirar(sala, hooks);
      return enviar(res, 200, JSON.stringify({ ok: true, recebidos: hooks.length }), 'application/json');
    }

    if (p.startsWith('/cliente/')) {
      const f = path.basename(p);
      if (!/^[\w-]+\.js$/.test(f) || !fs.existsSync(path.join(CLIENTE, f))) return enviar(res, 404, 'não encontrado');
      return enviar(res, 200, lerCliente(f), 'application/javascript; charset=utf-8');
    }

    let m;
    if ((m = p.match(/^\/o\/([^/]+)\/?$/))) {
      const chave = decodeURIComponent(m[1]);
      if (!porChave(chave)) return enviar(res, 401, paginaEntrada('Chave não encontrada.'), 'text/html; charset=utf-8');
      iniciarSala(porChave(chave));
      return enviar(res, 302, '', 'text/plain', { location: '/', 'set-cookie': `${COOKIE}=${encodeURIComponent(chave)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` });
    }
    if (p === '/sair') return enviar(res, 302, '', 'text/plain', { location: '/', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });

    if ((m = p.match(/^\/plugin\/([^/]+)\/escritorio-adaptus\.plugin$/))) {
      const chave = decodeURIComponent(m[1]); const nome = porChave(chave);
      if (!nome) return enviar(res, 401, 'chave inválida');
      return enviar(res, 200, pluginZip(nome, chave, urlPublica(req)), 'application/zip',
        { 'content-disposition': 'attachment; filename="escritorio-adaptus.plugin"' });
    }
    if ((m = p.match(/^\/instalar\/([^/]+)\/(claude-code\.sh|claude-code\.ps1|sessao\.sh)$/))) {
      const chave = decodeURIComponent(m[1]);
      if (!porChave(chave)) return enviar(res, 401, 'echo "chave inválida"; exit 1');
      const u = urlPublica(req);
      const body = m[2] === 'claude-code.sh' ? setupSh(chave, u) : m[2] === 'claude-code.ps1' ? setupPs1(chave, u) : sessaoSh(chave, u);
      return enviar(res, 200, body);
    }

    if (p === '/admin/salas') {
      if (!admin(req)) return enviar(res, 401, '{"error":"unauthorized"}', 'application/json');
      if (req.method === 'POST') {
        let body = {}; try { body = JSON.parse(await lerCorpo(req)); } catch {}
        const nome = String(body.nome || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
        if (!nome) return enviar(res, 400, '{"error":"nome"}', 'application/json');
        if (!salas[nome]) { salas[nome] = { chave: crypto.randomBytes(24).toString('base64url'), criada: new Date().toISOString() }; salvarSalas(); }
        const u = urlPublica(req); const c = salas[nome].chave;
        return enviar(res, 200, JSON.stringify({ nome, chave: c, escritorio: `${u}/o/${c}`,
          plugin_cowork: `${u}/plugin/${c}/escritorio-adaptus.plugin`,
          claude_code_mac_linux: `curl -fsSL ${u}/instalar/${c}/claude-code.sh | bash`,
          claude_code_windows: `irm ${u}/instalar/${c}/claude-code.ps1 | iex`,
          sessao_aberta: `curl -fsSL ${u}/instalar/${c}/sessao.sh | bash` }, null, 2), 'application/json');
      }
      if (req.method === 'DELETE') {
        const nome = url.searchParams.get('nome');
        if (salas[nome]) { delete salas[nome]; salvarSalas(); }
        return enviar(res, 200, '{"ok":true}', 'application/json');
      }
      return enviar(res, 200, JSON.stringify(Object.keys(salas)), 'application/json');
    }

    const nome = cookieSala(req);
    if (!nome) {
      if (p === '/' || p === '/index.html') return enviar(res, 200, paginaEntrada(), 'text/html; charset=utf-8');
      return enviar(res, 401, 'entre pela página inicial');
    }
    if (p === '/api/social' || p.startsWith('/api/social/')) return rotaSocial(req, res, p, nome);
    const visita = visitaDe(req, nome);
    if (visita && req.method !== 'GET' && req.method !== 'HEAD') return enviar(res, 403, 'somente leitura');
    const sala = iniciarSala(visita || nome);
    if (!sala.token) await sala.pronto;
    return proxy(req, res, sala);
  } catch (e) {
    console.error('erro', e);
    if (!res.headersSent) enviar(res, 500, 'erro');
  }
});

// WebSocket (/ws) da sala do cookie.
server.on('upgrade', async (req, socket, head) => {
  const nome = cookieSala(req);
  if (!nome) { socket.destroy(); return; }
  const visita = visitaDe(req, nome);
  const sala = iniciarSala(visita || nome);
  if (!sala.token) await sala.pronto;
  const up = net.connect(sala.port, '127.0.0.1', () => {
    const linhas = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) linhas.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(linhas.join('\r\n') + '\r\n\r\n');
    up.pipe(socket);
    if (visita) { if (head && head.length) socket.unshift(head); filtrarVisitante(socket, up); }
    else { if (head && head.length) up.write(head); socket.pipe(up); }
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, () => {
  console.log(`Escritório Adaptus na porta ${PORT}; ${Object.keys(salas).length} sala(s)`);
  for (const nome of Object.keys(salas)) iniciarSala(nome);
});
