// Budget solver for the revision payload.
//
// The payload must fit content <= 50,000 characters, and the shipped source is a dependency
// closure: every one of the reviewer's five mandated files imports search.mjs, tune.mjs also
// imports evalset.mjs, and verify-incremental.mjs shells out to indexer.mjs. Dropping a
// "non-mandated" file therefore breaks a mandated one, so the file set cannot be trimmed by
// preference — only by dropping a whole branch.
//
// This script measures each candidate file set against the fixed sections, so the final choice is
// made by arithmetic rather than by guessing. It prints the best fitting set.
import fs from 'node:fs';

const strip = (src) => {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + src[i + 1]; i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out.split('\n').map(l => l.replace(/^[ \t]+/, '')).filter(l => l.trim() !== '').join('\n');
};

const size = {};
for (const f of ['server', 'cli', 'tune', 'mine-field-pairs', 'verify-incremental',
  'search', 'indexer', 'eval', 'evalset', 'verify-review']) {
  size[f] = strip(fs.readFileSync(`src/${f}.mjs`, 'utf8')).length;
}
console.log('packed sizes:');
for (const [k, v] of Object.entries(size)) console.log('  ', k.padEnd(22), v);

// Closure analysis: what each mandated file needs in order to run at all.
const NEEDS = {
  server: ['search'],
  cli: ['search'],
  tune: ['search', 'evalset'],
  'mine-field-pairs': ['search'],
  'verify-incremental': ['search', 'indexer'],
};
const closure = new Set();
for (const f of Object.keys(NEEDS)) { closure.add(f); NEEDS[f].forEach(d => closure.add(d)); }
console.log('\nclosure for the 5 mandated files:', [...closure].join(', '));
let closureBytes = 0; for (const f of closure) closureBytes += size[f];
console.log('closure bytes:', closureBytes);
console.log('+ eval.mjs (regenerates the 25 rows):', closureBytes + size.eval);
console.log('+ verify-review.mjs (18-check harness):', closureBytes + size.eval + size['verify-review']);