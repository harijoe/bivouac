import { createServer } from 'node:http';
createServer((_req, res) => res.end(`legacy app, task ${process.env.BIVOUAC_TASK_ID}\n`)).listen(5173, '0.0.0.0');
