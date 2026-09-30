#!/usr/bin/env node
// Validates the Kawin AI registry and the published page. Exits non-zero on any error.
// Usage: node scripts/validate-registry.mjs [--today=YYYY-MM-DD] [--max-age-days=N]
//
// Rejects:
//  - factual records without resolvable https sources, a category, or an as-of date
//  - stale factual records (older than --max-age-days) and expired prices
//  - global "current/latest/live/today" freshness language anywhere on the page
//  - non-INR money amounts and hardcoded rupee amounts (all ₹ values must be derived)
//  - drift between data/registry.json, the inline copy in index.html, the meta
//    revision tag and the service-worker cache name
//  - reintroduction of the orphaned content.txt
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const today = args.today || new Date().toISOString().slice(0, 10);
const maxAgeDays = Number(args['max-age-days'] ?? process.env.REGISTRY_MAX_AGE_DAYS ?? 30);

const errors = [];
const warnings = [];
const err = msg => errors.push(msg);
const warn = msg => warnings.push(msg);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// ---------- load ----------
const registry = JSON.parse(readFileSync(join(root, 'data/registry.json'), 'utf8'));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');

const inlineMatch = html.match(/<script type="application\/json" id="kawin-registry">([\s\S]*?)<\/script>/);
if (!inlineMatch) err('index.html: missing <script type="application/json" id="kawin-registry">');
else {
  let inline;
  try { inline = JSON.parse(inlineMatch[1]); } catch (e) { err(`index.html: inline registry is not valid JSON (${e.message})`); }
  if (inline && JSON.stringify(inline) !== JSON.stringify(registry)) err('index.html: inline registry differs from data/registry.json — run `node scripts/build.mjs`');
}

// ---------- top level ----------
const rev = registry.revision;
if (registry.schema !== 'kawin-ai-registry/2') err(`schema must be kawin-ai-registry/2 (got ${registry.schema})`);
if (!/^\d{4}\.\d{2}\.\d{2}-r\d+$/.test(rev || '')) err(`revision must look like YYYY.MM.DD-rN (got ${rev})`);
if (registry.displayCurrency !== 'INR') err('displayCurrency must be INR');
const metaRev = html.match(/<meta name="kawin-registry-revision" content="([^"]*)"/);
if (!metaRev || metaRev[1] !== rev) err(`index.html: kawin-registry-revision meta must equal ${rev}`);
const cache = sw.match(/const CACHE_NAME = '([^']*)'/);
if (!cache || cache[1] !== `kawin-ai-setup-guide-${rev}`) err(`sw.js: CACHE_NAME must be kawin-ai-setup-guide-${rev}`);
if (existsSync(join(root, 'content.txt'))) err('content.txt must not exist: all content lives in data/registry.json');

// ---------- sources and categories ----------
const sources = registry.sources || {};
for (const [id, s] of Object.entries(sources)) {
  if (!/^https:\/\/[^\s]+$/.test(s.url || '')) err(`source ${id}: url must be https`);
  if (!s.publisher || !s.title) err(`source ${id}: publisher and title required`);
  if (!ISO.test(s.accessed || '')) err(`source ${id}: accessed must be YYYY-MM-DD`);
  else if (s.accessed > today) err(`source ${id}: accessed date ${s.accessed} is in the future`);
}
const categories = registry.categories || {};
for (const [id, c] of Object.entries(categories)) {
  if (!c.label) err(`category ${id}: label required`);
  if (!['primary-source', 'editorial'].includes(c.basis)) err(`category ${id}: basis must be primary-source or editorial`);
  if (!ISO.test(c.asOf || '')) err(`category ${id}: asOf must be YYYY-MM-DD`);
  else {
    if (c.asOf > today) err(`category ${id}: asOf ${c.asOf} is in the future`);
    const age = days(c.asOf, today);
    if (age > maxAgeDays) err(`category ${id}: asOf ${c.asOf} is ${age} days old (max ${maxAgeDays}); re-review per REFRESH.md`);
    else if (age > 7) warn(`category ${id}: asOf ${c.asOf} is ${age} days old`);
  }
}
const checkSources = (where, list, required) => {
  if (list === undefined && !required) return;
  if (!Array.isArray(list) || list.length === 0) return err(`${where}: at least one source required`);
  for (const s of list) if (!sources[s]) err(`${where}: unknown source "${s}"`);
};

// ---------- factual records ----------
const ids = new Set();
const fact = (collection, rec, required) => {
  const where = `${collection}/${rec.id}`;
  if (!rec.id) err(`${collection}: record without id`);
  if (ids.has(rec.id)) err(`${where}: duplicate id`);
  ids.add(rec.id);
  const cat = categories[rec.category];
  if (!cat) err(`${where}: unknown category "${rec.category}"`);
  else if (cat.basis !== 'primary-source') err(`${where}: factual records must use a primary-source category`);
  if (!ISO.test(rec.asOf || '')) err(`${where}: asOf must be YYYY-MM-DD`);
  else {
    if (rec.asOf > today) err(`${where}: asOf is in the future`);
    const age = days(rec.asOf, today);
    if (age > maxAgeDays) err(`${where}: asOf ${rec.asOf} is ${age} days old (max ${maxAgeDays}); re-verify or remove`);
  }
  checkSources(where, rec.sources, true);
  for (const [k, type] of Object.entries(required)) {
    const v = rec[k];
    if (type === 'number' && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) err(`${where}: ${k} must be a non-negative number`);
    if (type === 'number?' && !(v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0))) err(`${where}: ${k} must be a positive number or null`);
    if (type === 'string' && !(typeof v === 'string' && v.trim())) err(`${where}: ${k} required`);
    if (type === 'date' && !(ISO.test(v || '') && v <= today)) err(`${where}: ${k} must be a past YYYY-MM-DD date`);
  }
};

fact('fx', registry.fx, { inrPerUsd: 'number', rateDate: 'date', label: 'string' });
if (registry.fx && !(registry.fx.inrPerUsd > 50 && registry.fx.inrPerUsd < 200)) err('fx: inrPerUsd outside plausible range');
for (const m of registry.models || []) {
  fact('models', m, { provider: 'string', name: 'string', apiId: 'string', inputUsdPerMTok: 'number', outputUsdPerMTok: 'number', contextTokens: 'number?', maxOutputTokens: 'number?' });
  if (!['ga', 'preview', 'restricted'].includes(m.status)) err(`models/${m.id}: status must be ga, preview or restricted`);
  if (m.priceValidUntil && m.priceValidUntil < today) err(`models/${m.id}: listed price expired on ${m.priceValidUntil}; apply scheduledPrice after re-verifying`);
  if (!m.editorial?.bestFor || !m.editorial?.watchOut) err(`models/${m.id}: editorial.bestFor and editorial.watchOut required`);
}
for (const g of registry.gpus || []) fact('gpus', g, { provider: 'string', name: 'string', gpu: 'string', usdPerHour: 'number' });
for (const l of registry.launches || []) fact('launches', l, { provider: 'string', model: 'string', date: 'date', changed: 'string', editorialAction: 'string' });
for (const p of registry.protocols || []) fact('protocols', p, { name: 'string', version: 'string', date: 'date', note: 'string' });
for (const r of registry.repos || []) fact('repos', r, { repo: 'string', area: 'string', release: 'string', date: 'date', note: 'string' });
if (!(registry.models || []).length) err('models: registry must contain at least one model');

// ---------- editorial ----------
const ed = registry.editorial || {};
if (categories[ed.category]?.basis !== 'editorial') err('editorial: category must reference an editorial-basis category');
const modelIds = new Set((registry.models || []).map(m => m.id));
const gpuIds = new Set((registry.gpus || []).map(g => g.id));
for (const r of ed.recommendations || []) {
  const where = `editorial.recommendations/${r.title}`;
  if (!r.title || !r.note) err(`${where}: title and note required`);
  if (!r.modelIds && !r.gpuIds && !r.text) err(`${where}: needs modelIds, gpuIds or text`);
  for (const id of r.modelIds || []) if (!modelIds.has(id)) err(`${where}: unknown model ${id}`);
  for (const id of r.gpuIds || []) if (!gpuIds.has(id)) err(`${where}: unknown gpu ${id}`);
  checkSources(where, r.sources, false);
}
const blend = ed.blend;
if (blend) {
  const total = blend.mix.reduce((s, x) => s + x.share, 0);
  if (Math.abs(total - 1) > 1e-9) err(`editorial.blend: shares sum to ${total}, expected 1`);
  for (const x of [...blend.mix.map(m => m.modelId), ...blend.compareWith]) if (!modelIds.has(x)) err(`editorial.blend: unknown model ${x}`);
}
const DERIVED = ['model-prices', 'cost-ranking', 'relative-multipliers', 'gpu-pricing', 'blended-routing', 'final-recommendations'];
const sectionIds = new Set(DERIVED);
for (const s of ed.sections || []) {
  const where = `editorial.sections/${s.id}`;
  if (sectionIds.has(s.id)) err(`${where}: duplicate section id`);
  sectionIds.add(s.id);
  if (s.basis !== 'editorial') err(`${where}: basis must be editorial`);
  if (!s.title || !Array.isArray(s.cardFields) || !Array.isArray(s.rows) || !s.rows.length) err(`${where}: title, cardFields and rows required`);
  for (const [i, row] of (s.rows || []).entries()) if (row.length !== s.cardFields.length) err(`${where}: row ${i} has ${row.length} cells, expected ${s.cardFields.length}`);
  if (s.secondaryRows) for (const [i, row] of s.secondaryRows.entries()) if (row.length !== s.secondaryFields.length) err(`${where}: secondary row ${i} has wrong cell count`);
  checkSources(where, s.sources, false);
}
for (const t of ed.nav || []) for (const id of t.sectionIds) if (!sectionIds.has(id)) err(`editorial.nav/${t.id}: unknown section ${id}`);

// ---------- language and currency ----------
// Global freshness claims are not allowed: dates must be per record or per category.
const FORBIDDEN = /\b(right now|today|todays|currently|current|latest|newest|up[- ]to[- ]date|as of now|this (?:cycle|week|month)|audited|last updated|cron|auto[- ]?updated|updated (?:daily|hourly|live)|live (?:data|feed|pricing|prices|rankings?|signals?|updates?|leaderboards?)|real[- ]time (?:data|pricing|prices|rankings?)|now)\b/i;
// Money must be INR-only, and rupee amounts must be computed from USD facts at render time.
const NON_INR = /(?:US)?\$\s?\d|\bUSD\s?\d|\d\s?USD\b|€\s?\d|£\s?\d|¥\s?\d|\b(?:CNY|RMB|EUR|GBP)\b/;
const HARDCODED_INR = /₹\s?(?:[1-9]|0[.,]\d*[1-9])/;
const SKIP_KEYS = new Set(['url', 'id', 'apiId', 'sources', 'modelIds', 'gpuIds', 'sectionIds', 'modelId', 'compareWith', 'category', 'basis', 'status', 'schema', 'revision']);
const scan = (value, path) => {
  if (Array.isArray(value)) return value.forEach((v, i) => scan(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => { if (!SKIP_KEYS.has(k)) scan(v, `${path}.${k}`); });
  if (typeof value !== 'string') return;
  const f = value.match(FORBIDDEN); if (f) err(`${path}: unsupported global-freshness language "${f[0]}" in "${value.slice(0, 90)}"`);
  const n = value.match(NON_INR); if (n) err(`${path}: non-INR money "${n[0]}" in "${value.slice(0, 90)}"`);
  const r = value.match(HARDCODED_INR); if (r) err(`${path}: hardcoded rupee amount "${r[0]}"; derive it from registry facts`);
};
const { sources: _s, ...scannable } = registry;
scan(scannable, 'registry');
for (const [id, s] of Object.entries(sources)) scan({ title: s.title, publisher: s.publisher }, `sources.${id}`);

const page = html
  .replace(/<script type="application\/json" id="kawin-registry">[\s\S]*?<\/script>/, '')
  .replace(/<style>[\s\S]*?<\/style>/, '');
page.split('\n').forEach((line, i) => {
  const f = line.match(FORBIDDEN); if (f) err(`index.html:${i + 1}: unsupported global-freshness language "${f[0]}"`);
  const n = line.match(NON_INR); if (n) err(`index.html:${i + 1}: non-INR money "${n[0]}"`);
  const r = line.match(HARDCODED_INR); if (r) err(`index.html:${i + 1}: hardcoded rupee amount "${r[0]}"`);
});

// ---------- report ----------
for (const w of warnings) console.warn(`warn: ${w}`);
const counts = ['models', 'gpus', 'launches', 'protocols', 'repos'].map(k => `${k}=${(registry[k] || []).length}`).join(' ');
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`\nRegistry ${rev}: ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`Registry ${rev} OK (today=${today}, max-age=${maxAgeDays}d): ${Object.keys(sources).length} sources, ${counts}, ${(ed.sections || []).length} editorial sections`);
