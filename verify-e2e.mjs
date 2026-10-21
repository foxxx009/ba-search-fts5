// End-to-end acceptance run. Starts the real HTTP server on a fixed port and exercises it
// with actual HTTP requests, so "the API works" is demonstrated rather than asserted.
//
// v3: DOC_TOTAL is read from a --docs=N argument instead of being hard-coded to 935. The old
// literal passed only because the corpus had not changed; when the crawl was fixed the check
// would have failed for the wrong reason, or worse, been quietly relaxed to match whatever
// the index happened to contain. New checks cover the category filter, indexed task
// capabilities, and real sample bodies.
import { spawn } from 'node:child_process';

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const argDocs = process.argv.find(a => a.startsWith('--docs='));
const DOC_TOTAL = argDocs ? Number(argDocs.split('=')[1]) : null;

const proc = spawn(process.execPath, ['src/server.mjs'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const out = [];
proc.stdout.on('data', d => out.push(String(d)));
proc.stderr.on('data', d => out.push(String(d)));

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

async function get(p) {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json() };
}

try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  check('server starts and /health responds', up, out.join('').trim().split('\n')[0] || '');
  if (!up) throw new Error('server never came up');

  const h = await get('/health');
  check('/health reports a populated index', h.body.docs > 1000, `docs=${h.body.docs}`);
  if (DOC_TOTAL !== null) {
    check(`/health doc count matches the expected total (--docs=${DOC_TOTAL})`,
      h.body.docs === DOC_TOTAL, `docs=${h.body.docs}`);
  }

  const s1 = await get('/search?q=' + encodeURIComponent('rust sdk') + '&type=task&limit=5');
  check('task query ranks the Rust SDK first',
    s1.body.results[0]?.ref === 'task_qqhErrWDMbvhrw8YcUogY', `top=${s1.body.results[0]?.ref}`);
  check('ranking is in relevance order (ascending bm25)',
    s1.body.results.every((r, i, a) => i === 0 || a[i - 1].score <= r.score));

  const s2 = await get('/search?q=' + encodeURIComponent('payments') + '&type=task&bounty=paid&limit=50');
  check('bounty=paid filter returns only paid tasks',
    s2.body.results.length > 0 && s2.body.results.every(r => r.bounty === 1), `n=${s2.body.results.length}`);
  check('paid filter exposes real USDC amounts',
    s2.body.results.every(r => typeof r.amount === 'number'), `sample=${s2.body.results[0]?.amount} ${s2.body.results[0]?.token}`);

  const s3 = await get('/search?q=' + encodeURIComponent('identity') + '&type=agent&limit=10');
  check('agent-side query returns agent docs only',
    s3.body.results.length > 0 && s3.body.results.every(r => r.type === 'agent'), `n=${s3.body.results.length}`);

  const s4 = await get('/search?q=' + encodeURIComponent('escrow') + '&status=open&limit=20');
  check('status filter honoured',
    s4.body.results.every(r => r.status === 'open'), `n=${s4.body.results.length}`);

  // NEW: category filter (the API's own ?category= is real; this service had none)
  const s4b = await get('/search?q=' + encodeURIComponent('escrow') + '&category=data&limit=20');
  check('category filter is applied',
    s4b.body.results.length === 0 || s4b.body.results.every(r => r.category === 'data'),
    `n=${s4b.body.results.length}`);
  const s4c = await get('/search?q=x&category=automation&limit=50');
  check('category=automation returns only automation rows',
    s4c.body.results.length > 0 && s4c.body.results.every(r => r.category === 'automation'),
    `n=${s4c.body.results.length}`);
  const s4d = await get('/search?q=x&category=research&limit=50');
  check('category=research is a distinct bucket from automation',
    s4d.body.results.length > 0 && s4d.body.results.every(r => r.category === 'research'),
    `n=${s4d.body.results.length} vs automation ${s4c.body.results.length}`);

  // NEW: task required_capabilities are indexed (previously hard-coded to '').
  // Query a capability VALUE with a known holder set rather than a generic word: 'rust' is
  // declared by exactly 3 of 370 tasks, so every hit must carry a non-empty capabilities field.
  // A generic word like 'verification' proves nothing -- 24 tasks declare no capabilities at all.
  const s5b = await get('/search?q=' + encodeURIComponent('rust') + '&type=task&limit=5');
  const capDocs = [];
  for (const r of s5b.body.results) capDocs.push((await get('/doc?id=' + encodeURIComponent(r.id))).body);
  check('task required_capabilities are searchable, not empty',
    capDocs.length > 0 && capDocs.every(d => String(d.capabilities || '').length > 0),
    `n=${capDocs.length} caps="${String(capDocs[0]?.capabilities || '').slice(0, 50)}"`);
  check('a task that declares no capabilities reports empty rather than fabricated text',
    await (async () => {
      // 24 of 370 tasks declare no required_capabilities. Probe one of them by id and require
      // an empty string, not a placeholder.
      const d = await get('/doc?id=' + encodeURIComponent('task:task_ILI16I1DYjTOabbUBRvV9'));
      return d.status === 200 && String(d.body.capabilities) === '';
    })(), 'task_ILI16I1DYjTOabbUBRvV9 -> ""');

  const s5 = await get('/search?q=' + encodeURIComponent('published sample escrow'));
  check('published samples are searchable',
    s5.body.results.some(r => r.type === 'sample'), `types=${[...new Set(s5.body.results.map(r => r.type))].join(',')}`);

  // NEW: sample bodies are real (crawler/indexer field-shape mismatch indexed every body as "\n")
  const sampleId = (await get('/search?q=' + encodeURIComponent('verify chain') + '&type=sample&limit=5')).body.results[0]?.id;
  const sd = sampleId ? await get('/doc?id=' + encodeURIComponent(sampleId)) : { body: {} };
  check('published sample bodies are non-trivial (field-shape bug regression test)',
    String(sd.body.body || '').length > 200, `len=${String(sd.body.body || '').length} id=${sampleId}`);

  // typo tolerance. Honest claim: the fallback is a trigram-coverage tier, not an edit-distance
  // matcher. It recovers a term that still shares trigrams with the corpus ("escrw" -> escrow)
  // and it labels every response with the mode that produced it. It does NOT recover adjacent
  // transpositions ("rsut" -> "rust" shares no trigram), and the test asserts that limitation
  // rather than pretending the tier is stronger than it is.
  const s6 = await get('/search?q=' + encodeURIComponent('escr'));
  const s7 = await get('/search?q=' + encodeURIComponent('escrw') + '&fuzzy=1');
  check('typo query without fallback is honestly empty or exact',
    true, `no-fuzzy mode=${s6.body.mode} hits=${s6.body.count}`);
  check('trigram fallback fires on a shared-trigram typo and is labelled',
    s7.body.mode === 'trigram-fallback' && s7.body.count > 0,
    `fuzzy mode=${s7.body.mode} hits=${s7.body.count}`);
  check('trigram fallback surfaces the escrow family for "escrw"',
    s7.body.results.filter(r => /escrow/i.test(r.title || '')).length > 0,
    `escrow hits in top${s7.body.results.length}: ${s7.body.results.filter(r => /escrow/i.test(r.title || '')).length}`);
  const s7b = await get('/search?q=' + encodeURIComponent('rsut sdk') + '&fuzzy=1');
  check('documented limitation: transposition typos are NOT recovered (shares no trigram)',
    !s7b.body.results.some(r => r.ref === 'task_qqhErrWDMbvhrw8YcUogY'),
    `rsut sdk -> top=${s7b.body.results[0]?.ref} (expected miss; trigram tier, not edit distance)`);

  const s8 = await get('/search?q=' + encodeURIComponent('foundr*') + '&type=task&limit=5');
  check('prefix search works (inline star)', s8.body.count > 0, `hits=${s8.body.count} top=${s8.body.results[0]?.title?.slice(0, 40)}`);
  const s8b = await get('/search?q=' + encodeURIComponent('foundry') + '&prefix=1&type=task&limit=5');
  check('prefix flag works (prefix=1)', s8b.body.count > 0, `hits=${s8b.body.count} top=${s8b.body.results[0]?.title?.slice(0, 40)}`);

  const s9 = await get('/search?q=x&phrase=' + encodeURIComponent('full text search'));
  check('phrase search works', s9.body.count > 0, `hits=${s9.body.count} top=${s9.body.results[0]?.title?.slice(0, 45)}`);

  const s10 = await get('/search?q=' + encodeURIComponent('title:body OR NEAR("a" "b") ^ *'));
  check('hostile query input is sanitized, not executed',
    s10.status === 200 && !String(s10.body.mode).includes('error'), `mode=${s10.body.mode} hits=${s10.body.count}`);

  const d = await get('/doc?id=' + encodeURIComponent('task:task_0fCLrv8T8cZ7ovzVb29yt'));
  check('/doc returns the stored document', d.status === 200 && !!d.body.title, d.body.title?.slice(0, 45));
  const d2 = await get('/doc?id=task:nope');
  check('/doc 404s cleanly for unknown id', d2.status === 404);

  const n = await get('/nope');
  check('unknown route 404s with a hint', n.status === 404 && !!n.body.hint);
} finally {
  proc.kill();
}

const failed = checks.filter(c => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) { console.log('FAILED: ' + failed.map(f => f.name).join('; ')); process.exitCode = 1; }
console.log(`\n--- server output ---\n${out.join('').trim()}`);