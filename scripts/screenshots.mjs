// Takes screenshots of every dashboard screen at 390 px and 1280 px (light, plus dark for the main screens).
//   node packages/daemon/dev/demo-server.mjs   (in another shell, PORT=3180)
//   node scripts/screenshots.mjs [outDir] [baseUrl]
// Needs playwright: BV_PLAYWRIGHT_DIR (default /tmp/bv-shot) must contain node_modules/playwright.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[2] ?? 'docs/screenshots');
const base = process.argv[3] ?? 'http://127.0.0.1:3180';
const require = createRequire(path.join(process.env.BV_PLAYWRIGHT_DIR ?? '/tmp/bv-shot', 'x.js'));
const { chromium } = require('playwright');
mkdirSync(out, { recursive: true });

const text = async (p) => (await fetch(base + p)).text();
const cookie = (await text('/__demo/cookie')).trim();
const setupLink = (await text('/__demo/setup-link')).trim();
const authorizeUrl = (await text('/__demo/authorize-url')).trim();
const tasks = await (await fetch(base + '/api/tasks', { headers: { cookie } })).json();
const dark = tasks.find((t) => t.name === 'dark-mode');

const sizes = { mobile: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const screens = [
  { name: 'login', path: '/login', anon: true },
  { name: 'home', path: '/' },
  { name: 'task', path: `/projects/${dark.projectName}/${dark.name}`, settle: 2500 },
  { name: 'settings', path: '/settings', full: true },
  { name: 'update', path: '/update' },
  { name: 'connect', path: '/connect' },
  { name: 'authorize', path: authorizeUrl },
  { name: 'setup-domain', path: setupLink, anon: true },
  { name: 'setup-claude', path: '/setup?step=claude', setup: true },
  { name: 'setup-chat', path: '/setup?step=chat', setup: true },
];
const browser = await chromium.launch();
const report = [];
for (const scheme of ['light', 'dark']) {
  for (const [sizeName, viewport] of Object.entries(sizes)) {
    for (const s of screens) {
      if (scheme === 'dark' && !['home', 'task', 'settings', 'update'].includes(s.name)) continue;
      const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 1, baseURL: base });
      if (!s.anon) { const [k, v] = cookie.split('='); await ctx.addCookies([{ name: k, value: v, url: base }]); }
      const page = await ctx.newPage();
      if (s.setup) { await page.goto(setupLink); }
      await page.goto(s.path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(s.settle ?? 400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const file = `${out}/${s.name}-${sizeName}${scheme === 'dark' ? '-dark' : ''}.png`;
      await page.screenshot({ path: file, fullPage: !!s.full || sizeName === 'mobile' });
      report.push(`${path.basename(file)} overflow=${overflow}`);
      await ctx.close();
    }
  }
}
await browser.close();
console.log(report.join('\n'));
