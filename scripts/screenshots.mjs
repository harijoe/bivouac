// Takes screenshots of every dashboard screen at 375 px and 1280 px, in dark and light mode.
//   node packages/daemon/dev/demo-server.mjs   (in another shell, PORT=3180; needs `pnpm -r build` first)
//   node scripts/screenshots.mjs [outDir] [baseUrl]
// Needs playwright: BV_PLAYWRIGHT_DIR (default /tmp/bv-shot) must contain node_modules/playwright.
// Also reports horizontal overflow (must be 0 at 375 px) and any browser console error.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[2] ?? 'docs/screenshots/v0.4');
const base = process.argv[3] ?? 'http://127.0.0.1:3180';
const require = createRequire(path.join(process.env.BV_PLAYWRIGHT_DIR ?? '/tmp/bv-shot', 'x.js'));
const { chromium } = require('playwright');
mkdirSync(out, { recursive: true });

const text = async (p) => (await fetch(base + p)).text();
const cookie = (await text('/__demo/cookie')).trim();
const setupLink = (await text('/__demo/setup-link')).trim();
const authorizeUrl = (await text('/__demo/authorize-url')).trim();
const projects = await (await fetch(base + '/api/projects', { headers: { cookie } })).json();
const tasks = await (await fetch(base + '/api/tasks', { headers: { cookie } })).json();
const dark = tasks.find((t) => t.name === 'dark-mode');
const project = dark.projectName;
const taskPath = (n) => `/projects/${project}/${n}`;

const sizes = { mobile: { width: 375, height: 812 }, desktop: { width: 1280, height: 800 } };
const screens = [
  { name: 'login', path: '/login', anon: true },
  { name: 'home', path: '/', settle: 1200 },
  { name: 'project', path: `/projects/${project}`, settle: 1200 },
  { name: 'new-task', path: `/projects/${project}/new` },
  { name: 'task', path: taskPath('dark-mode'), settle: 2500 },
  { name: 'task-logs', path: `${taskPath('dark-mode')}#logs`, settle: 2500 },
  { name: 'task-blocked', path: taskPath('node-26'), settle: 1000 },
  { name: 'task-stuck', path: taskPath('flaky-e2e'), settle: 1000 },
  { name: 'settings-claude', path: '/settings/claude' },
  { name: 'settings-projects', path: '/settings/projects', settle: 800 },
  { name: 'settings-chat', path: '/settings/chat' },
  { name: 'settings-domain', path: '/settings/domain' },
  { name: 'settings-updates', path: '/settings/updates' },
  { name: 'settings-access', path: '/settings/access' },
  { name: 'settings-advanced', path: '/settings/advanced' },
  { name: 'authorize', path: authorizeUrl },
  { name: 'setup-domain', path: setupLink, anon: true },
  { name: 'setup-github', path: '/setup?step=github', setup: true },
  { name: 'setup-repos', path: '/setup?step=repos', setup: true },
  { name: 'setup-claude', path: '/setup?step=claude', setup: true },
  { name: 'setup-chat', path: '/setup?step=chat', setup: true },
];
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const browser = await chromium.launch();
const report = [];
for (const scheme of ['dark', 'light']) {
  for (const [sizeName, viewport] of Object.entries(sizes)) {
    for (const s of screens) {
      if (only && !only.test(s.name)) continue;
      const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 1, baseURL: base });
      await ctx.addInitScript((t) => { try { localStorage.setItem('bv-theme', t); } catch { /* private mode */ } }, scheme);
      if (!s.anon) { const [k, v] = cookie.split('='); await ctx.addCookies([{ name: k, value: v, url: base }]); }
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
      if (s.setup) { await page.goto(setupLink); }
      await page.goto(s.path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(s.settle ?? 500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const file = `${out}/${s.name}-${sizeName}-${scheme}.png`;
      await page.screenshot({ path: file, fullPage: sizeName === 'mobile' });
      report.push(`${path.basename(file)} overflow=${overflow}${errors.length ? ` console=${JSON.stringify(errors)}` : ''}`);
      await ctx.close();
    }
  }
}
await browser.close();
console.log(report.join('\n'));
void projects;
