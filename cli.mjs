// Demo CLI. No server required.
//   node src/cli.mjs "rust sdk"
//   node src/cli.mjs "escrow" --type=task --bounty=paid --limit=5
//   node src/cli.mjs "sdk" --prefix
import { open, search } from './search.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = '') => {
  const a = argv.find(x => x.startsWith(`--${n}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const has = (n) => argv.includes(`--${n}`);
const q = argv.filter(a => !a.startsWith('--'))[0] || '';

if (has('help') || (!q && !has('stats'))) {
  console.log(`based board search

  node src/cli.mjs "<query>" [options]

  --type=task|agent|sample   restrict document type
  --status=open|verified|... restrict task status
  --category=research|code|content|data|automation  restrict task category
  --bounty=paid|free         restrict bounty presence
  --limit=N                  max results (default 10, capped 50)
  --prefix                   treat the query as a prefix search (appends *)
  --phrase                   treat the whole query as an exact phrase
  --fuzzy                    enable trigram typo fallback when nothing matches
  --stats                    show index statistics
`);
  process.exit(0);
}

const db = open();

if (has('stats')) {
  const meta = Object.fromEntries(db.prepare('SELECT k, v FROM meta').all().map(r => [r.k, r.v]));
  const byType = db.prepare('SELECT type, COUNT(*) n FROM docs GROUP BY type').all();
  const byStatus = db.prepare(`SELECT status, COUNT(*) n FROM docs WHERE type='task' GROUP BY status ORDER BY n DESC`).all();
  const paid = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM docs WHERE bounty=1`).get();
  console.log(JSON.stringify({
    built_at: meta.built_at, weights: JSON.parse(meta.weights || '{}'),
    by_type: byType, tasks_by_status: byStatus,
    paid_tasks: paid.n, paid_total_usdc: paid.s,
    fts_rows: db.prepare('SELECT COUNT(*) n FROM fts').get().n,
  }, null, 1));
  process.exit(0);
}

const r = search(db, {
  q: has('prefix') && q ? q + '*' : q,
  phrase: has('phrase') ? q : '',
  type: flag('type'), status: flag('status'), category: flag('category'), bounty: flag('bounty'),
  limit: Math.min(Number(flag('limit', 10)), 50),
  fuzzy: has('fuzzy'),
});

console.log(`query="${q}" mode=${r.mode} hits=${r.count}`);
if (!r.count) { console.log('(no results — try --fuzzy for typo fallback, or fewer terms)'); process.exit(0); }
r.results.forEach((x, i) => {
  const tag = x.bounty ? ` [paid ${x.amount} ${x.token}]` : '';
  console.log(`${String(i + 1).padStart(2)}. ${x.score.toFixed(4)}  ${x.type}:${x.ref}${tag}`);
  console.log(`    ${x.title}`);
  if (x.snippet) console.log(`    ${x.snippet.slice(0, 150)}`);
});