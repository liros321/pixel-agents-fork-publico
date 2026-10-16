#!/usr/bin/env node
// Escritório Adaptus — para uma sessão já aberta (sem hooks): lê o transcript e gera
// os mesmos eventos na fila. Uso: node tail-transcript.js <arquivo.jsonl>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeHook, enqueue, labelFor } = require('./emit.js');

const file = process.argv[2];
const sid = path.basename(file, '.jsonl');
let cwd = '';
const send = (p) => { const h = sanitizeHook({ session_id: sid, ...p }, sid, labelFor(file, sid, cwd)); if (h) enqueue(h); };
const names = new Map();

function handle(line) {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (typeof o.cwd === 'string') cwd = o.cwd;
  const m = o.message;
  if (!m || o.isSidechain) return;
  const content = Array.isArray(m.content) ? m.content : [];
  if (o.type === 'user') {
    for (const r of content.filter((c) => c.type === 'tool_result')) {
      send({ hook_event_name: 'PostToolUse', tool_name: names.get(r.tool_use_id) || 'unknown', tool_input: {} });
    }
  } else if (o.type === 'assistant') {
    for (const c of content) if (c.type === 'tool_use') {
      names.set(c.id, c.name);
      send({ hook_event_name: 'PreToolUse', tool_name: c.name, tool_input: c.input || {} });
    }
    if (m.stop_reason === 'end_turn') send({ hook_event_name: 'Stop' });
  }
}

send({ hook_event_name: 'SessionStart', source: 'resume' });
let pos = fs.statSync(file).size, rest = '';
setInterval(() => {
  let size; try { size = fs.statSync(file).size; } catch { return; }
  if (size <= pos) return;
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size - pos);
  fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd); pos = size;
  const parts = (rest + buf.toString('utf8')).split('\n'); rest = parts.pop();
  for (const l of parts) if (l.trim()) handle(l);
}, 500);
