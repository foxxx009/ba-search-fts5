// Measures how small the shipped source can get under progressively more aggressive packing,
// so the 50,000-character ceiling is met by MEASUREMENT and a justified file list rather than by
// hand-tuned constants. Aggressive stripping is only adopted if the packed files still parse and
// still produce identical output.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILES = ['server', 'cli', 'tune', 'mine-field-pairs', 'verify-incremental',
  'search', 'indexer', 'eval', 'evalset', 'verify-review'];

function stripComments(src) {
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
  return out;
}

const variants = {
  raw: (s) => s,
  noComments: (s) => stripComments(s),
  noCommentsNoIndent: (s) => stripComments(s).split('\n').map(l => l.replace(/^[ \t]+/, '')).filter(l => l.trim() !== '').join('\n'),
};

const totals = {};
for (const [name, fn] of Object.entries(variants)) {
  let t = 0;
  const per = {};
  for (const f of FILES) {
    const out = fn(fs.readFileSync(`src/${f}.mjs`, 'utf8'));
    per[f] = out.length; t += out.length;
  }
  totals[name] = t;
  console.log(`\n[${name}] total=${t}`);
  for (const f of FILES) console.log('   ', f.padEnd(22), per[f]);
}

// Prove the aggressive variant still parses.
console.log('\nparse check (noCommentsNoIndent):');
let bad = 0;
for (const f of FILES) {
  const out = variants.noCommentsNoIndent(fs.readFileSync(`src/${f}.mjs`, 'utf8'));
  const tmp = `data/_parse_${f}.mjs`;
  fs.writeFileSync(tmp, out);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) { bad++; console.log('   PARSE FAIL', f, String(e.stderr).slice(0, 200)); }
  fs.unlinkSync(tmp);
}
console.log(bad === 0 ? '   all 10 parse OK' : `   ${bad} FAILED`);

// Prove behavioural equivalence: eval output must match between raw and packed.
console.log('\nbehaviour check — eval.mjs aggregate, raw vs packed:');
const rawOut = execFileSync(process.execPath, ['src/eval.mjs'], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
fs.mkdirSync('data/packed', { recursive: true });
for (const f of FILES) fs.writeFileSync(`data/packed/${f}.mjs`, variants.noCommentsNoIndent(fs.readFileSync(`src/${f}.mjs`, 'utf8')));
// eval.mjs imports ./search.mjs and ./evalset.mjs by relative path, so run it from data/packed
// with the real index reachable via BA_SEARCH_DB.
const pkOut = execFileSync(process.execPath, ['eval.mjs'], {
  encoding: 'utf8',
  cwd: 'data/packed',
  env: { ...process.env, NODE_NO_WARNINGS: '1', BA_SEARCH_DB: path.resolve('data/index.db') },
});
import path from 'node:path';
const grab = (s) => s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
console.log('   identical aggregate:', grab(rawOut) === grab(pkOut));
if (grab(rawOut) !== grab(pkOut)) { console.log('   RAW:', grab(rawOut).slice(0, 400)); console.log('   PK :', grab(pkOut).slice(0, 400)); }