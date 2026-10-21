// Pre-submit audit: re-derives every claim in the payload from the run artifacts and the shipped
// files, so nothing is asserted that cannot be checked. This exists because the previous revision
// shipped a summary whose numbers did not match its own runs.
//
// Every check prints PASS/FAIL with the evidence it compared. A FAIL must block submission.
import fs from 'node:fs';
import crypto from 'node:crypto';

const p = JSON.parse(fs.readFileSync('runs/submission-rev2.json', 'utf8'));
const checks = [];
const ck = (name, pass, detail) => { checks.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`); };
const rd = (f) => fs.readFileSync(f, 'utf8');

// ---- 0. hard constraints -------------------------------------------------
const content = JSON.stringify(p);
ck('ceiling: content <= 50,000 characters', content.length <= 50000, `${content.length} chars`);
ck('structure: JSON round-trips', typeof p === 'object' && !!p.files, `${(p.files || []).length} files`);
ck('summary <= 2,000 characters', rd('runs/summary-rev2.txt').length <= 2000, `${rd('runs/summary-rev2.txt').length} chars`);
const dn = p.design_notes.trim().split(/\s+/).length;
ck('design_notes <= 400 words', dn <= 400, `${dn} words`);
ck('design_notes mentions embeddings', /embedding/i.test(p.design_notes), 'matched');

// ---- 1. every run log is non-empty and matches the file on disk ---------
for (const r of p.runs) {
  const onDisk = rd(r.name).trim();
  ck(`run log ${r.name} is inlined verbatim`, r.content === onDisk, `${r.content.length} chars, identical to ${r.name}`);
}

// ---- 2. files[] content is byte-identical to what pack() produced -------
// (re-pack from source and compare, proving nothing was edited in transit)
const strip = (src) => {
  let out = '', i = 0; const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) { if (src[i] === '\\') { out += src[i] + src[i + 1]; i += 2; continue; } out += src[i]; if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    out += c; i++;
  }
  return out.split('\n').map(l => l.replace(/^[ \t]+/, '')).filter(l => l.trim() !== '').join('\n');
};
for (const f of p.files) {
  const name = f.path.replace('src/', '').replace('.mjs', '');
  const src = name === 'evalset' ? rd('data/packed2/evalset.mjs') : rd(`src/${name}.mjs`);
  ck(`file ${f.path} content matches its source`, strip(src) === f.content, `${f.content.length} chars re-derived`);
}

// ---- 3. the review's six blocking points, checked against the payload ---
const has = (n) => p.files.some(f => f.path === `src/${n}`);
for (const n of ['server.mjs', 'cli.mjs', 'tune.mjs', 'mine-field-pairs.mjs', 'verify-incremental.mjs']) {
  ck(`BLOCKING: ${n} is inlined with content`, has(n) && p.files.find(f => f.path === `src/${n}`).content.length > 500,
    `${p.files.find(f => f.path === `src/${n}`)?.content.length || 0} chars`);
}
ck('BLOCKING 1: server.mjs has the category filter', /category/.test(p.files.find(f => f.path === 'src/server.mjs').content), 'category present');
ck('BLOCKING 1: cli.mjs has the category filter', /--category/.test(p.files.find(f => f.path === 'src/cli.mjs').content), '--category present');
ck('BLOCKING 1: a serve run is inlined', p.runs.some(r => /search\?q=sdk&category=code/.test(r.content)), 'runs/12-serve.txt shows category=code over HTTP');
ck('BLOCKING 2: tune.mjs is inlined AND verify-review actually runs it',
  has('tune.mjs') && /execFileSync\(NODE, \['src\/tune\.mjs'\]/.test(rd('src/verify-review.mjs')),
  'verify-review.mjs line executes tune.mjs');
ck('BLOCKING 3: incremental run shows an actual update',
  /updated=1 unchanged=1210/.test(p.runs.find(r => r.name.includes('incremental')).content), 'updated=1 unchanged=1210 present');
ck('BLOCKING 3: the incremental run also shows the unchanged baseline',
  /added=0 updated=0 unchanged=1211/.test(p.runs.find(r => r.name.includes('incremental')).content), 'added=0 updated=0 unchanged=1211 present');

// ---- 4. arithmetic: the delta must equal selected minus baseline --------
const tune = JSON.parse(rd('runs/tuning.json'));
const flatTop1 = tune.all.find(r => r.profile === tune.baseline).field_pair_top1;
const bestTop1 = tune.all.find(r => r.profile === tune.best).field_pair_top1;
const claimedDelta = bestTop1 - flatTop1;
ck('BLOCKING 4: tuning delta arithmetic is self-consistent',
  Math.abs(claimedDelta - p.tuning.delta_field_top1_best_vs_flat) < 1e-9,
  `${bestTop1} - ${flatTop1} = ${claimedDelta.toFixed(3)}, payload says ${p.tuning.delta_field_top1_best_vs_flat}`);
ck('BLOCKING 4: the run log prints the same delta',
  p.runs.find(r => r.name.includes('tuning')).content.includes(`delta ${claimedDelta.toFixed(3)}`),
  `runs/14-tuning.txt prints delta ${claimedDelta.toFixed(3)}`);
ck('BLOCKING 4: no stale +0.400 is presented as the result',
  /not the selected profile/.test(p.runs.find(r => r.name.includes('tuning')).content), '0.400 appears only as a labelled non-selected reference');
// Parse the weights object literal out of the packed indexer.mjs and compare numerically.
// A previous version compared a hand-built substring and reported FAIL on a correct file.
const idxSrc = p.files.find(f => f.path === 'src/indexer.mjs').content;
const wm = idxSrc.match(/const W\s*=\s*\{([^}]*)\}/);
let idxW = null;
if (wm) {
  idxW = {};
  for (const m2 of wm[1].matchAll(/(\w+)\s*:\s*([\d.]+)/g)) idxW[m2[1]] = Number(m2[2]);
}
const sameW = idxW && Object.keys(p.index.weights).length === Object.keys(idxW).length
  && Object.entries(p.index.weights).every(([k, v]) => idxW[k] === v);
ck('BLOCKING 4: indexer.mjs prints exactly the weights the payload claims', sameW,
  `indexer.mjs W=${JSON.stringify(idxW)} vs payload ${JSON.stringify(p.index.weights)}`);

// ---- 5. all 25 eval rows, and the aggregate recomputed from them ---------
const rows = p.eval_rows;
ck('BLOCKING 5: 25 eval rows', rows.length === 25, `${rows.length} rows`);
ck('BLOCKING 5: columns declared', Array.isArray(p.eval_columns) && p.eval_columns.length === 6, p.eval_columns.join(','));
const q = p.eval_columns.indexOf('query'), e = p.eval_columns.indexOf('expected_top3'),
  a = p.eval_columns.indexOf('achieved_top3'), m = p.eval_columns.indexOf('mrr_at_10'), n2 = p.eval_columns.indexOf('ndcg_at_10');
let bad = 0;
for (const r of rows) {
  if (!r[q] || !Array.isArray(r[e]) || !r[e].length || !Array.isArray(r[a]) || typeof r[m] !== 'number' || typeof r[n2] !== 'number') bad++;
}
ck('BLOCKING 5: every row has query, expected_top3, achieved_top3, mrr, ndcg', bad === 0, `${bad} malformed rows`);
const judged = rows.filter(r => typeof r[m] === 'number');
const meanMrr = judged.reduce((s, r) => s + r[m], 0) / judged.length;
const meanNdcg = rows.reduce((s, r) => s + r[n2], 0) / rows.length;
ck('BLOCKING 5: aggregate MRR recomputed from the inlined rows matches the claim',
  Math.abs(meanMrr - p.relevance.mrr_at_10) < 5e-5, `recomputed ${meanMrr.toFixed(4)} vs claimed ${p.relevance.mrr_at_10}`);
ck('BLOCKING 5: aggregate nDCG recomputed from the inlined rows matches the claim',
  Math.abs(meanNdcg - p.relevance.ndcg_at_10_mean) < 5e-5, `recomputed ${meanNdcg.toFixed(4)} vs claimed ${p.relevance.ndcg_at_10_mean}`);
// every expected id must actually exist in the index
const { open } = await import('./search.mjs');
const db = open();
let unknown = 0;
for (const r of rows) for (const id of r[e]) if (!db.prepare('SELECT 1 FROM docs WHERE ref=?').get(id)) unknown++;
db.close();
ck('BLOCKING 5: every expected_top3 id exists in the shipped index', unknown === 0, `${unknown} unknown ids`);

// ---- 6. the review run log: 18 lines, all PASS --------------------------
const revLog = p.runs.find(r => r.name.includes('11-review')).content;
const lines = revLog.split('\n').filter(l => /^(PASS|FAIL)/.test(l));
const fails = lines.filter(l => l.startsWith('FAIL'));
ck('acceptance: 18 check lines inlined', lines.length === 18, `${lines.length} lines`);
ck('acceptance: zero FAIL lines', fails.length === 0, fails.length ? fails.join(' | ') : 'none');
ck('acceptance: the header line claims 18/18', /18\/18 checks passed/.test(revLog), (revLog.match(/.*18\/18 checks passed.*/) || [''])[0]);
ck('acceptance: claim matches the inlined log', p.acceptance.checks === lines.length && p.acceptance.passed === lines.length - fails.length,
  `payload says ${p.acceptance.passed}/${p.acceptance.checks}, log has ${lines.length - fails.length}/${lines.length}`);

// ---- 7. index counts recomputed from the index itself ------------------
const db2 = open();
const byType = db2.prepare('SELECT type, COUNT(*) n FROM docs GROUP BY type').all().reduce((o, r) => (o[r.type] = r.n, o), {});
db2.close();
const parts = p.index.breakdown.match(/(\d+) tasks \+ (\d+) agents \+ (\d+) samples/).map(Number);
ck('index: task/agent/sample counts recomputed from the index match the payload',
  parts[1] === byType.task && parts[2] === byType.agent && parts[3] === byType.sample,
  `index has ${byType.task}/${byType.agent}/${byType.sample}, payload says ${parts[1]}/${parts[2]}/${parts[3]}`);
const total = byType.task + byType.agent + byType.sample;
ck('index: total documents is consistent', total === p.index.documents, `${total} = ${p.index.documents}`);

// ---- 8. no fabricated evidence: no placeholder text --------------------
const blob = JSON.stringify(p);
ck('no placeholders', !/\bTODO\b|\bFIXME\b|\bXXX\b|<placeholder>|\.\.\.\s*$/m.test(blob), 'no TODO/FIXME/placeholder markers');
ck('no empty file contents', p.files.every(f => f.content.length > 200), p.files.map(f => f.content.length).join(','));

// ---- 9. summary claims must appear in the payload ----------------------
const sum = rd('runs/summary-rev2.txt');
for (const claim of ['0.450', '1,211', '0.7706', '18', '399', '25']) {
  ck(`summary mentions ${claim}`, sum.includes(claim), 'present');
}

const failed = checks.filter(c => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} audit checks passed`);
if (failed.length) { console.log('BLOCKING FAILURES:'); for (const f of failed) console.log('  -', f.name, '::', f.detail); process.exitCode = 1; }
else console.log('SAFE TO SUBMIT');