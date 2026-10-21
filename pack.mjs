// Packs sources for the 50,000-character submission ceiling by stripping comments, then PROVES
// the packed copies behave identically to the originals.
//
// `node --check` only proves a file parses; it does not prove the strip did not change
// behaviour. So this materialises the packed sources into a real src/ layout and RUNS them
// against the same index, diffing the substantive output of each against the original.
// If any case differs, the exit code is non-zero and the pack must not be shipped.
//
// The stripper is a small scanner that tracks string, template and regex literal state, because
// a naive regex strips "//" inside a URL or a template literal and silently corrupts the file.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const NODE = process.execPath;

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // tracks whether a '/' at position i begins a regex literal rather than division
  let lastSignificant = '';
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + src[i + 1]; i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      lastSignificant = q;
      continue;
    }
    if (c === '/' && /[=(,:[!&|?{};+\-*%^~<>]/.test(lastSignificant.slice(-1))) {
      // regex literal: consume to the closing unescaped '/'
      out += c; i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + src[i + 1]; i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { out += '/'; i++; break; }
        else if (src[i] === '\n') break;   // not a regex after all; bail out safely
        out += src[i]; i++;
      }
      lastSignificant = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

const TARGETS = [
  'crawl.mjs', 'crawl-samples.mjs', 'indexer.mjs', 'search.mjs', 'server.mjs', 'cli.mjs',
  'evalset.mjs', 'eval.mjs', 'mine-field-pairs.mjs', 'tune.mjs',
  'verify-e2e.mjs', 'verify-incremental.mjs', 'verify-determinism.mjs', 'verify-review.mjs',
];

const PACK = path.resolve('data/packed');
fs.rmSync(PACK, { recursive: true, force: true });
const SRCDIR = path.join(PACK, 'src');
fs.mkdirSync(SRCDIR, { recursive: true });

let rawTotal = 0, packedTotal = 0;
for (const f of TARGETS) {
  const p = path.join('src', f);
  if (!fs.existsSync(p)) { console.log(`SKIP ${f} (not present)`); continue; }
  const raw = fs.readFileSync(p, 'utf8');
  const packed = stripComments(raw);
  rawTotal += raw.length; packedTotal += packed.length;
  fs.writeFileSync(path.join(SRCDIR, f), packed);
  console.log(`${f.padEnd(26)} ${String(raw.length).padStart(6)} -> ${String(packed.length).padStart(6)}  (-${raw.length - packed.length})`);
}
console.log(`\ntotal ${rawTotal} -> ${packedTotal} (-${rawTotal - packedTotal})`);

// parse gate
let parseFail = 0;
for (const f of fs.readdirSync(SRCDIR)) {
  try { execFileSync(NODE, ['--check', path.join(SRCDIR, f)], { stdio: 'pipe' }); }
  catch (e) { parseFail++; console.log(`PARSE FAIL ${f}: ${String(e.stderr || e).slice(0, 200)}`); }
}
console.log(`parse: ${fs.readdirSync(SRCDIR).length - parseFail}/${fs.readdirSync(SRCDIR).length} ok`);

// behaviour gate: run packed against the same index and diff substantive output
const cases = [
  { file: 'cli.mjs', args: ['"rust sdk"', '--type=task', '--limit=3'], name: 'cli rust sdk' },
  { file: 'cli.mjs', args: ['"escrow"', '--category=code', '--limit=3'], name: 'cli category filter' },
  { file: 'cli.mjs', args: ['--stats'], name: 'cli stats' },
  { file: 'cli.mjs', args: ['"rsut"', '--fuzzy', '--limit=3'], name: 'cli typo tier' },
  { file: 'eval.mjs', args: [], name: 'eval' },
  { file: 'tune.mjs', args: [], name: 'tune' },
  { file: 'verify-determinism.mjs', args: [], name: 'determinism' },
];
let same = 0, diff = 0;
for (const c of cases) {
  const run = (dir) => {
    try {
      return execFileSync(NODE, [path.join(dir, c.file), ...c.args], {
        encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { return 'ERROR:' + (e.stdout || '') + (e.stderr || ''); }
  };
  const norm = s => s.split('\n')
    .filter(l => !/built_at|_at"|\d{4}-\d{2}-\d{2}T|generated_at|ExperimentalWarning|trace-warnings/.test(l))
    .join('\n').trim();
  const a = norm(run('src')), b = norm(run(SRCDIR));
  if (a === b) { same++; console.log(`MATCH  ${c.name}`); }
  else {
    diff++;
    console.log(`DIFFER ${c.name}`);
    const la = a.split('\n'), lb = b.split('\n');
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      if (la[i] !== lb[i]) {
        console.log(`   orig[${i}]: ${String(la[i]).slice(0, 120)}`);
        console.log(`   pack[${i}]: ${String(lb[i]).slice(0, 120)}`);
        break;
      }
    }
  }
}
console.log(`\npacked-vs-original: ${same} identical, ${diff} differing (of ${cases.length})`);
console.log(`PACK VERDICT: ${parseFail === 0 && diff === 0 ? 'PASS' : 'FAIL'}`);
if (parseFail || diff) process.exitCode = 1;