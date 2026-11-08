// Tiny front (5173) + API (3000) used by the bivouac e2e tests. No dependencies.
import { createServer } from 'node:http';
import { connect } from 'node:net';

const task = process.env.BIVOUAC_TASK_ID ?? '?';
const pgUp = () => new Promise((resolve) => {
  const s = connect({ host: 'postgres', port: 5432, timeout: 2000 }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); });
});
createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<h1>web of task ${task}</h1>`); }).listen(5173, '0.0.0.0');
createServer(async (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ api: true, task, postgres: (await pgUp()) ? 'up' : 'down' })); }).listen(3000, '0.0.0.0');
