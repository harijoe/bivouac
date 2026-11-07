import { serve } from '@hono/node-server';
import Dockerode from 'dockerode';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { TaskManager } from './runner.js';
import { DockerSandbox } from './sandbox.js';
import { createApp } from './server.js';

const cfg = loadConfig();
const store = new Store(path.join(cfg.dataDir, 'bivouac.db'), cfg.secretKey);
const docker = new Dockerode();
const mgr = new TaskManager(store, cfg, (t) => new DockerSandbox(docker, { namePrefix: cfg.namePrefix, taskId: t.id, traefikContainer: cfg.traefikContainer, uid: cfg.taskUid }));
mgr.recover();
const app = createApp(cfg, store, mgr);
serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.bind }, (i) => console.log(`bivouac daemon listening on ${i.address}:${i.port}`));
for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => process.exit(0));
