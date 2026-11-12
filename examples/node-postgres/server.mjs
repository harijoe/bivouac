import express from 'express';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:dev@postgres:5432/app' });
const app = express();
app.get('/health', (_q, r) => r.json({ ok: true }));
app.get('/', async (_q, r) => {
  const { rows } = await pool.query('SELECT body FROM notes ORDER BY id');
  r.type('html').send(`<!doctype html><title>Notes</title><h1>Notes</h1><ul>${rows.map((x) => `<li>${x.body}</li>`).join('')}</ul>`);
});
app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => console.log('listening'));
