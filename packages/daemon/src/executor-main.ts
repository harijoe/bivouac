// Entry point of the `executor` service: the only component with the Docker socket. Reachable only from the web service.
import { serve } from '@hono/node-server';
import Dockerode from 'dockerode';
import { loadConfig } from './config.js';
import { createExecutorApp } from './executor.js';

const cfg = loadConfig(process.env, { needSecretKey: false });
if (!cfg.executorToken) throw new Error('BIVOUAC_EXECUTOR_TOKEN is required');
const app = createExecutorApp(cfg, new Dockerode());
serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.bind }, (i) => console.log(`bivouac executor listening on ${i.address}:${i.port}`));
for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => process.exit(0));
