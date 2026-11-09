#!/usr/bin/env node
// bivouac task supervisor (PID 1 of a task container, run under tini via `docker run --init`).
// Waits for /workspace/.bivouac/dev.json, runs the dev command, restarts it when it crashes
// or when dev.json changes, and writes logs to /workspace/.bivouac/dev.log.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdirSync, createWriteStream } from 'node:fs';

const DIR = process.env.BIVOUAC_STATE_DIR || '/workspace/.bivouac';
const CONF = `${DIR}/dev.json`;
const LOG = `${DIR}/dev.log`;
mkdirSync(DIR, { recursive: true });
const log = createWriteStream(LOG, { flags: 'a' });
// Every line gets its time (HH:MM:SS.mmm, UTC) so the dashboard can show it; the agent reads the same file.
const stamp = () => new Date().toISOString().slice(11, 23);
const say = (m) => log.write(`${stamp()} [supervisor] ${m}\n`);
/** Splits a stream into lines and writes each with its time; a partial line is flushed after a short pause. */
function stampLines(stream) {
  let rest = '', timer = null;
  const flush = () => { timer = null; if (rest) { log.write(`${stamp()} ${rest}\n`); rest = ''; } };
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop();
    for (const l of parts) log.write(`${stamp()} ${l.replace(/\r$/, '')}\n`);
    clearTimeout(timer);
    if (rest) timer = setTimeout(flush, 300);
  });
  stream.on('end', () => { clearTimeout(timer); flush(); });
}

let child = null;
let stopping = false;
let lastMtime = 0;
let conf = null;
let backoff = 1000;
let restartTimer = null;

function start() {
  if (!conf || child || stopping) return;
  say(`starting: ${conf.command} (cwd ${conf.cwd})`);
  child = spawn('bash', ['-lc', conf.command], { cwd: conf.cwd, env: { ...process.env, PORT: String(conf.port), HOST: '0.0.0.0' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const startedAt = Date.now();
  stampLines(child.stdout);
  stampLines(child.stderr);
  child.on('exit', (code, sig) => {
    child = null;
    say(`dev server exited (code=${code} signal=${sig})`);
    if (stopping) return;
    backoff = Date.now() - startedAt > 30000 ? 1000 : Math.min(backoff * 2, 15000);
    say(`restarting in ${backoff}ms`);
    restartTimer = setTimeout(start, backoff);
  });
}

function killChild() {
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const c = child;
    const t = setTimeout(() => { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000);
    c.once('exit', () => { clearTimeout(t); resolve(); });
    try { process.kill(-c.pid, 'SIGTERM'); } catch { resolve(); }
  });
}

setInterval(async () => {
  if (stopping || !existsSync(CONF)) return;
  const m = statSync(CONF).mtimeMs;
  if (m === lastMtime) return;
  lastMtime = m;
  try {
    conf = JSON.parse(readFileSync(CONF, 'utf8'));
  } catch (e) { say(`bad dev.json: ${e.message}`); return; }
  clearTimeout(restartTimer);
  await killChild();
  backoff = 1000;
  start();
}, 1000);

for (const s of ['SIGTERM', 'SIGINT']) {
  process.on(s, async () => { stopping = true; clearTimeout(restartTimer); await killChild(); process.exit(0); });
}
say('supervisor ready');
