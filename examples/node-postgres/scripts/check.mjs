// Success check: the app answers and shows the database content.
const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/`);
const t = await r.text();
if (!r.ok || !t.includes('hello from postgres')) { console.error('unexpected answer', r.status, t.slice(0, 200)); process.exit(1); }
console.log('ok');
