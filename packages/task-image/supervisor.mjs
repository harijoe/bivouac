#!/usr/bin/env node
// bivouac task supervisor (PID 1 of a task container, run under tini via `docker run --init`).
// Waits for /workspace/.bivouac/dev.json, runs the dev command, restarts it when it crashes
// or when dev.json changes, and writes logs to /workspace/.bivouac/dev.log.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdirSync, createWriteStream, writeFileSync, renameSync } from 'node:fs';
import { get as httpGet } from 'node:http';

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

// ---- health: the supervisor starts the dev server, probes it, restarts it when it dies or stops answering (with a growing
// delay and a limit) and reports its state in health.json, which the daemon reads (see PreviewWatch).
const HEALTH = `${DIR}/health.json`;
const RESTART_REQ = `${DIR}/restart.req`;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const PROBE_MS = num(process.env.BIVOUAC_HEALTH_INTERVAL_MS, 5000);
const BACKOFF = [1, 2, 4, 8, 15, 30, 60, 60].map((x) => x * num(process.env.BIVOUAC_BACKOFF_UNIT_MS, 1000));
const MAX_RESTARTS = BACKOFF.length; // consecutive restarts without a healthy period, then it stays down
const STARTUP_MS = num(process.env.BIVOUAC_STARTUP_MS, 240_000); // time a new process gets to answer for the first time
const HUNG_PROBES = 6; // consecutive failed probes of a server that was healthy before it is killed
const STABLE_MS = num(process.env.BIVOUAC_STABLE_MS, 60_000); // healthy for this long: the restart counter is forgotten

let child = null;
let stopping = false;
let lastMtime = 0;
let lastReq = 0;
let conf = null;
let restartTimer = null;
const h = { state: 'unknown', since: new Date().toISOString(), lastHealthyAt: null, restarts: 0, cause: null, nextRetryAt: null };
let startedAt = 0, everHealthy = false, failedProbes = 0, healthySince = 0, recent = [];

function publish() {
  try {
    const tmp = `${HEALTH}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...h, updatedAt: new Date().toISOString(), pid: child?.pid ?? null }));
    renameSync(tmp, HEALTH);
  } catch { /* the state directory may be gone while the container stops */ }
}
function setState(state, patch = {}) {
  if (h.state !== state) h.since = new Date().toISOString();
  h.state = state;
  Object.assign(h, patch);
  publish();
}
const noteLine = (l) => { if (l.trim()) { recent.push(l.trim().slice(0, 300)); if (recent.length > 6) recent.shift(); } };

/** One HTTP request to the dev server on the loopback of the container. Healthy = it answered (below 500 when a path was configured). */
function probe() {
  return new Promise((resolve) => {
    if (!conf?.health) return resolve(false);
    const req = httpGet({ host: '127.0.0.1', port: conf.health.port, path: conf.health.path, timeout: 3000, headers: { host: `localhost:${conf.health.port}`, accept: '*/*' } }, (res) => {
      res.resume();
      resolve(conf.health.strict ? res.statusCode < 500 : true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function start() {
  if (!conf || child || stopping) return;
  say(`starting: ${conf.command} (cwd ${conf.cwd})`);
  recent = [];
  child = spawn('bash', ['-lc', conf.command], { cwd: conf.cwd, env: { ...process.env, PORT: String(conf.port), HOST: '0.0.0.0' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  startedAt = Date.now(); everHealthy = false; failedProbes = 0; healthySince = 0;
  h.nextRetryAt = null;
  setState(h.restarts ? 'unhealthy' : 'starting');
  const mine = child;
  for (const st of [child.stdout, child.stderr]) { stampLines(st); st.on('data', (c) => String(c).split('\n').forEach(noteLine)); }
  child.on('exit', (code, sig) => {
    if (child === mine) child = null;
    const how = `exited (code ${code ?? 'none'}${sig ? `, signal ${sig}` : ''})`;
    say(`dev server ${how}`);
    if (stopping || mine.bvKilledForRestart) return;
    scheduleRestart(`the dev server ${how}${recent.length ? `; last output: ${recent.slice(-3).join(' | ')}` : ''}`);
  });
}

/** The dev server is gone or useless: wait a growing delay, start it again, give up after MAX_RESTARTS in a row. */
function scheduleRestart(cause) {
  clearTimeout(restartTimer);
  if (Date.now() - healthySince >= STABLE_MS && healthySince) h.restarts = 0;
  if (h.restarts >= MAX_RESTARTS) {
    say(`giving up after ${h.restarts} restarts: ${cause}`);
    setState('down', { cause, nextRetryAt: null });
    return;
  }
  const wait = BACKOFF[Math.min(h.restarts, BACKOFF.length - 1)];
  h.restarts += 1;
  say(`restarting in ${wait}ms (restart ${h.restarts} of ${MAX_RESTARTS})`);
  setState('unhealthy', { cause, nextRetryAt: new Date(Date.now() + wait).toISOString() });
  restartTimer = setTimeout(() => { restartTimer = null; start(); }, wait);
}

function killChild() {
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const c = child;
    c.bvKilledForRestart = true;
    const t = setTimeout(() => { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000);
    c.once('exit', () => { clearTimeout(t); resolve(); });
    try { process.kill(-c.pid, 'SIGTERM'); } catch { resolve(); }
  });
}

async function restartNow(why) {
  clearTimeout(restartTimer); restartTimer = null;
  await killChild();
  child = null;
  h.restarts = 0; h.cause = why ?? null;
  start();
}

setInterval(async () => {
  if (stopping || !existsSync(CONF)) return;
  const m = statSync(CONF).mtimeMs;
  if (m !== lastMtime) {
    lastMtime = m;
    try {
      conf = JSON.parse(readFileSync(CONF, 'utf8'));
      conf.health = { port: conf.healthPort ?? conf.port, path: conf.healthPath ?? '/', strict: !!conf.healthPath && conf.healthPath !== '/' };
    } catch (e) { say(`bad dev.json: ${e.message}`); return; }
    await restartNow(null);
    return;
  }
  // restart requested from the dashboard or by the agent (touch .bivouac/restart.req)
  if (existsSync(RESTART_REQ)) {
    const r = statSync(RESTART_REQ).mtimeMs;
    if (r !== lastReq) { if (lastReq) { say('restart requested'); await restartNow('restarted on request'); } lastReq = r; }
  }
}, 1000);

setInterval(async () => {
  if (stopping || !conf || !child) return;
  const ok = await probe();
  if (!child) return;
  if (ok) {
    failedProbes = 0;
    if (!everHealthy || h.state !== 'healthy') {
      everHealthy = true; healthySince = Date.now();
      setState('healthy', { lastHealthyAt: new Date().toISOString(), cause: h.state === 'unhealthy' || h.restarts ? h.cause : null });
    } else if (h.restarts && Date.now() - healthySince >= STABLE_MS) { h.restarts = 0; setState('healthy', { lastHealthyAt: new Date().toISOString() }); }
    else h.lastHealthyAt = new Date().toISOString();
    return;
  }
  failedProbes += 1;
  const neverAnswered = !everHealthy && Date.now() - startedAt > STARTUP_MS;
  const hung = everHealthy && failedProbes >= HUNG_PROBES;
  if (neverAnswered || hung) {
    const cause = neverAnswered ? `the dev server did not answer on port ${conf.health.port} within ${Math.round(STARTUP_MS / 1000)} s of starting` : `the dev server stopped answering on port ${conf.health.port}${conf.healthPath ? ` (${conf.healthPath})` : ''}`;
    say(`${cause}; killing it`);
    await killChild();
    child = null;
    scheduleRestart(`${cause}${recent.length ? `; last output: ${recent.slice(-3).join(' | ')}` : ''}`);
  }
}, PROBE_MS);
setInterval(publish, 15_000).unref();

for (const s of ['SIGTERM', 'SIGINT']) {
  process.on(s, async () => { stopping = true; clearTimeout(restartTimer); await killChild(); setState('stopped'); process.exit(0); });
}
say('supervisor ready');
