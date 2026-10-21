// Why the eval saturated, and how to build a metric that can still move.
//
// The board is full of near-duplicate titles (many campaigns post byte-identical task
// titles), so a query built from title words alone cannot separate documents: the target
// and its clone both match perfectly and the rank is decided by tie-break, not relevance.
//
// A weight profile can only express one thing: "a term in the TITLE should count for more
// than the same term in the BODY". So the discriminating test case is a query where the
// target and a distractor BOTH match every term, but the discriminating term sits in the
// target's title and only in the distractor's body. Under title-heavy weights the target
// must win; under flat weights it is a coin flip.
import fs from 'node:fs';
import { open } from './search.mjs';
const db = open();

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'from', 'your', 'by', 'is', 'it', 'at', 'as', 'that', 'this', 'be', 'are', 'not']);
const toks = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t && !STOP.has(t) && t.length > 2);

const docs = db.prepare("SELECT id, ref, title, capabilities, tags, body, type FROM docs").all();

// duplicate-title census, so the writeup can state the real reason
const byTitle = {};
for (const d of docs) { const k = (d.title || '').trim().toLowerCase(); if (k) (byTitle[k] ||= []).push(d.ref); }
const dupes = Object.entries(byTitle).filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);
console.log(`docs=${docs.length} distinct_titles=${Object.keys(byTitle).length} duplicate_title_groups=${dupes.length}`);
console.log(`largest duplicate groups: ${dupes.slice(0, 3).map(([t, v]) => `${v.length}x "${t.slice(0, 45)}"`).join(' | ')}`);

// mine field-discriminating pairs
const pairs = [];
for (const t of docs) {
  if (t.type !== 'task') continue;
  const tTitle = new Set(toks(t.title));
  const tBody = new Set(toks(t.body));
  for (const d of docs) {
    if (d.ref === t.ref || d.type !== 'task') continue;
    const dTitle = new Set(toks(d.title));
    const dBody = new Set(toks(d.body));
    const shared = [...tTitle].filter(w => dTitle.has(w));
    if (shared.length < 2) continue;
    // term shared by both docs, present in target TITLE but NOT in distractor title
    const keyTerms = [...tTitle].filter(w => !dTitle.has(w) && dBody.has(w));
    if (!keyTerms.length) continue;
    // query = the shared context terms + one key term (in both bodies, only in target title)
    const key = keyTerms.sort((a, b) => b.length - a.length)[0];
    const ctx = shared.sort((a, b) => b.length - a.length).slice(0, 2);
    pairs.push({
      query: [...ctx, key].join(' '),
      target: t.ref, target_title: t.title,
      distractor: d.ref, distractor_title: d.title,
      key_term: key,
      rationale: `"${key}" is in the target's TITLE and in the distractor's BODY only; `
        + `"${ctx.join('" "')}" appear in both titles. Title-weighted ranking must prefer the target.`,
    });
  }
}

// keep the most confident: key term must not appear anywhere in the distractor's title,
// and the pair should share >=2 context terms.
const uniq = [];
const seen = new Set();
for (const p of pairs.sort((a, b) => b.query.length - a.query.length)) {
  const k = p.query;
  if (seen.has(k)) continue;
  seen.add(k);
  uniq.push(p);
  if (uniq.length >= 20) break;
}
fs.mkdirSync('runs', { recursive: true });
fs.writeFileSync('runs/field-pairs.json', JSON.stringify(uniq, null, 1));
console.log(`\nmined ${pairs.length} candidate field-discriminating pairs, kept ${uniq.length}`);
// Print every kept pair. An earlier build printed only the first 12 while the summary line said
// "kept 20", so the transcript and the count disagreed; the file below is the full set either way.
console.log(`printing all ${uniq.length} kept pairs (same set as runs/field-pairs.json)`);
for (const [i, p] of uniq.entries()) {
  console.log(`\n  [${i + 1}/${uniq.length}] q="${p.query}"`);
  console.log(`    target      : ${p.target_title.slice(0, 70)}`);
  console.log(`    distractor  : ${p.distractor_title.slice(0, 70)}`);
}