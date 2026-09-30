#!/usr/bin/env node
// Inlines data/registry.json (the canonical registry) into index.html and syncs
// the registry revision into the page meta tag and the service-worker cache name.
// Usage: node scripts/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(join(root, 'data/registry.json'), 'utf8'));
const revision = registry.revision;
if (!/^\d{4}\.\d{2}\.\d{2}-r\d+$/.test(revision || '')) throw new Error(`Bad registry revision: ${revision}`);

// Escape "<" so the JSON can never close the surrounding <script> element.
const inline = JSON.stringify(registry).replace(/</g, '\\u003c');

const htmlPath = join(root, 'index.html');
let html = readFileSync(htmlPath, 'utf8');
const blockRe = /(<script type="application\/json" id="kawin-registry">)[\s\S]*?(<\/script>)/;
if (!blockRe.test(html)) throw new Error('index.html is missing the kawin-registry script block');
html = html.replace(blockRe, (_, open, close) => `${open}${inline}${close}`);
const metaRe = /(<meta name="kawin-registry-revision" content=")[^"]*(")/;
if (!metaRe.test(html)) throw new Error('index.html is missing the kawin-registry-revision meta tag');
html = html.replace(metaRe, `$1${revision}$2`);
writeFileSync(htmlPath, html);

const swPath = join(root, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const cacheRe = /const CACHE_NAME = '[^']*';/;
if (!cacheRe.test(sw)) throw new Error('sw.js is missing CACHE_NAME');
writeFileSync(swPath, sw.replace(cacheRe, `const CACHE_NAME = 'kawin-ai-setup-guide-${revision}';`));

console.log(`Inlined registry ${revision} into index.html and sw.js`);
