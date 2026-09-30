#!/usr/bin/env node
// Serves the site locally (or checks a URL), renders it in headless Chrome and
// asserts that the registry-driven UI rendered without errors.
// Usage: node scripts/render-check.mjs [--url=https://example.vercel.app/] [--chrome=/path/to/chrome]
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
const chrome = args.chrome || ['google-chrome', 'chromium', 'chromium-browser'].find(bin => {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
});
if (!chrome) { console.error('No Chrome/Chromium found; pass --chrome=/path'); process.exit(2); }

const registry = JSON.parse(readFileSync(join(root, 'data/registry.json'), 'utf8'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

let server;
let url = args.url;
if (!url) {
  server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, path === '/' ? 'index.html' : path);
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
}

const dump = (width, height) => new Promise((resolve, reject) => {
  import('node:child_process').then(({ execFile }) => {
    execFile(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=5000', `--window-size=${width},${height}`, '--dump-dom', url],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
});

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };
for (const [label, w, h] of [['mobile', 390, 844], ['desktop', 1280, 900]]) {
  const dom = await dump(w, h);
  const count = re => (dom.match(re) || []).length;
  const text = dom.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
  check(dom.includes(`data-rendered="${registry.revision}"`), `${label}: init() did not finish (body data-rendered missing)`);
  check(dom.includes(`<meta name="kawin-registry-revision" content="${registry.revision}"`), `${label}: revision meta missing`);
  const sections = count(/<section class="section-card[^"]*" id="/g);
  check(sections === registry.editorial.sections.length + 6, `${label}: expected ${registry.editorial.sections.length + 6} sections, found ${sections}`);
  check(count(/class="compare-card /g) > 200, `${label}: too few compare cards rendered`);
  check(count(/class="dash-card"/g) === registry.editorial.recommendations.length, `${label}: recommendation card count mismatch`);
  check(count(/class="change-card"/g) === registry.launches.length + registry.repos.length + registry.editorial.cards.workflowClones.length, `${label}: change card count mismatch`);
  check(count(/class="freshness-card"/g) === Object.keys(registry.categories).length, `${label}: category card count mismatch`);
  for (const m of registry.models) check(text.includes(m.name), `${label}: model ${m.name} not rendered`);
  check(!/\b(NaN|undefined|Infinity|null)\b/.test(text), `${label}: rendered text contains NaN/undefined/Infinity/null`);
  check(/₹\d/.test(text), `${label}: no rupee amounts rendered`);
  check(!/(?:US)?\$\s?\d/.test(text), `${label}: non-INR amount rendered`);
  const externalLinks = dom.match(/<a [^>]*target="_blank"[^>]*>/g) || [];
  check(externalLinks.length > 0 && externalLinks.every(a => a.includes('rel="noopener noreferrer"')), `${label}: external links must use rel="noopener noreferrer"`);
  console.log(`${label} (${w}x${h}): ${sections} sections, ${count(/class="compare-card /g)} compare cards, ${externalLinks.length} source links`);
}
server?.close();
if (failures.length) { failures.forEach(f => console.error(`error: ${f}`)); process.exit(1); }
console.log(`Render check OK for ${url} (registry ${registry.revision})`);
