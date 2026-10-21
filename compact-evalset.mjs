// Emits a densely serialised evalset.mjs carrying exactly the same judged set as the readable one,
// then PROVES equivalence properly.
//
// Two bugs in the first attempt of this script are worth recording, because both would have shipped
// a silently degraded judged set:
//
//   1. It rebuilt each RAW row as {id,q,type,fam} and DROPPED `why`. `rr()` treats a query with a
//      `family` as judged on the whole set, but the eval rows and the review checks read `why`, and
//      the reconstructed set scored MRR 0.92 instead of 1.00. Every judgement must be preserved.
//   2. Its equality check copied the compact file to a name eval.mjs never imports, then compared
//      runs/eval-index-default.json against itself — so it printed "identical: true" for a
//      regression. The comparison must run the compact module through a real eval.mjs and diff the
//      resulting rows, including `why`.
//
// The 50,000-character ceiling is hard, and the shipped files are a dependency closure, so the
// judged set cannot simply be dropped. Compressing the serialisation keeps every id, query,
// family and rationale intact.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const mod = await import('./evalset.mjs');
const QUERIES = mod.QUERIES;

// Recover the family key per query from the RAW table. evalset.mjs does not export FAMILIES, and
// the previous attempt used a regex that silently lost entries whose fields were ordered
// differently; deriving it from QUERIES by matching the family object identity is exact.
const src = fs.readFileSync('src/evalset.mjs', 'utf8');
const famBlock = src.slice(src.indexOf('const FAMILIES'), src.indexOf('// The agent-side families'));
const declared = {};
for (const m of famBlock.matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)) {
  declared[m[1]] = m[2].match(/'([^']+)'/g).map(s => s.slice(1, -1));
}
// A family key is valid only if QUERIES actually carries that exact array.
const families = {};
for (const [k, v] of Object.entries(declared)) {
  if (QUERIES.some(q => Array.isArray(q.family) && q.family.length === v.length && q.family.every((x, i) => x === v[i]))) {
    families[k] = v;
  }
}

// Assign each query its family key by identity, so no query can be left without one.
const famKeyByQuery = {};
for (const q of QUERIES) {
  if (!Array.isArray(q.family)) continue;
  const hit = Object.entries(families).find(([, v]) => v.length === q.family.length && v.every((x, i) => x === q.family[i]));
  if (!hit) throw new Error('unmapped family for ' + q.id);
  famKeyByQuery[q.id] = hit[0];
}

const raw = QUERIES.map(q => ({
  id: q.id, q: q.q, type: q.type,
  ...(famKeyByQuery[q.id] ? { fam: famKeyByQuery[q.id] } : { expect: q.expect }),
  why: q.why, // MUST be preserved: it is the documented rationale the reviewer asked for
}));

const out = `export const FAMILIES=${JSON.stringify(families)};
const RAW=${JSON.stringify(raw)};
export const QUERIES=RAW.map(r=>r.fam?{...r,family:FAMILIES[r.fam],top3:FAMILIES[r.fam].slice(0,3)}:{...r,top3:[r.expect]});
export function rr(ranked,q){const t=new Set(q.family||[q.expect]);const i=ranked.findIndex(r=>t.has(r.ref)||t.has(String(r.id).split(':')[1]));return i===-1?0:1/(i+1);}
export function isJudged(q){return Array.isArray(q.top3)&&q.top3.length>0;}
export function targetsOf(q){return new Set(q.family||[q.expect]);}
export function dcg(g){return g.reduce((s,x,i)=>s+(x>0?(2**x-1)/Math.log2(i+2):0),0);}
`;

fs.mkdirSync('data/packed2/runs', { recursive: true });
fs.writeFileSync('data/packed2/evalset.mjs', out);
fs.copyFileSync('src/search.mjs', 'data/packed2/search.mjs');
fs.copyFileSync('src/eval.mjs', 'data/packed2/eval.mjs');

console.log('readable evalset:', fs.statSync('src/evalset.mjs').size, '-> compact:', out.length);
console.log('families kept:', Object.keys(families).length, '| queries:', raw.length,
  '| rows with why:', raw.filter(r => r.why).length);

// Real equivalence: run the COMPACT module through a real eval.mjs in a separate directory, then
// diff the produced rows field by field against the readable module's rows.
const env = { ...process.env, NODE_NO_WARNINGS: '1', BA_SEARCH_DB: path.resolve('data/index.db') };
execFileSync(process.execPath, ['src/eval.mjs'], { encoding: 'utf8', env });
const ref = JSON.parse(fs.readFileSync('runs/eval-index-default.json', 'utf8'));
execFileSync(process.execPath, ['eval.mjs'], { encoding: 'utf8', cwd: 'data/packed2', env });
const cmp = JSON.parse(fs.readFileSync('data/packed2/runs/eval-index-default.json', 'utf8'));

const key = j => j.queries.map(r => [r.id, r.query, r.type, r.judged, r.expected_top3, r.achieved_top3,
  r.mrr_at_10, r.hit_at_1, r.ndcg_at_10, r.why].join('|'));
const agg = j => JSON.stringify({ ...j.aggregate, label: '' });
console.log('rows identical (incl. why):', key(ref) === key(cmp));
console.log('aggregate identical:', agg(ref) === agg(cmp));
if (key(ref) !== key(cmp)) {
  for (let i = 0; i < ref.queries.length; i++) {
    if (key(ref)[i] !== key(cmp)[i]) { console.log('  FIRST DIFF', ref.queries[i].id, '\n   ref:', key(ref)[i], '\n   cmp:', key(cmp)[i]); break; }
  }
}
console.log('ref aggregate:', agg(ref));
console.log('cmp aggregate:', agg(cmp));