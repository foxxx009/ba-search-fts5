// Relevance evaluation: 25 judged queries, MRR@10 + graded nDCG@10.
// Usage: node src/eval.mjs '{"title":5,...}' label
//
// v3: every query carries expected_top3, so all 25 are judged (v2 judged only 18 because 7
// agent-side queries had expect:null) and gains are graded 3/1 instead of 1/1 (v2 gave every
// returned document gain 1, so nDCG could not distinguish a good ranking from a bad one).
import fs from 'node:fs';
import { open, search } from './search.mjs';
import { QUERIES, rr, dcg, isJudged, targetsOf } from './evalset.mjs';

const weights = process.argv[2] && process.argv[2].startsWith('{') ? JSON.parse(process.argv[2]) : null;
const label = process.argv[3] || (weights ? 'custom' : 'index-default');
const db = open();

const rows = [];
for (const q of QUERIES) {
  const r = search(db, { q: q.q, type: q.type, bounty: q.bounty || '', limit: 10, weights });
  const judged = isJudged(q);
  const targets = targetsOf(q);
  const mrr = judged ? rr(r.results, q) : null;
  // graded gains: 3 for a member of expected_top3, 1 for any other returned doc
  const gains = r.results.slice(0, 10).map(x => (q.top3.includes(x.ref) ? 3 : 1));
  const idealHits = Math.min(q.top3.length, 10);
  const ideal = judged
    ? dcg([...Array(idealHits).fill(3), ...Array(10 - idealHits).fill(1)])
    : dcg(Array(10).fill(1));
  const ndcg = ideal > 0 ? dcg(gains) / ideal : 0;
  const top3 = r.results.slice(0, 3).map(x => x.ref);
  rows.push({
    id: q.id, query: q.q, type: q.type, bounty_filter: q.bounty || '', judged,
    expected_top3: q.top3,
    judged_family: q.family || null,
    achieved_top3: top3,
    top3_overlap: top3.filter(x => q.top3.includes(x)).length,
    top3_exact_order_match: top3.length === 3 && top3.every((x, i) => x === q.top3[i]),
    achieved_top1_title: r.results[0]?.title || null,
    mode: r.mode,
    mrr_at_10: mrr === null ? 'n/a' : Number(mrr.toFixed(4)),
    hit_at_1: judged ? (r.results[0] && targets.has(r.results[0].ref)) : 'n/a',
    ndcg_at_10: Number(ndcg.toFixed(4)),
    why: q.why,
  });
}

const judgedRows = rows.filter(r => r.judged);
const agg = {
  label,
  weights: weights || JSON.parse(db.prepare('SELECT v FROM meta WHERE k=?').get('weights').v),
  queries_total: rows.length,
  queries_judged: judgedRows.length,
  mrr_at_10: Number((judgedRows.reduce((s, r) => s + r.mrr_at_10, 0) / judgedRows.length).toFixed(4)),
  hit_at_1: Number((judgedRows.filter(r => r.hit_at_1).length / judgedRows.length).toFixed(4)),
  recall_at_10: Number((judgedRows.filter(r => r.mrr_at_10 > 0).length / judgedRows.length).toFixed(4)),
  ndcg_at_10_mean: Number((rows.reduce((s, r) => s + r.ndcg_at_10, 0) / rows.length).toFixed(4)),
  mean_top3_overlap: Number((rows.reduce((s, r) => s + r.top3_overlap, 0) / rows.length).toFixed(3)),
  exact_top3_order_matches: rows.filter(r => r.top3_exact_order_match).length,
  gain_scale: 'graded 3 = expected_top3 member, 1 = other returned, 0 = not returned',
};

fs.mkdirSync('runs', { recursive: true });
fs.writeFileSync(`runs/eval-${label}.json`, JSON.stringify({ aggregate: agg, queries: rows }, null, 1));
console.log(JSON.stringify(agg, null, 1));
for (const r of judgedRows) if (r.mrr_at_10 === 0) console.log(`  MISS ${r.id} "${r.query}" -> top1=${(r.achieved_top1_title || '').slice(0, 60)}`);