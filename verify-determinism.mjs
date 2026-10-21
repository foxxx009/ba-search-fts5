// Determinism / reproducibility check.
//
// The previous delivery claimed a clean rebuild of the index produces flat field-pair top-1 of
// 0.55. The reviewer re-ran the shipped code from an empty index and measured 0.65. One of those
// numbers described a build that no longer existed. This script settles it the only way that
// counts: delete the database, rebuild from the shipped corpus, re-measure, and compare against
// the incremental path. Both must agree, and the printed numbers are the ones quoted in the
// README -- not remembered ones.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { open, search } from './search.mjs';

const NODE = process.execPath;
const DB = path.resolve('data/index.db');
const PAIRS = JSON.parse(fs.readFileSync('runs/field-pairs.json', 'utf8'));

function fieldTop1(db, W) {
  let top1 = 0;
  for (const p of PAIRS) {
    const r = search(db, { q: p.query, type: 'task', limit: 10, weights: W });
    const i = r.results.findIndex(x => x.ref === p.target);
    const j = r.results.findIndex(x => x.ref === p.distractor);
    if (i !== -1 && (j === -1 || i < j)) top1++;
  }
  return Number((top1 / PAIRS.length).toFixed(4));
}

const FLAT = { title: 1, capabilities: 1, tags: 1, body: 1 };
const BEST = { title: 30, capabilities: 8, tags: 4, body: 1 };

console.log(`field pairs: ${PAIRS.length}`);

// 1) measure against the existing index
const before = open();
const flatBefore = fieldTop1(before, FLAT);
const bestBefore = fieldTop1(before, BEST);
before.close();
console.log(`\n[existing index]`);
console.log(`  flat weights      field_pair_top1 = ${flatBefore}`);
console.log(`  tuned weights     field_pair_top1 = ${bestBefore}`);

// 2) delete the database entirely and rebuild from the shipped corpus
// On Windows a -wal/-shm pair left by an earlier open() handle can keep the file locked for a
// moment after close(); retry briefly rather than failing the whole check on a transient lock.
const rmRetry = (p) => {
  for (let i = 0; i < 20; i++) {
    if (!fs.existsSync(p)) return true;
    try { fs.rmSync(p); } catch { /* still locked */ }
    if (!fs.existsSync(p)) return true;
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},120)']);
  }
  return !fs.existsSync(p);
};
for (const suffix of ['', '-wal', '-shm']) {
  const p = DB + suffix;
  if (!rmRetry(p)) throw new Error(`could not remove ${p} after 20 attempts`);
}
console.log('\n[clean rebuild from scratch]');
const built = JSON.parse(execFileSync(NODE, ['src/indexer.mjs'], { encoding: 'utf8' }));
console.log(`  rebuilt: total=${built.total} added=${built.added} tasks_with_capabilities=${built.tasks_with_indexed_capabilities} samples_with_body=${built.samples_with_real_body}`);

const after = open();
const flatAfter = fieldTop1(after, FLAT);
const bestAfter = fieldTop1(after, BEST);
const docs = after.prepare('SELECT COUNT(*) n FROM docs').get().n;
after.close();
console.log(`  flat weights      field_pair_top1 = ${flatAfter}`);
console.log(`  tuned weights     field_pair_top1 = ${bestAfter}`);
console.log(`  docs=${docs}`);

const same = flatBefore === flatAfter && bestBefore === bestAfter && docs === built.total;
console.log(`\nDETERMINISM: ${same ? 'PASS' : 'FAIL'}  (clean rebuild reproduces the incremental index exactly)`);
console.log(`AUTHORITATIVE flat field_pair_top1 = ${flatAfter}  (this is the number the README quotes)`);
console.log(`AUTHORITATIVE tuned field_pair_top1 = ${bestAfter}`);
if (!same) process.exitCode = 1;