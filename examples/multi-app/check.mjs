// Success command: the Postgres sidecar must be reachable by name from the task container.
import { connect } from 'node:net';
const tryOnce = () => new Promise((resolve) => { const s = connect({ host: 'postgres', port: 5432, timeout: 2000 }, () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); }); });
for (let i = 0; i < 40; i++) { if (await tryOnce()) { console.log('postgres:5432 reachable'); process.exit(0); } await new Promise((r) => setTimeout(r, 1500)); }
console.error('postgres:5432 not reachable'); process.exit(1);
