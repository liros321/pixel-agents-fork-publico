#!/usr/bin/env node
// Adaptus Agentes — lê a fila local e envia em lotes para a sala da pessoa.
// Um por máquina/container (pid file). Sai sozinho após 15 min sem eventos.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Q = process.env.ESCRITORIO_FILA || path.join(os.tmpdir(), 'adaptus-agentes');
const QF = path.join(Q, 'fila.jsonl');
const OFF = path.join(Q, 'posicao');
const PID = path.join(Q, 'enviador.pid');
const IDLE_MS = 15 * 60 * 1000;

function loadCfg() {
  const places = [path.join(__dirname, '..', 'config.json'), path.join(os.homedir(), '.adaptus-agentes', 'config.json')];
  for (const p of places) {
    try { const c = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); if (c.url && c.chave) return c; } catch {}
  }
  return null;
}
const cfg = loadCfg();
if (!cfg) process.exit(0);

try { const old = Number(fs.readFileSync(PID, 'utf8')); if (old && old !== process.pid) { process.kill(old, 0); process.exit(0); } } catch {}
fs.mkdirSync(Q, { recursive: true });
fs.writeFileSync(PID, String(process.pid));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let offset = 0;
try { offset = Number(fs.readFileSync(OFF, 'utf8')) || 0; } catch {}
let last = Date.now();

async function post(events) {
  const r = await fetch(cfg.url.replace(/\/$/, '') + '/in', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.chave },
    body: JSON.stringify(events), signal: AbortSignal.timeout(8000),
  });
  if (!r.ok && r.status !== 400) throw new Error('escritorio ' + r.status);
}

(async () => {
  for (;;) {
    let size = 0;
    try { size = fs.statSync(QF).size; } catch {}
    if (size < offset) offset = 0;
    if (size > offset) {
      const fd = fs.openSync(QF, 'r');
      const buf = Buffer.alloc(Math.min(size - offset, 48 * 1024));
      fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd);
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end >= 0) {
        const events = [];
        for (const l of text.slice(0, end).split('\n')) { if (l) { try { events.push(JSON.parse(l)); } catch {} } }
        try {
          for (let i = 0; i < events.length; i += 50) await post(events.slice(i, i + 50));
          offset += Buffer.byteLength(text.slice(0, end + 1));
          fs.writeFileSync(OFF, String(offset));
          last = Date.now();
        } catch { await sleep(3000); }
      }
    }
    if (Date.now() - last > IDLE_MS) break;
    await sleep(400);
  }
  try { if (Number(fs.readFileSync(PID, 'utf8')) === process.pid) fs.unlinkSync(PID); } catch {}
})();
