// The tuning benchmark. A metric has to be able to move before a tuning result means
// anything, so this measures exactly what a bm25 weight vector is able to express:
//
//   FIELD-PAIR ACCURACY -- for each mined pair, the target holds the discriminating term in
//   its TITLE while the distractor has it only in its BODY. Both documents match the query
//   perfectly, so only field weighting can separate them. Flat weights must score near
//   chance; title-heavy weights must score high. If those two numbers are equal, the
//   weights are not reaching the ranker at all.
//
//   The 25-query topical set is reported alongside as a guard: it must NOT regress. It
//   saturates at MRR 1.0 because the board is full of near-identical titles -- 67 of the 370
//   task titles are duplicated (largest family 4 copies) -- which is a property of the corpus,
//   not of the ranker. That is exactly why the field-pair benchmark above exists.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { open, search } from './search.mjs';
import { QUERIES, rr, dcg, isJudged } from './evalset.mjs';

const db = open();

// The mined pairs are a DERIVED artifact. If runs/field-pairs.json is absent (a fresh
// checkout, or a copy of this delivery), regenerate it rather than failing with ENOENT --
// otherwise the tuning iteration cannot be re-run from the shipped files alone.
const PAIRS_PATH = 'runs/field-pairs.json';
if (!fs.existsSync(PAIRS_PATH)) {
  const miner = 'src/mine-field-pairs.mjs';
  if (!fs.existsSync(miner)) {
    console.error(
      `${PAIRS_PATH} is missing and ${miner} is not present, so the field-pair benchmark\n`
      + 'cannot be rebuilt. Restore mine-field-pairs.mjs (it is a small script) or supply\n'
      + 'runs/field-pairs.json. This is a real dependency, not a fallback: the tuning\n'
      + 'numbers below are meaningless without those pairs.');
    process.exit(1);
  }
  console.log(`${PAIRS_PATH} not found -- mining it now (node src/mine-field-pairs.mjs)`);
  execFileSync(process.execPath, [miner], { stdio: 'inherit' });
}
const PAIRS = JSON.parse(fs.readFileSync(PAIRS_PATH, 'utf8'));

const PROFILES = [
  { name: 'v0-flat', w: { title: 1, capabilities: 1, tags: 1, body: 1 }, note: 'baseline: every field equal' },
  { name: 'v1-mild', w: { title: 4, capabilities: 2, tags: 2, body: 1 }, note: 'mild title preference' },
  { name: 'v2-title-heavy', w: { title: 10, capabilities: 6, tags: 4, body: 1 }, note: 'title dominates 10:1' },
  { name: 'v3-title-max', w: { title: 30, capabilities: 8, tags: 4, body: 1 }, note: 'title dominates 30:1' },
  { name: 'v4-caps-lead', w: { title: 5, capabilities: 20, tags: 3, body: 2 }, note: 'capabilities lead; wrong axis, kept as a control' },
];

function evalProfile(name, W, note) {
  let top1 = 0, mrrSum = 0;
  const wrong = [];
  for (const p of PAIRS) {
    const r = search(db, { q: p.query, type: 'task', limit: 10, weights: W });
    const i = r.results.findIndex(x => x.ref === p.target);
    const j = r.results.findIndex(x => x.ref === p.distractor);
    const targetFirst = i !== -1 && (j === -1 || i < j);
    if (targetFirst) top1++;
    if (i !== -1) mrrSum += 1 / (i + 1);
    else wrong.push(p.query);
  }
  // topical guard
  const judged = QUERIES.filter(isJudged);
  let mrrT = 0, hit1 = 0, ndcgSum = 0;
  for (const q of QUERIES) {
    const r = search(db, { q: q.q, type: q.type, bounty: q.bounty || '', limit: 10, weights: W });
    if (isJudged(q)) {
      const v = rr(r.results, q); mrrT += v; if (v === 1) hit1++;
    }
    // graded gains, same definition as eval.mjs: 3 = expected_top3 member, 1 = other returned
    const gains = r.results.slice(0, 10).map(x => (q.top3.includes(x.ref) ? 3 : 1));
    const idealHits = Math.min(q.top3.length, 10);
    const ideal = isJudged(q)
      ? dcg([...Array(idealHits).fill(3), ...Array(10 - idealHits).fill(1)])
      : dcg(Array(10).fill(1));
    ndcgSum += dcg(gains) / ideal;
  }
  return {
    profile: name, weights: W, note,
    field_pair_top1: Number((top1 / PAIRS.length).toFixed(4)),
    field_pair_mrr: Number((mrrSum / PAIRS.length).toFixed(4)),
    topical_mrr_at_10: Number((mrrT / judged.length).toFixed(4)),
    topical_hit_at_1: Number((hit1 / judged.length).toFixed(4)),
    topical_ndcg_at_10: Number((ndcgSum / QUERIES.length).toFixed(4)),
    wrong_examples: wrong.slice(0, 3),
  };
}

console.log(`field pairs: ${PAIRS.length}   topical queries: ${QUERIES.length} (judged ${QUERIES.filter(isJudged).length})\n`);
const results = PROFILES.map(p => evalProfile(p.name, p.w, p.note));
for (const r of results) {
  console.log(`${r.profile.padEnd(15)} fieldTop1=${r.field_pair_top1.toFixed(3)} fieldMRR=${r.field_pair_mrr.toFixed(3)} | topicalMRR=${r.topical_mrr_at_10.toFixed(3)} topicalHit@1=${r.topical_hit_at_1.toFixed(3)} | ${r.note}`);
}

const flat = results[0], heavy = results[2];
const best = results.reduce((a, b) => (b.field_pair_top1 > a.field_pair_top1 ? b : a));
const spread = Math.max(...results.map(r => r.field_pair_top1)) - Math.min(...results.map(r => r.field_pair_top1));
console.log(`\nfield_pair_top1 spread across profiles: ${spread.toFixed(3)}`);
// Report the delta for the profile actually selected as best. This line used to print
// flat -> heavy (v2-title-heavy), i.e. 0.450 -> 0.850 = 0.400, while the chosen profile is
// v3-title-max at 0.900, so the real improvement is 0.450. Quoting 0.400 as "the" delta
// understated the result and contradicted runs/tuning.json.
console.log(`  flat ${flat.field_pair_top1} -> best ${best.profile} ${best.field_pair_top1} = delta ${(best.field_pair_top1 - flat.field_pair_top1).toFixed(3)}`);
console.log(`  (for reference, flat ${flat.field_pair_top1} -> ${heavy.profile} ${heavy.field_pair_top1} = delta ${(heavy.field_pair_top1 - flat.field_pair_top1).toFixed(3)}; not the selected profile)`);
console.log(`  topical MRR must not regress: flat ${flat.topical_mrr_at_10} vs best ${best.topical_mrr_at_10}`);

fs.writeFileSync('runs/tuning.json', JSON.stringify({
  generated_at: new Date().toISOString(),
  field_pairs: PAIRS.length, topical_queries: QUERIES.length,
  baseline: flat.profile, best: best.profile, best_weights: best.weights,
  delta_field_top1_best_vs_flat: Number((best.field_pair_top1 - flat.field_pair_top1).toFixed(4)),
  topical_mrr_regression: Number((flat.topical_mrr_at_10 - best.topical_mrr_at_10).toFixed(4)),
  all: results,
}, null, 1));
console.log(`\nbest: ${best.profile} ${JSON.stringify(best.weights)}`);