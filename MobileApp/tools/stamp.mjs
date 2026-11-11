// Writes the service worker's file list and BUILD (a hash of every file in www/), so a changed file reaches phones.
// Run after any change to www/:  npm run stamp
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const WWW = join(dirname(fileURLToPath(import.meta.url)), '..', 'www');
const SW = join(WWW, 'sw.js');

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(WWW)
  .map((p) => relative(WWW, p).split(sep).join('/'))
  .filter((f) => f !== 'sw.js' && !f.startsWith('.'))
  .sort();
const hash = createHash('sha256');
for (const f of files) hash.update(f + '\0').update(readFileSync(join(WWW, f)));
const build = hash.digest('hex').slice(0, 10);

let sw = readFileSync(SW, 'utf8');
sw = sw.replace(/const BUILD = '[^']*';/, `const BUILD = '${build}';`);
sw = sw.replace(/const FILES = \[[\s\S]*?\];/, `const FILES = [\n  './',\n${files.map((f) => `  '${f}',`).join('\n')}\n];`);
writeFileSync(SW, sw);
console.log(`sw.js: BUILD ${build}, ${files.length + 1} files`);
