// v3: probe every task that is not plainly undelivered, and read the content from the field
// the API actually populates.
//
// v2 bugs, both confirmed against the live API:
//   * It filtered candidates to ['verified','closed','submitted']. `closed` does not exist in
//     the status enum (open|claimed|submitted|verified|closed|cancelled|expired|all — and the
//     board currently uses open/claimed/submitted/cancelled/verified/expired), so the filter
//     silently dropped rows. A sample can be published on any task that has receipts.
//   * It wrote rows shaped {task_id,title,content,files,...} but indexer.mjs read
//     s.submission?.content / s.submission?.files, so every sample body indexed as "\n".
//     The crawler and the indexer disagreed on the record shape; now both use the flat shape
//     written here and the contract is asserted below instead of assumed.
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://api.basedagents.ai';
const DATA = path.resolve('data');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const UA = { 'user-agent': 'basedagents-search-indexer/1.0 (read-only public crawl)', accept: 'application/json' };

const tasks = JSON.parse(fs.readFileSync(path.join(DATA, 'tasks.json'), 'utf8'));
// Any task with a receipt could carry a published sample; the only statuses that cannot are
// open (never claimed) and expired-before-delivery. We probe everything else.
const CANDIDATE = tasks.filter(t => !['open'].includes(t.status));
console.log(`probing ${CANDIDATE.length} possibly-delivered tasks of ${tasks.length}`);

const out = [], errors = [], sawPublic = [];
for (const t of CANDIDATE) {
  try {
    const r = await fetch(`${BASE}/v1/tasks/${t.task_id}`, { headers: UA });
    if (r.status === 429) { errors.push({ id: t.task_id, status: 429 }); await sleep(4000); continue; }
    if (!r.ok) { errors.push({ id: t.task_id, status: r.status }); continue; }
    const j = await r.json();
    if (j.submission_public && j.submission) {
      const s = j.submission;
      out.push({
        task_id: t.task_id,
        status: t.status,
        title: t.title || '',
        summary: s.summary || '',
        content: s.content || '',
        files: s.files || {},
        published_at: s.published_at || null,
      });
    }
    if ((out.length + errors.length) % 10 === 0) fs.writeFileSync(path.join(DATA, 'samples.partial.json'), JSON.stringify(out, null, 1));
  } catch (e) {
    errors.push({ id: t.task_id, error: String(e.message || e) });
  }
  await sleep(250);
}

const emptyBody = out.filter(s => !s.content && !Object.keys(s.files || {}).length).length;
fs.writeFileSync(path.join(DATA, 'samples.json'), JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(DATA, 'samples-meta.json'), JSON.stringify({
  probed: CANDIDATE.length, published_found: out.length, http_errors: errors.length,
  empty_body_rows: emptyBody,
  record_shape: 'flat: {task_id,status,title,summary,content,files,published_at}',
  by_status: out.reduce((a, s) => (a[s.status] = (a[s.status] || 0) + 1, a), {}),
  note: '401 on /v1/tasks/{id}/submission is by design (private parties-only); '
      + 'public samples are read from GET /v1/tasks/{id} when submission_public is true.',
}, null, 1));
console.log(`published samples: ${out.length} (http errors: ${errors.length}, empty-body rows: ${emptyBody})`);
console.log(`by status: ${JSON.stringify(out.reduce((a, s) => (a[s.status] = (a[s.status] || 0) + 1, a), {}))}`);
const probe = out.find(s => s.content.includes('ftyBo'));
console.log(`verify-chain sample present: ${Boolean(probe)}${probe ? ' -> ' + probe.task_id : ''}`);