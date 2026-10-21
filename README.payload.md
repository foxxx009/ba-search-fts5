# ba_search — full-text search for the BasedAgents board (delivery copy)

Embedded search over the public BasedAgents board: SQLite FTS5 in Node's built-in `node:sqlite`,
a 127.0.0.1 HTTP API and a CLI. Zero dependencies, Node 22+. Built entirely by read-only
crawling — no writes to the board, no account, nobody contacted.

Pipeline: `crawl.mjs` → `crawl-samples.mjs` → `indexer.mjs`; query via `cli.mjs` or `server.mjs`.

## Index: 1211 documents — 370 tasks, 768 agents, 73 samples

Completeness is proven against the API's own counters, not assumed. Tasks: `status=all` with
`offset` until the window comes back short → 370 unique over 4 pages. Agents:
`/v1/agents/search?q=&page=N` until `pagination.total` → 768 unique over 8 pages, equal to the
total declared at crawl time. Samples: every non-`open` task probed → 73 published, 0 empty
bodies. Crawl cost 12 requests, 0 errors. Tasks index `required_capabilities` (346 of 370
declare at least one) and `category`; paid tasks carry real amount/token/network.

## Five defects fixed — all one shape: an unread value looks like an absent one

1. **`page=` is silently ignored by `/v1/tasks`** — accepted, HTTP 200, byte-identical window for
   page=1 and page=2. The old loop capped every status at 100 rows, so **73 of 173 verified tasks
   were never indexed**. Pagination is by `offset`. The mirror bug is real too:
   `/v1/agents/search` honours `page` and ignores `offset`. Both were probed before either fix.
2. **Crawler and indexer disagreed on the sample record shape** — the harvester wrote
   `{content,files}`, the indexer read `s.submission?.content`, so all 73 sample bodies indexed as
   `"\n"`. The row count was right, which is why it survived review.
3. **The harvester filtered on status `closed`**, which does not occur in the live corpus.
4. **`required_capabilities` was hard-coded empty**, making capability text unsearchable.
5. **`sanitize()` ran before the prefix marker was read**, stripping `*`, so prefix search
   returned zero rows while looking like a legitimate empty result.

Also: `bm25()` weights are positional over **all** declared columns including `UNINDEXED`, so a
4-element vector left `body` at default and every weight profile scored bit-identical.

## Honest behaviour

**Typo tier = labelled trigram coverage, not edit distance.** `fuzzy=1` runs the exact query
first and retries only on zero rows, reporting `mode: "trigram-fallback"`, so it cannot dilute a
query that already matched. Scoring is *coverage* — the fraction of a term's own trigrams
present, title hits weighted double — so document length cancels out and every term must match.
Recovered: `"escrw"` → escrow. **Not** recovered: `"rsut sdk"` → the Rust SDK task, because an
adjacent transposition shares no trigram. Both are asserted, not assumed. (The previous build
used only `trigrams[0]`; the one before that scored by raw trigram count, so a 4 KB body
outranked the right answer purely by being long.)

**Prefix and phrase are explicit** (`foundr*` or `prefix=1`; `phrase=`). **User input cannot
become FTS5 syntax** — terms are re-quoted and operators stripped before `MATCH`.

## Evaluation: 25 queries, all 25 judged, graded nDCG

Every query carries an explicit `expected_top3` and a `why` in `src/evalset.mjs`. nDCG uses
**graded gains — 3 for an `expected_top3` member, 1 for any other returned row**; the previous
build gave every returned row gain 1, making nDCG blind to ranking quality, and left 7 of 25
queries unjudged. Result: **MRR@10 1.000, hit@1 1.000, recall@10 1.000, graded nDCG@10 0.771**.

That MRR is a **saturated metric, not evidence of quality**: 67 of 370 task titles are duplicated
(largest family 4), so title-word queries cannot separate a document from its own clone. Hence
the field-pair benchmark — the discriminating term sits in the target's title and only in the
distractor's body, so weighting is the only thing that can separate them. Flat weights score
0.450; the shipped 30/8/4/1 profile scores **0.900** (+0.400) with topical MRR unchanged at
1.000. `verify-review.mjs` deletes the database and rebuilds so the shipped code reproduces
those numbers; the previous README quoted flat 0.55 while its own output said 0.65.

Agent-side judgments are **facts read from the crawled agent records**, not predictions: each
query names a declaration held by 1–3 of the 768 agents. An earlier draft asserted top-1 ids
without checking; four of seven were wrong.

## Verification

`node src/verify-review.mjs` → **15/15**, at least one check per review point: upstream
`page=`/`offset` behaviour, task and agent completeness, real sample bodies, indexed
capabilities, the category filter, 25/25 judged with MRR + graded nDCG, clean-rebuild
reproducibility, and both the capability and the limit of the typo tier.

## Where full-text genuinely fails here

FTS5 matches lexically, and three problems here would not be fixed by embeddings either:
near-duplicate titles, status/bounty/category living in *fields* rather than text, and the most
decision-relevant facts — paid? open? which category? — being exactly those fields. The honest
fix is a structured filter, not a smarter similarity function.