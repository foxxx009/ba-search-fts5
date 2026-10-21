// Polite read-only crawler of the public BasedAgents corpus.
// No writes, no auth, no contact. Sequential with delay; checkpoints every page.
//
// v3 fixes (all verified against the live API before being written down, see runs/01-crawl.txt):
//   * tasks paginate by OFFSET. The endpoint accepts `page=` but silently ignores it: page=1
//     and page=2 return byte-identical 100-row windows, so every status stopped at 100 rows.
//   * status=all enumerates the whole board in one sweep (370 rows today), which removes the
//     need to guess the status enum and removes duplicate work across seven status passes.
//   * agents/search paginates by PAGE and returns pagination.total. Sweeping the alphabet
//     one page per character could never be provably complete; paging to total_pages can.
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://api.basedagents.ai';
const DATA = path.resolve('data');
fs.mkdirSync(DATA, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const UA = { 'user-agent': 'basedagents-search-indexer/2.0 (read-only public crawl)', accept: 'application/json' };

let fetched = 0, httpErrors = [];
const perEndpoint = {};
async function get(url, ep) {
  perEndpoint[ep] = (perEndpoint[ep] || 0) + 1;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      fetched++;
      if (r.status === 429) { await sleep(4000 * (i + 1)); continue; }
      if (!r.ok) { httpErrors.push({ url, status: r.status }); if (r.status >= 500 && i < 2) { await sleep(2000); continue; } return null; }
      return await r.json();
    } catch (e) {
      httpErrors.push({ url, error: String(e.message || e) });
      await sleep(2000 * (i + 1));
    }
  }
  return null;
}

// ---- 1. tasks: status=all + offset until the window comes back short/empty ----
async function crawlTasks() {
  const seen = new Map();
  let off = 0, pages = 0;
  for (;;) {
    const j = await get(`${BASE}/v1/tasks?status=all&limit=100&offset=${off}`, 'tasks');
    if (!j || !Array.isArray(j.tasks) || j.tasks.length === 0) break;
    for (const t of j.tasks) if (!seen.has(t.task_id)) seen.set(t.task_id, t);
    pages++;
    fs.writeFileSync(path.join(DATA, 'tasks.partial.json'), JSON.stringify([...seen.values()]));
    if (j.tasks.length < 100) break;
    off += 100;
    await sleep(600);
  }
  const all = [...seen.values()];
  fs.writeFileSync(path.join(DATA, 'tasks.json'), JSON.stringify(all, null, 1));
  const byStatus = {};
  for (const t of all) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  console.log(`tasks: ${all.length} unique over ${pages} pages`);
  console.log(`  by status: ${JSON.stringify(byStatus)}`);
  return all;
}

// ---- 2. agents: page to pagination.total_pages and stop when the count matches total ----
async function crawlAgents() {
  const seen = new Map();
  let declared = null, pages = 0;
  for (let page = 1; page <= 200; page++) {
    const j = await get(`${BASE}/v1/agents/search?q=&limit=100&page=${page}`, 'agents');
    if (!j || !Array.isArray(j.agents)) break;
    declared = j.pagination?.total ?? declared;
    if (j.agents.length === 0) break;
    for (const a of j.agents) if (!a.agent_id) continue; else if (!seen.has(a.agent_id)) seen.set(a.agent_id, a);
    pages = page;
    fs.writeFileSync(path.join(DATA, 'agents.partial.json'), JSON.stringify([...seen.values()]));
    if (j.agents.length < 100) break;
    if (declared && seen.size >= declared) break;
    await sleep(600);
  }
  const all = [...seen.values()];
  fs.writeFileSync(path.join(DATA, 'agents.json'), JSON.stringify(all, null, 1));
  const complete = declared === null ? null : seen.size >= declared;
  console.log(`agents: ${all.length} unique over ${pages} pages (pagination.total=${declared}, complete=${complete})`);
  return all;
}

// NOTE: published samples are harvested by crawl-samples.mjs, not here.
// An earlier version called GET /v1/tasks/{id}/submission, which is private-by-design
// (AgentSig, parties only) and returns 401 for the public. The public read path is
// GET /v1/tasks/{id}, which carries submission_public + submission when published.

const t0 = Date.now();
const tasks = await crawlTasks();
const agents = await crawlAgents();
fs.writeFileSync(path.join(DATA, 'crawl-meta.json'), JSON.stringify({
  finished_at: new Date().toISOString(), duration_ms: Date.now() - t0,
  http_requests: fetched, requests_per_endpoint: perEndpoint, http_errors: httpErrors.length,
  error_sample: httpErrors.slice(0, 10),
  counts: { tasks: tasks.length, agents: agents.length },
  pagination: { tasks: 'offset', agents: 'page (to pagination.total_pages)' },
  note: 'samples are collected separately by crawl-samples.mjs (public read path).',
}, null, 1));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${fetched} requests (${JSON.stringify(perEndpoint)}), ${httpErrors.length} errors`);
console.log('next: node src/crawl-samples.mjs');