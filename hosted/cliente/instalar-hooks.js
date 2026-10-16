// Escritório Adaptus — adiciona (ou atualiza) os hooks em ~/.claude/settings.json.
// Mantém tudo o que já existe; um backup é salvo ao lado.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const file = path.join(os.homedir(), '.claude', 'settings.json');
const emit = path.join(os.homedir(), '.escritorio-adaptus', 'scripts', 'emit.js').replace(/\\/g, '/');
const cmd = `node "${emit}"`;
const EVENTS = ['SessionStart', 'SessionEnd', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'SubagentStart', 'SubagentStop'];
const MATCH = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);

let s = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file + '.bak-escritorio-' + Date.now(), raw);
  s = JSON.parse(raw.replace(/^﻿/, '') || '{}');
}
s.hooks = s.hooks || {};
for (const ev of EVENTS) {
  const list = (s.hooks[ev] || []).map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !String(h.command || '').includes('.escritorio-adaptus/scripts/emit.js')) }))
    .filter((m) => m.hooks.length);
  const entry = { hooks: [{ type: 'command', command: cmd, timeout: 5 }] };
  list.push(MATCH.has(ev) ? { matcher: '*', ...entry } : entry);
  s.hooks[ev] = list;
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log('Hooks do Escritório Adaptus instalados em ' + file);
