import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(process.cwd(), 'dist');
const PORT = 4401;
const OUT = process.argv[2] ?? 'desktop-hero.png';
const ROUTE = process.argv[3] ?? '/';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
async function tryFiles(u) {
  const clean = decodeURIComponent(u.split('?')[0]);
  const rel = normalize(clean).replace(/^(\.\.[/\\])+/, '');
  for (const p of [join(ROOT, rel), join(ROOT, rel, 'index.html')]) {
    try { if ((await stat(p)).isFile()) return p; } catch {}
  }
  return null;
}
const server = http.createServer(async (req, res) => {
  const file = await tryFiles(req.url === '/' ? '/index.html' : req.url);
  if (!file) { res.statusCode = 404; res.end('nf'); return; }
  const body = await readFile(file);
  res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
  res.end(body);
});
await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`http://localhost:${PORT}${ROUTE}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: OUT, fullPage: false });
console.log(`wrote ${OUT}`);
await browser.close(); server.close(); process.exit(0);
