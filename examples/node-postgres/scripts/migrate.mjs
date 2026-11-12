// Waits for Postgres (a sidecar of the task, reachable as `postgres`), then creates the schema and a few rows.
import pg from 'pg';
const url = process.env.DATABASE_URL ?? 'postgres://postgres:dev@postgres:5432/app';
let client;
for (let i = 0; i < 60; i++) {
  try { client = new pg.Client({ connectionString: url }); await client.connect(); break; } catch { client = null; await new Promise((r) => setTimeout(r, 1000)); }
}
if (!client) { console.error('Postgres did not answer'); process.exit(1); }
await client.query('CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, body text NOT NULL)');
await client.query("INSERT INTO notes(body) SELECT 'hello from postgres' WHERE NOT EXISTS (SELECT 1 FROM notes)");
await client.end();
console.log('migrated');
