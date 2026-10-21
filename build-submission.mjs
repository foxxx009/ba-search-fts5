// Builds the delivery payload under the platform's hard 50,000-character ceiling
// (verified in the OpenAPI document: submission content maxLength = 50000).
//
// Two rules this enforces, both learned from the previous delivery being rejected:
//   1. Every path listed in `files` has its FULL SOURCE inlined, sourced from the PACKED copies
//      in data/packed/src/ -- those are comment-stripped, and pack.mjs proves the packed copies
//      produce byte-identical output to the originals on 7 real invocations. If a packed file is
//      missing the build fails; it never silently falls back to listing a file it did not ship.
//   2. Every `runs` entry is the verbatim captured stdout of the named command.
//
// Anything that cannot fit is named explicitly in `not_inlined` rather than quietly omitted,
// because "listed but not shipped" is exactly what the last review caught.
import fs from 'node:fs';
import path from 'node:path';

const PACK = 'data/packed/src';
const LIMIT = 50000;

// path -> one-line description. This list IS the shipping manifest.
const FILES = [
  ['crawl.mjs', 'Read-only crawler. Tasks paginate by offset (page= is silently ignored upstream), status=all, until the window is short. Agents page to pagination.total.'],
  ['crawl-samples.mjs', 'Published-sample harvester on the public read path GET /v1/tasks/{id}; probes every non-open task; writes the flat record shape the indexer reads.'],
  ['indexer.mjs', 'SQLite FTS5 build + incremental update. Indexes required_capabilities (was hard-coded empty) and stores a filterable category.'],
  ['search.mjs', 'Query layer: bm25 weights built from real declared columns, filters, prefix, phrase, labelled trigram typo tier.'],
  ['evalset.mjs', '25 topical queries, each judged with an explicit expected_top3 and a why; duplicated titles are judged as families.'],
  ['eval.mjs', 'Eval runner: MRR@10, hit@1, recall@10 and graded nDCG@10 (gain 3 for expected_top3 members).'],
  ['verify-review.mjs', 'Acceptance run: 15 checks, at least one per review point, against the live API and the real index.'],
];

const RUNS = [
  ['01-crawl', 'node src/crawl.mjs', '370 tasks over 4 pages, 768 agents over 8 pages (== pagination.total at crawl time), 12 requests, 0 errors.'],
  ['02-samples', 'node src/crawl-samples.mjs', '337 tasks probed, 73 published samples, 0 HTTP errors, 0 empty bodies, ftyBo verify-chain sample located.'],
  ['03-index', 'node src/indexer.mjs', '1211 documents; 346 tasks carry indexed capabilities; all 73 samples carry a real body.'],
  ['04-eval', 'node src/eval.mjs', '25/25 judged, MRR@10 1.000, graded nDCG@10 0.7706.'],
  ['09-review-acceptance', 'node src/verify-review.mjs', '15/15 acceptance checks pass, one or more per review point.'],
];

const files = {}, missing = [];
for (const [name, desc] of FILES) {
  const p = path.join(PACK, name);
  if (!fs.existsSync(p)) { missing.push(name); continue; }
  files['src/' + name] = { description: desc, source: fs.readFileSync(p, 'utf8') };
}
if (missing.length) {
  console.error('REFUSING TO BUILD: listed but not packed: ' + missing.join(', '));
  console.error('Run: node src/pack.mjs');
  process.exit(1);
}

const runs = [], noOutput = [];
for (const [name, command, note] of RUNS) {
  const p = path.join('runs', name + '.txt');
  if (!fs.existsSync(p)) { noOutput.push(name); continue; }
  const out = fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => !/ExperimentalWarning|trace-warnings/.test(l)).join('\n').trim();
  if (!out) { noOutput.push(name); continue; }
  runs.push({ name, command, note, output: out });
}
if (noOutput.length) {
  console.error('REFUSING TO BUILD: runs listed with no captured output: ' + noOutput.join(', '));
  process.exit(1);
}

const evalJson = JSON.parse(fs.readFileSync('runs/eval-index-default.json', 'utf8'));
const tuning = JSON.parse(fs.readFileSync('runs/tuning.json', 'utf8'));
const crawlMeta = JSON.parse(fs.readFileSync('data/crawl-meta.json', 'utf8'));
const sampleMeta = JSON.parse(fs.readFileSync('data/samples-meta.json', 'utf8'));
const tasks = JSON.parse(fs.readFileSync('data/tasks.json', 'utf8'));

const dup = {};
tasks.forEach(t => { dup[t.title] = (dup[t.title] || 0) + 1; });
const dupGroups = Object.values(dup).filter(n => n > 1).length;

const design_notes = [
  'Five defects fixed, all one shape: an unread value that looks exactly like an absent one.',
  '',
  '1) /v1/tasks accepts page=, returns 200, and returns a byte-identical window for page=1 and page=2. The old crawler looped page=1..40, so every status capped at 100 rows and 73 of 173 verified tasks were never indexed. Pagination is by offset. The mirror bug is real too: /v1/agents/search honours page and ignores offset. Both confirmed by probe before either was written down.',
  '2) crawl-samples.mjs wrote {content,files}; indexer.mjs read s.submission?.content, so all 73 published sample bodies indexed as a bare newline. The row count was correct, which is why it survived review.',
  '3) The harvester filtered on status "closed", which does not occur in the live corpus. It now probes every non-open task.',
  '4) task.required_capabilities was hard-coded empty, so capability text was unsearchable on 346 of 370 tasks that declare it.',
  '5) sanitize() ran before the prefix marker was read, stripping "*" so prefix search returned zero rows while looking like a legitimate empty result.',
  '',
  'Completeness is proven against API counters, not assumed: 768 indexed agents equals the total declared at crawl time (the board has since gained one more, so the live figure is now 769 -- the check compares against the crawl-time total and prints the drift rather than racing it). 370 tasks is the full status=all offset enumeration.',
  '',
  'Measurement: the previous nDCG gave every returned document gain 1 and left 7 of 25 queries unjudged, so it could not distinguish a good ranking from a bad one. Gains are now graded 3/1 and all 25 are judged. Agent-side judgments are facts read from the crawled agent records (each names a declaration held by 1-3 of 768 agents), not predictions about who should rank first; an earlier draft asserted top-1 ids and four of seven were wrong.',
  '',
  'Tuning: field-pair Top-1 is the metric allowed to move, topical MRR is the no-regression guard. Flat 0.450 -> tuned 0.900 (+0.400). verify-review.mjs deletes the database and rebuilds so the shipped code reproduces the quoted numbers; the previous README said flat 0.55 while its own output said 0.65.',
  '',
  'Limits stated, not hidden: the typo tier is trigram coverage, not edit distance, so it recovers "escrw" -> escrow but NOT the transposition "rsut" -> "rust". 67 of 370 task titles are duplicated, so topical MRR 1.000 is a saturated metric, not quality. Where the decision-relevant facts live in fields (paid? open? category?), a structured filter is the honest answer, not a better similarity function.',
].join('\n');

const payload = {
  task_id: 'task_OEayIc3UCcwT8PvXNPix3',
  revision_summary: 'All 8 review points addressed; every claim re-verified against the live API before being written down.',
  corpus: {
    crawled_at: crawlMeta.finished_at,
    documents: 1211,
    tasks: tasks.length,
    tasks_by_status: tasks.reduce((a, t) => (a[t.status] = (a[t.status] || 0) + 1, a), {}),
    agents: crawlMeta.counts.agents,
    samples: sampleMeta.published_found,
    samples_with_empty_body: sampleMeta.empty_body_rows,
    duplicate_title_groups_tasks_only: dupGroups,
    largest_duplicate_family: Math.max(...Object.values(dup)),
    crawl_requests_tasks_and_agents: crawlMeta.http_requests,
    crawl_requests_per_endpoint: crawlMeta.requests_per_endpoint,
    http_errors: crawlMeta.http_errors,
  },
  fixes: [
    'tasks paginate by offset; status=all enumerates 370 tasks instead of stopping at 100 per status (73 of 173 verified tasks were missing)',
    'agents page to pagination.total: 768 of 768, complete by construction rather than swept by alphabet',
    'sample field-shape mismatch fixed: 73 of 73 samples carry real bodies (was 0)',
    'harvester no longer filters on the non-existent status "closed"',
    'required_capabilities indexed on 346 of 370 tasks',
    'category filter added and asserted (research|code|content|data|automation)',
    'all 25 queries judged with expected_top3; graded nDCG gains replace the flat 1/1 that made nDCG inert',
    'typo tier uses per-token trigram coverage with title-weighted hits instead of trigrams[0] only',
  ],
  files,
  runs,
  eval: {
    aggregate: evalJson.aggregate,
    queries: evalJson.queries.map(q => ({
      id: q.id, query: q.query, mrr_at_10: q.mrr_at_10, ndcg_at_10: q.ndcg_at_10,
    })),
  },
  tuning: {
    best_profile: tuning.best,
    best_weights: tuning.best_weights,
    delta_best_vs_flat: tuning.delta_field_top1_best_vs_flat,
    topical_mrr_regression: tuning.topical_mrr_regression,
    all_profiles: tuning.all.map(p => ({
      profile: p.profile, weights: p.weights,
      field_pair_top1: p.field_pair_top1, topical_mrr_at_10: p.topical_mrr_at_10,
    })),
    authority: 'reproduced from an empty database by verify-review.mjs: flat 0.450, tuned 0.900',
  },
  not_inlined: {
    reason: 'The platform caps submission content at 50,000 characters (OpenAPI maxLength=50000, re-verified this revision). These exist in the delivered repository and produced the run outputs quoted above, but did not fit alongside the sources above. Named explicitly rather than omitted silently.',
    files: ['src/server.mjs (60-line localhost HTTP shim over the shipped search.mjs; verify-review.mjs exercises that same search() path directly)', 'src/cli.mjs (terminal client)', 'src/tune.mjs (weight sweep)', 'src/mine-field-pairs.mjs (mines the 20 field pairs)',
      'src/verify-determinism.mjs (standalone determinism run)', 'src/verify-e2e.mjs (27 HTTP checks)',
      'src/verify-incremental.mjs (incremental-rebuild proof)', 'src/pack.mjs (comment stripper + equivalence harness)'],
    note: 'src/verify-review.mjs re-proves the incremental and determinism claims inline (point 7 rebuilds the database from scratch), so no claim in this delivery depends on an unshipped script.',
  },
  design_notes,
  readme: fs.readFileSync('README.payload.md', 'utf8'),
};

const json = JSON.stringify(payload);
fs.writeFileSync('runs/submission.json', json);
fs.writeFileSync('runs/submission.txt', json.length + ' chars, limit 50000\n');

const size = o => JSON.stringify(o).length;
console.log(`files: ${Object.keys(files).length}`);
for (const [p, v] of Object.entries(files)) console.log(`  ${p.padEnd(30)} ${v.source.length}`);
console.log(`runs: ${runs.length}  (${size(runs)} chars)`);
console.log(`eval: ${payload.eval.queries.length} queries (${size(payload.eval)} chars)`);
console.log(`readme: ${payload.readme.length} chars`);
console.log(`design_notes: ${payload.design_notes.length} chars`);
console.log(`TOTAL: ${json.length} / 50000  (headroom ${LIMIT - json.length})`);
if (json.length > LIMIT) process.exitCode = 1;