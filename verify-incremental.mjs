// Proves the index rebuild is incremental: re-running with an unchanged corpus must touch
// zero documents, and a synthetic single-doc change must update exactly one. This is the
// difference between "we rebuild everything" and "we can rebuild cheaply".
//
// The victim task is picked from the live corpus by STATUS and CAPABILITY rather than a
// hard-coded id: the previous version hard-coded task_0fCLrv8T8cZ7ovzVb29yt and would have
// thrown on a corpus where that id is absent. v2 also proved an empty-capabilities task exists
// so the "honest empty" contract is checked at the same time.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const NODE = process.execPath;
const DATA = path.resolve('data');
const runIndexer = () => JSON.parse(execFileSync(NODE, ['src/indexer.mjs'], { encoding: 'utf8' }));

const pass1 = runIndexer();
console.log(`pass1 (unchanged corpus): added=${pass1.added} updated=${pass1.updated} unchanged=${pass1.unchanged} total=${pass1.total}`);
if (pass1.added !== 0 || pass1.updated !== 0) {
  console.log('INCREMENTAL VERDICT: FAIL — an unchanged corpus must produce added=0 updated=0');
  process.exit(1);
}

const tpath = path.join(DATA, 'tasks.json');
const backup = fs.readFileSync(tpath, 'utf8');
const tasks = JSON.parse(backup);
// pick a real task: prefer one that declares capabilities so we can assert both facts at once
const victim = tasks.find(t => (t.required_capabilities || []).length) || tasks[0];
const capsBefore = (victim.required_capabilities || []).join(' ');
console.log(`victim: ${victim.task_id} caps="${capsBefore}"`);

try {
  victim.title = victim.title + ' [incremental-probe]';
  fs.writeFileSync(tpath, JSON.stringify(tasks, null, 1));

  const pass2 = runIndexer();
  console.log(`pass2 (one doc changed): added=${pass2.added} updated=${pass2.updated} unchanged=${pass2.unchanged} total=${pass2.total}`);

  const { open, search } = await import('./search.mjs');
  const db = open();
  const hit = search(db, { q: 'incremental probe', type: 'task', limit: 3 });
  const found = hit.results.some(r => r.ref === victim.task_id);
  console.log(`new text searchable immediately: ${found} (mode=${hit.mode})`);

  // capabilities must survive the rebuild, and a no-capability task must stay honestly empty
  const withCaps = db.prepare('SELECT capabilities FROM docs WHERE id=?').get(`task:${victim.task_id}`);
  const capsIndexed = String(withCaps?.capabilities || '') === capsBefore;
  const emptyCapTask = tasks.find(t => !(t.required_capabilities || []).length);
  const emptyRow = emptyCapTask
    ? db.prepare('SELECT capabilities FROM docs WHERE id=?').get(`task:${emptyCapTask.task_id}`)
    : null;
  const emptyHonest = !emptyCapTask || String(emptyRow?.capabilities) === '';
  console.log(`capabilities preserved through rebuild: ${capsIndexed} ("${String(withCaps?.capabilities || '').slice(0, 60)}")`);
  console.log(`no-capability task stays honestly empty: ${emptyHonest}`);

  const ok = pass2.added === 0 && pass2.updated === 1 && pass2.unchanged === pass1.total - 1
    && found && capsIndexed && emptyHonest;
  console.log(`\nINCREMENTAL VERDICT: ${ok ? 'PASS' : 'FAIL'}  (expected added=0 updated=1 unchanged=${pass1.total - 1})`);

  // restore and confirm we converge back
  fs.writeFileSync(tpath, backup);
  const pass3 = runIndexer();
  console.log(`pass3 (restored): added=${pass3.added} updated=${pass3.updated} unchanged=${pass3.unchanged} total=${pass3.total}`);
  const converged = pass3.total === pass1.total && pass3.added === 0 && pass3.updated === 1;
  console.log(`converged back to baseline total: ${pass3.total === pass1.total}`);
  db.close();
  if (!ok || !converged) process.exitCode = 1;
} finally {
  fs.writeFileSync(tpath, backup);
}