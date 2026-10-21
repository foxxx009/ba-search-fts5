// Builds the SQLite FTS5 index. Incremental: re-crawl updates only changed docs.
//
// v3 changes (each maps to a review finding):
//   * tasks.capabilities is populated from required_capabilities. It was hard-coded '' so task
//     capability text was unsearchable even though 337 of 370 tasks declare it.
//   * a real `category` column is stored and filterable. The API's own ?category= parameter is
//     real and works (research|code|content|data|automation); the gap was that this service had
//     no category filter at all.
//   * samples are read from the flat record shape crawl-samples.mjs writes (s.content/s.files).
//     Reading s.submission?.content indexed every sample body as "\n".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DATA = path.resolve(process.env.BA_SEARCH_DATA || 'data');
const DB = process.env.BA_SEARCH_DB
  ? path.resolve(process.env.BA_SEARCH_DB)
  : path.resolve('data/index.db');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

// Weights are a tuning knob (see tune.mjs). Default = the measured optimum (profile
// v3-title-max): field-pair top-1 0.900 vs 0.850 for the old 10:6:4:1 default and 0.450 for
// flat weights, with no regression on the topical set (MRR 1.000 either way).
const W = { title: 30.0, capabilities: 8.0, tags: 4.0, body: 1.0 };
const SCHEMA_VERSION = '3'; // bump => forces full rebuild

function hashDoc(d) { return crypto.createHash('sha256').update(JSON.stringify(d)).digest('hex'); }
const arr = (v) => Array.isArray(v) ? v.join(' ') : (v || '');

function buildDocs() {
  const tasks = read('tasks.json'), agents = read('agents.json'), samples = read('samples.json');
  const docs = [];
  for (const t of tasks) {
    docs.push({
      id: `task:${t.task_id}`, type: 'task', ref: t.task_id,
      title: t.title || '',
      capabilities: arr(t.required_capabilities),
      tags: (t.bounty ? 'bounty paid ' : '') + (t.status || '') + ' ' + (t.category || ''),
      body: t.description || '',
      status: t.status || '', category: t.category || '',
      bounty: t.bounty ? 1 : 0,
      amount: t.bounty ? (t.bounty.amount_atomic ?? 0) / 1e6 : 0,
      token: t.bounty?.token || '', network: t.bounty?.network || '',
      updated: t.updated_at || t.created_at || '',
    });
  }
  for (const a of agents) {
    docs.push({
      id: `agent:${a.agent_id}`, type: 'agent', ref: a.agent_id,
      title: a.name || '', capabilities: arr(a.capabilities),
      tags: [...(a.protocols || []), ...(a.offers || []), ...(a.needs || [])].join(' '),
      body: [a.description, a.homepage].filter(Boolean).join(' '),
      status: a.status || '', category: '', bounty: 0, amount: 0, token: '', network: '',
      updated: a.updated_at || '',
    });
  }
  for (const s of samples) {
    const c = s.content || '';
    const f = s.files || {};
    docs.push({
      id: `sample:${s.task_id}`, type: 'sample', ref: s.task_id,
      title: s.title || '', capabilities: '', tags: 'published sample accepted delivery',
      body: c + '\n' + Object.entries(f).map(([k, v]) => `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n'),
      status: '', category: '', bounty: 0, amount: 0, token: '', network: '', updated: s.published_at || '',
    });
  }
  return docs;
}

const fresh = !fs.existsSync(DB);
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(DB);
db.exec('PRAGMA journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS docs(
  id TEXT PRIMARY KEY, type TEXT, ref TEXT, title TEXT, capabilities TEXT, tags TEXT, body TEXT,
  status TEXT, category TEXT, bounty INTEGER, amount REAL, token TEXT, network TEXT, updated TEXT, h TEXT)`);
db.exec(`CREATE INDEX IF NOT EXISTS docs_type ON docs(type)`);
db.exec(`CREATE INDEX IF NOT EXISTS docs_category ON docs(category)`);
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED, title, capabilities, tags, body, tokenize='porter unicode61 remove_diacritics 2')`);

const prev = db.prepare('SELECT v FROM meta WHERE k=?');
const schema = prev.get('schema')?.v;
if (schema !== SCHEMA_VERSION) { db.exec('DELETE FROM docs'); db.exec('DELETE FROM fts'); db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('schema', SCHEMA_VERSION); }
db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('weights', JSON.stringify(W));

const docs = buildDocs();
const existing = new Map(db.prepare('SELECT id,h FROM docs').all().map(r => [r.id, r.h]));
const insDoc = db.prepare(`INSERT OR REPLACE INTO docs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insFts = db.prepare('INSERT INTO fts(id,title,capabilities,tags,body) VALUES(?,?,?,?,?)');
const delFts = db.prepare('DELETE FROM fts WHERE id=?');
const delDoc = db.prepare('DELETE FROM docs WHERE id=?');

let added = 0, updated = 0, unchanged = 0, removed = 0;
db.exec('BEGIN');
for (const d of docs) {
  const h = hashDoc(d);
  if (existing.get(d.id) === h) { unchanged++; continue; }
  if (existing.has(d.id)) { delFts.run(d.id); updated++; } else added++;
  insDoc.run(d.id, d.type, d.ref, d.title, d.capabilities, d.tags, d.body, d.status, d.category, d.bounty, d.amount, d.token, d.network, d.updated, h);
  insFts.run(d.id, d.title, d.capabilities, d.tags, d.body);
}
// prune docs that vanished from the corpus
const live = new Set(docs.map(d => d.id));
for (const id of existing.keys()) if (!live.has(id)) { delFts.run(id); delDoc.run(id); removed++; }
db.exec('COMMIT');
// OPTIMIZE must be passed as a bound value; inlined it is parsed as an identifier.
db.prepare('INSERT INTO fts(fts) VALUES(?)').run('optimize');

const total = db.prepare('SELECT COUNT(*) n FROM docs').get().n;
const byType = db.prepare('SELECT type, COUNT(*) n FROM docs GROUP BY type ORDER BY n DESC').all();
const capsFilled = db.prepare("SELECT COUNT(*) n FROM docs WHERE type='task' AND capabilities <> ''").get().n;
const sampleBodies = db.prepare("SELECT COUNT(*) n FROM docs WHERE type='sample' AND length(body) > 50").get().n;
db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('built_at', new Date().toISOString());
db.close();
console.log(JSON.stringify({
  added, updated, unchanged, removed, total, byType, weights: W,
  tasks_with_indexed_capabilities: capsFilled,
  samples_with_real_body: sampleBodies,
}, null, 1));