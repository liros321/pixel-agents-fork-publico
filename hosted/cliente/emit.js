#!/usr/bin/env node
// Adaptus Agentes — hook do Claude (Cowork ou Claude Code) -> fila local.
// Nunca bloqueia nem falha: grava 1 linha e, se o enviador não estiver rodando,
// sobe um em segundo plano. Privacidade: só nome da ferramenta e
// file_path/pattern/command/query/url/description (160 chars). Nunca prompt nem conteúdo.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const Q = process.env.ESCRITORIO_FILA || path.join(os.tmpdir(), 'adaptus-agentes');
const SAFE_INPUT = ['file_path', 'pattern', 'path', 'command', 'query', 'url', 'description', 'subagent_type'];
const SAFE_KEYS = ['tool_name', 'notification_type', 'source', 'agent_id', 'agent_type', 'reason'];

const s = (v, n = 160) => (typeof v === 'string' && v ? v.split('\n')[0].slice(0, n) : undefined);

function sanitizeHook(p, sid, label) {
  if (!p || typeof p.hook_event_name !== 'string') return null;
  if (p.hook_event_name === 'UserPromptSubmit') return null; // nunca envia o texto do prompt
  const out = { hook_event_name: p.hook_event_name, session_id: sid, cwd: '/sessao/' + label };
  for (const k of SAFE_KEYS) if (p[k] !== undefined) out[k] = typeof p[k] === 'string' ? s(p[k], 80) : p[k];
  if (typeof p.stop_hook_active === 'boolean') out.stop_hook_active = p.stop_hook_active;
  if (p.hook_event_name === 'Notification' || p.hook_event_name === 'PermissionRequest') out.message = s(p.message);
  if (p.tool_input && typeof p.tool_input === 'object') {
    const ti = {};
    for (const k of SAFE_INPUT) if (typeof p.tool_input[k] === 'string') ti[k] = s(p.tool_input[k]);
    out.tool_input = ti;
  }
  return out;
}

// Nome do agente = título da sessão (custom-title, senão ai-title) lido do fim do
// transcript; sem título, o nome da pasta. Cache de 60 s por sessão.
function titleFor(transcriptPath, sid) {
  const cache = path.join(Q, 'titulo-' + String(sid).replace(/[^\w-]/g, ''));
  try { const st = fs.statSync(cache); if (Date.now() - st.mtimeMs < 60000) return fs.readFileSync(cache, 'utf8') || null; } catch {}
  let title = null;
  try {
    const size = fs.statSync(transcriptPath).size;
    const len = Math.min(size, 512 * 1024);
    const fd = fs.openSync(transcriptPath, 'r'); const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    let custom = null, ai = null;
    for (const l of buf.toString('utf8').split('\n')) {
      if (l.includes('"custom-title"')) { try { custom = JSON.parse(l).customTitle || custom; } catch {} }
      else if (l.includes('"ai-title"')) { try { ai = JSON.parse(l).aiTitle || ai; } catch {} }
    }
    title = custom || ai;
  } catch {}
  try { fs.mkdirSync(Q, { recursive: true }); fs.writeFileSync(cache, title || ''); } catch {}
  return title;
}

function clean(name) {
  return String(name || '').replace(/[\\/:*?"<>|\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 32);
}

function labelFor(transcriptPath, sid, cwd) {
  const t = transcriptPath && titleFor(transcriptPath, sid);
  return clean(t) || clean(cwd && path.basename(cwd)) || 'Sessão ' + String(sid).slice(0, 6);
}

function enqueue(hook) {
  fs.mkdirSync(Q, { recursive: true });
  fs.appendFileSync(path.join(Q, 'fila.jsonl'), JSON.stringify({ ts: new Date().toISOString(), hook }) + '\n');
  let alive = false;
  try { process.kill(Number(fs.readFileSync(path.join(Q, 'enviador.pid'), 'utf8')), 0); alive = true; } catch {}
  if (!alive) {
    spawn(process.execPath, [path.join(__dirname, 'sender.js')], {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ESCRITORIO_FILA: Q },
    }).unref();
  }
}
module.exports = { sanitizeHook, enqueue, labelFor };

if (require.main === module) {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const p = raw.trim() && JSON.parse(raw);
    const sid = p && typeof p.session_id === 'string' ? p.session_id : 'unknown';
    const hook = p && sanitizeHook(p, sid, labelFor(p.transcript_path, sid, p.cwd));
    if (hook) enqueue(hook);
  } catch { /* silencioso por design */ }
}
