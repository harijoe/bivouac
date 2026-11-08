// Entry point of the `web` service: dashboard, API, MCP and OAuth on the public port; Traefik hooks on the internal port.
// It has no access to the Docker socket: every container operation goes through the executor service.
import { serve } from '@hono/node-server';
import path from 'node:path';
import { loadConfig } from './config.js';
import { buildContext } from './context-build.js';
import { Store } from './db.js';
import { ExecutorClient } from './remote.js';
import { createApp, createInternalApp } from './server.js';

const cfg = loadConfig();
const store = new Store(path.join(cfg.dataDir, 'bivouac.db'), cfg.secretKey);
cfg.domain = store.getSetting('domain') ?? cfg.domain;
if (!cfg.executorUrl) throw new Error('BIVOUAC_EXECUTOR_URL is required');
const executor = new ExecutorClient(cfg.executorUrl, cfg.executorToken);
const ctx = buildContext({ cfg, store, makeSandbox: (t) => executor.sandbox(t.id, t.projectName), login: executor, update: executor });
ctx.updates.recordOutcome();
ctx.updates.startBackground();
ctx.mgr.recover();
serve({ fetch: createApp(ctx).fetch, port: cfg.port, hostname: cfg.bind }, (i) => console.log(`bivouac web listening on ${i.address}:${i.port}`));
serve({ fetch: createInternalApp(ctx).fetch, port: cfg.internalPort, hostname: cfg.bind }, (i) => console.log(`bivouac internal listener on ${i.address}:${i.port}`));
for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => process.exit(0));
