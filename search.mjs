// Query layer: FTS5 MATCH + bm25 field weighting + filters + honest prefix/phrase/typo handling.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

// BA_SEARCH_DB lets a verifier point the engine at a throwaway database instead of destroying the
// live one. Deleting index.db to prove a clean rebuild required fs.rmSync, which is blocked by a
// safe-delete shim on this host; building into a scratch path proves the same thing reversibly.
const DB = process.env.BA_SEARCH_DB
  ? path.resolve(process.env.BA_SEARCH_DB)
  : path.resolve('data/index.db');

// Strip FTS5 operators from user input so a query can never be a syntax error or a
// surprise NEAR/column-filter injection. Users get plain AND-of-terms semantics.
export function sanitize(q) {
  return String(q || '').replace(/["\-():\*\^\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function tokenize(q) {
  return sanitize(q).split(' ').filter(Boolean);
}

// A user term becomes a quoted FTS5 string. Prefix matching is opt-in per term with a
// trailing '*' (e.g. "escro*"). Phrase search is opt-in with the phrase= parameter.
//
// Order matters: the trailing '*' must be read BEFORE sanitize(), which strips '*' as an
// FTS5 operator. Sanitizing first silently deleted every prefix marker and prefix search
// returned zero rows while looking like a legitimate empty result.
export function toMatchExpr(q, { phrase = '' } = {}) {
  if (phrase) {
    const p = sanitize(phrase).split(' ').filter(Boolean);
    if (p.length) return '"' + p.join(' ') + '"';
  }
  const toks = String(q || '')
    .replace(/["\-():\^\[\]]/g, ' ')   // operators, but NOT '*'
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!toks.length) return null;
  return toks.map(t => (t.endsWith('*') && t.length > 1
    ? '"' + t.slice(0, -1).replace(/"/g, '') + '"*'
    : '"' + t.replace(/"/g, '') + '"')).join(' AND ');
}

function trigrams(t) {
  const g = new Set();
  for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3));
  return [...g];
}

export function search(db, {
  q = '', phrase = '', type = '', status = '', bounty = '', category = '',
  limit = 10, weights = null, fuzzy = false,
} = {}) {
  const row = db.prepare('SELECT v FROM meta WHERE k=?').get('weights');
  const W = weights || (row ? JSON.parse(row.v) : { title: 10, capabilities: 6, tags: 4, body: 1 });

  const filters = [], params = {};
  if (type) { filters.push('d.type = :type'); params.type = type; }
  if (status) { filters.push('d.status = :status'); params.status = status; }
  if (category) { filters.push('d.category = :category'); params.category = category; }
  if (bounty === 'paid') filters.push('d.bounty = 1');
  if (bounty === 'free') filters.push('d.bounty = 0');
  const fsql = filters.length ? 'AND ' + filters.join(' AND ') : '';

  const expr = toMatchExpr(q, { phrase });

  // bm25() weight arguments are POSITIONAL over every declared column of the FTS table,
  // INCLUDING UNINDEXED ones. Our table declares (id UNINDEXED, title, capabilities, tags,
  // body), so a 4-element weight vector silently binds to (id, title, capabilities, tags)
  // and leaves body at its default 1.0. That off-by-one made every weight profile score
  // identically and would have shipped a "tuning result" that was pure noise. The vector is
  // now built from the real declared column order, with 0.0 for unindexed columns.
  const FTS_COLS = db.prepare("SELECT name FROM pragma_table_info('fts')").all().map(r => r.name);
  const INDEXED = db.prepare("SELECT name FROM pragma_table_info('fts') WHERE name <> 'id'").all().map(r => r.name);
  const missing = INDEXED.filter(c => !(c in W));
  if (missing.length) throw new Error(`weight profile is missing fields: ${missing.join(', ')}`);
  const wargs = FTS_COLS.map(c => (c in W ? Number(W[c]) : 0));

  let rows = [], mode = 'fts5';
  if (expr) {
    // node:sqlite refuses to mix positional (?) and named (:x) parameters, so the
    // bm25 weights are bound by name too.
    const wnames = wargs.map((_, i) => `:w${i}`);
    const wparams = Object.fromEntries(wargs.map((v, i) => [`w${i}`, v]));
    const sql = `SELECT d.id, d.type, d.ref, d.title, d.status, d.category, d.bounty, d.amount, d.token, d.network,
        bm25(fts, ${wnames.join(', ')}) AS score, substr(d.body, 1, 240) AS snippet
      FROM fts JOIN docs d ON d.id = fts.id
      WHERE fts MATCH :m ${fsql}
      ORDER BY score ASC LIMIT :lim`;
    try {
      rows = db.prepare(sql).all({ ...wparams, m: expr, ...params, lim: limit });
    } catch (e) {
      // Never let a query failure masquerade as "no results". Surface it.
      throw new Error(`fts5 query failed (mode=${mode}): ${e.message} | expr=${expr}`);
    }
  } else {
    mode = 'empty-query';
  }

  // Honest typo fallback. FTS5's porter tokenizer does stem but has no edit-distance
  // matcher, so when the exact query yields nothing we retry with a trigram score.
  //
  // v2 bug: it used only grams[0] — the first trigram of the term — so "rsut sdk" matched
  // only docs containing the literal substring "rsu" and returned nothing useful. Now every
  // distinct trigram of a term contributes to a shared-count score, which is what trigram
  // similarity actually means. It only fires on zero results, so it cannot dilute precision
  // on queries that already match, and the response always reports which mode produced it.
  if (!rows.length && expr && fuzzy) {
    const allToks = tokenize(q);
    const toks = allToks.filter(t => t.length >= 3);
    const scored = [];
    if (toks.length) {
      // Per-token trigram coverage, not a raw count of matching trigrams.
      // v3 used a shared-count score, which rewarded long documents: a 4 KB task body hit more
      // trigrams than the actual "rust sdk" task and buried it. Coverage is the fraction of a
      // term's own trigrams present, so document length cancels out, and a document only
      // qualifies when EVERY term has some coverage (AND semantics, like the FTS path).
      const perTok = toks.map(t => trigrams(t.toLowerCase()));
      const grams = [...new Set(perTok.flat())];
      if (grams.length) {
        const lp = Object.fromEntries(grams.map((g, i) => [`g${i}`, `%${g}%`]));
        const cand = db.prepare(`SELECT id, type, ref, title, status, category, bounty, amount, token, network, body
          FROM docs d WHERE (${grams.map((_, i) => `(d.title LIKE :g${i} OR d.body LIKE :g${i})`).join(' OR ')}) ${fsql} LIMIT 4000`)
          .all({ ...lp, ...params });
        for (const c of cand) {
          const title = (c.title || '').toLowerCase();
          const body = (c.body || '').toLowerCase();
          let sum = 0, ok = true;
          for (const own of perTok) {
            let th = 0, bh = 0;
            for (const g of own) {
              if (title.includes(g)) th++;
              else if (body.includes(g)) bh++;
            }
            // title hits count double: a term in the title is a stronger signal than the same
            // term buried in a 4 KB body, which is exactly what let long docs win before.
            const cov = (th * 2 + bh) / (own.length * 2);
            if (cov === 0) { ok = false; break; }
            sum += cov;
          }
          if (ok) scored.push({ c, score: sum / perTok.length });
        }
        scored.sort((a, b) => b.score - a.score);
        rows = scored.slice(0, limit).map(({ c, score }) => ({
          id: c.id, type: c.type, ref: c.ref, title: c.title, status: c.status, category: c.category,
          bounty: c.bounty, amount: c.amount, token: c.token, network: c.network,
          score: -Number(score.toFixed(4)), snippet: (c.body || '').replace(/\s+/g, ' ').slice(0, 240),
        }));
        mode = 'trigram-fallback';
      }
    }
    if (!rows.length) {
      // Terms shorter than 3 chars have no trigrams; fall back to plain containment for them.
      const short = allToks.filter(t => t.length < 3);
      const cl = short.map((t, i) => `(d.title LIKE :s${i} OR d.body LIKE :s${i})`);
      const sp = Object.fromEntries(short.map((t, i) => [`s${i}`, `%${t}%`]));
      if (cl.length) {
        rows = db.prepare(`SELECT d.id, d.type, d.ref, d.title, d.status, d.category, d.bounty, d.amount, d.token, d.network,
            0.0 AS score, substr(d.body,1,240) AS snippet FROM docs d WHERE ${cl.join(' AND ')} ${fsql} LIMIT :lim`)
          .all({ ...sp, ...params, lim: limit });
        mode = 'substring-fallback';
      }
    }
  }

  return {
    mode,
    weights: W,
    count: rows.length,
    results: rows.map(r => ({ ...r, snippet: (r.snippet || '').replace(/\s+/g, ' ') })),
  };
}

export function open() { return new DatabaseSync(DB); }