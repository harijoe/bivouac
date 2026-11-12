#!/usr/bin/env node
// bivouac screenshot tool, run inside the task container after each attempt:  node shot.mjs <spec.json>
// spec: { base: "http://127.0.0.1:5173", pages: ["/", "/login"], widths: [375, 1280], out: "/workspace/.bivouac/shots/a3" }
// Writes <out>/<pageIndex>-<width>.jpg (full page, height capped), <out>/<pageIndex>-<width>-s.jpg (small, for chat clients) and
// <out>/result.json: per page and width the HTTP status, title, console errors, failed requests and detected problems.
// It talks to the dev server directly on the loopback of the container, so the preview's access check is not involved.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
mkdirSync(spec.out, { recursive: true });
const MAX_HEIGHT = 5000;
const SMALL_WIDTH = 480;
const say = (o) => writeFileSync(`${spec.out}/result.json`, JSON.stringify(o));
const trim = (s, n = 300) => String(s).replace(/\s+/g, ' ').slice(0, n);

const pw = await import(process.env.BIVOUAC_PLAYWRIGHT ? pathToFileURL(process.env.BIVOUAC_PLAYWRIGHT).href : 'playwright-core');
const chromium = pw.chromium ?? pw.default.chromium;
const result = { reachable: true, error: null, pages: [] };

// Is anything listening? A dev server that is down is reported once, not once per page.
try {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 6000);
  await fetch(spec.base + spec.pages[0], { signal: ac.signal, redirect: 'manual' });
  clearTimeout(t);
} catch (e) {
  result.reachable = false;
  result.error = `The dev server does not answer at ${spec.base}: ${trim(e?.cause?.code ?? e?.message ?? e)}`;
  say(result);
  process.exit(0);
}

const browser = await chromium.launch({
  executablePath: process.env.BIVOUAC_CHROMIUM || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
});
try {
  for (const width of spec.widths) {
    const context = await browser.newContext({ viewport: { width, height: width < 500 ? 812 : 800 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true, isMobile: width < 500 });
    for (let i = 0; i < spec.pages.length; i++) {
      const path = spec.pages[i];
      const page = await context.newPage();
      const consoleErrors = [], failed = [];
      page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.location()?.url ?? '') && consoleErrors.length < 10) consoleErrors.push(trim(m.text())); });
      page.on('pageerror', (e) => { if (consoleErrors.length < 10) consoleErrors.push(trim(`Uncaught: ${e?.message ?? e}`)); });
      page.on('requestfailed', (r) => { const err = r.failure()?.errorText ?? 'failed'; if (!/ERR_ABORTED/.test(err) && failed.length < 10) failed.push({ url: trim(r.url(), 200), error: err }); });
      page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url()) && r.request().resourceType() !== 'document' && failed.length < 10) failed.push({ url: trim(r.url(), 200), status: r.status() }); });
      const entry = { page: path, width, file: null, small: null, httpStatus: null, title: null, blank: false, consoleErrors, failedRequests: failed, problems: [] };
      try {
        let resp = null;
        try { resp = await page.goto(spec.base + path, { waitUntil: 'load', timeout: 20000 }); }
        catch (e) { entry.problems.push({ kind: /timeout/i.test(String(e?.message)) ? 'timeout' : 'unreachable', message: trim(e?.message ?? e) }); }
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(300);
        entry.httpStatus = resp ? resp.status() : null;
        const info = await page.evaluate(() => {
          const b = document.body;
          const text = (b?.innerText ?? '').trim();
          const media = document.querySelectorAll('img,canvas,svg,video,picture,iframe').length;
          const overlay = !!document.querySelector('vite-error-overlay, nextjs-portal, #webpack-dev-server-client-overlay, [data-nextjs-dialog-overlay]');
          return { title: document.title, blank: !b || (text.length === 0 && media === 0), overlay, height: Math.max(document.documentElement.scrollHeight, b?.scrollHeight ?? 0) };
        }).catch(() => ({ title: '', blank: true, overlay: false, height: 800 }));
        entry.title = info.title || null;
        entry.blank = info.blank;
        if (entry.httpStatus !== null && entry.httpStatus >= 400) entry.problems.push({ kind: 'http', message: `The page answered HTTP ${entry.httpStatus}` });
        if (info.overlay) entry.problems.push({ kind: 'overlay', message: 'The framework shows an error overlay (a build or runtime error)' });
        else if (info.blank && entry.httpStatus !== null) entry.problems.push({ kind: 'blank', message: 'The page is blank: no text and no image' });
        if (consoleErrors.length) entry.problems.push({ kind: 'console', message: `${consoleErrors.length} error(s) in the browser console` });
        if (failed.length) entry.problems.push({ kind: 'request', message: `${failed.length} request(s) failed` });
        // full page by CDP so that a tall page is cut at MAX_HEIGHT and a small copy can be scaled down in the same call
        const cdp = await context.newCDPSession(page);
        const h = Math.min(Math.max(Math.ceil(info.height), 200), MAX_HEIGHT);
        const shoot = async (scale, quality) => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h, scale } })).data, 'base64');
        const stem = `${i}-${width}`;
        writeFileSync(`${spec.out}/${stem}.jpg`, await shoot(1, 72)); entry.file = `${stem}.jpg`;
        writeFileSync(`${spec.out}/${stem}-s.jpg`, await shoot(Math.min(1, SMALL_WIDTH / width), 55)); entry.small = `${stem}-s.jpg`;
      } catch (e) {
        entry.problems.push({ kind: 'unreachable', message: trim(`Capture failed: ${e?.message ?? e}`) });
      } finally { await page.close().catch(() => {}); }
      result.pages.push(entry);
      say(result);
    }
    await context.close();
  }
} finally { await browser.close().catch(() => {}); }
say(result);
