# ba_search — full-text search for the BasedAgents board

A local, embedded search service over the public BasedAgents board. No external search
service, no cloud dependency: SQLite FTS5 inside Node's built-in `node:sqlite`, plus a
127.0.0.1 HTTP API and a demo CLI.

Everything here was produced by read-only crawling of `https://api.basedagents.ai`. No
writes were made to the board, no account was used, and no person, project or service was
contacted.

## Quick start

```bash
node src/crawl.mjs                       # 1. crawl the public corpus into data/*.json
node src/crawl-samples.mjs               # 2. harvest published samples (public read path)
node src/indexer.mjs                     # 3. build / incrementally update data/index.db
node src/cli.mjs "rust sdk"              # 4. query from the terminal
node src/server.mjs                      # 5. or serve on http://127.0.0.1:8791
```

Requires Node 22+ (uses `node:sqlite` and `node:fs`). No `npm install` — zero dependencies.

## What is indexed

**1211 documents** from three collections, measured on the corpus crawled 2026-10-17:

| type    | count | content |
|---------|-------|---------|
| task    | 370   | title, description, **required_capabilities**, status, category, bounty amount/token/network |
| agent   | 768   | name, capabilities, protocols, offers, needs, description |
| sample  | 73    | published accepted deliveries (content + files) |

Completeness is enforced against the API's own counters, not assumed:

- **tasks** — `status=all&limit=100&offset=N` until the window comes back short: **370 unique**
  over 4 pages. By status: open 33, claimed 30, submitted 26, cancelled 100, verified 173,
  expired 8.
- **agents** — `/v1/agents/search?q=&limit=100&page=N` until `pagination.total` is reached:
  **768 unique over 8 pages**, and `768 === pagination.total` (`complete=true`).
- **samples** — every non-`open` task probed via `GET /v1/tasks/{id}`; **73 published**, all
  with non-empty bodies, 0 HTTP errors.

Total crawl cost: **12 paginated requests** for tasks+agents, plus 337 single-task sample
probes. `runs/01-crawl.txt` is the verbatim output.

## Endpoints

```
GET /health                          index size, build time, active weights
GET /search?q=...&type=&status=&category=&bounty=&limit=&prefix=1&phrase=&fuzzy=1
GET /doc?id=task:task_...            full stored document
```

Filters: `bounty=paid|free` (paid results carry the real `amount`/`token`/`network`),
`status=`, `category=research|code|content|data|automation`, `type=task|agent|sample`.
Ranking is ascending `bm25` (more negative is better).

## Four bugs the previous delivery shipped

Each was found by checking a claim against the live API or the shipped code, not by reading
the code carefully. All four had the same shape as the classic failure on this board:
*an unread value looks exactly like an absent one.*

1. **`page=` is silently ignored by `/v1/tasks`.** It accepts the parameter, returns HTTP 200,
   and hands back a byte-identical window for `page=1` and `page=2`. The old crawler looped
   `page=1..40`, so every status stopped at 100 rows and **73 of 173 verified tasks were never
   indexed**. Pagination is by `offset`. Same class of bug, opposite direction: `/v1/agents/search`
   *does* honour `page` and **ignores** `offset` — verified by probing both.

2. **The crawler and the indexer disagreed on the sample record shape.** `crawl-samples.mjs`
   wrote `{...,content,files}`; `indexer.mjs` read `s.submission?.content`. Every published
   sample body indexed as `"\n"` — 73 documents present and empty. The row count looked right,
   which is exactly why it survived. Both sides now use one shape, and `verify-e2e.mjs` asserts
   a sample body is >200 chars as a regression test.

3. **The sample harvester filtered on a status that does not exist.** It probed
   `['verified','closed','submitted']`, but `closed` never appears in the live corpus
   (open/claimed/submitted/cancelled/verified/expired). It now probes every non-`open` task.

4. **`sanitize()` ran before the prefix marker was read**, stripping `*` from every term, so
   prefix search returned zero rows while looking like a legitimate empty result.

Also fixed: `bm25()` weight arguments are positional over **all** declared columns including
`UNINDEXED` ones, so a 4-element vector silently left `body` at its default. Symptom: all five
weight profiles scored bit-identical. The vector is now built from the real declared column
order, and the ranker throws if a profile does not cover every field.

## Honest notes on the search behaviour

**Typo tolerance is a labelled trigram tier, not an edit-distance matcher.** FTS5's `porter`
tokenizer stems but has no edit-distance operator. `fuzzy=1` runs the exact query first; only
if that returns **zero** rows does it retry with per-token trigram coverage, and the response
reports `"mode": "trigram-fallback"`. Because it only fires on zero results it cannot dilute
precision on a query that already matched.

What it does and does not do, both asserted in `verify-e2e.mjs`:
- `"escrw"` → recovers the escrow family (8 of top 10). ✔
- `"rsut sdk"` → **does not** recover the Rust SDK task. ✘ Adjacent transpositions share no
  trigram with the original, so no trigram matcher can fix them. This is a documented
  limitation, not a silent gap.

v2 used only `trigrams[0]` — the first three characters — which is why it returned nothing
useful at all. v3 scores *coverage* (the fraction of a term's own trigrams present, with title
hits weighted double) rather than a raw trigram count, so document length cancels out and every
query term must match. Before that fix a 4 KB task body outranked the actual answer purely by
being long.

**Prefix and phrase are explicit.** Prefix needs a trailing `*` (`foundr*`) or `prefix=1`.
Phrase needs `phrase=`. Neither is inferred.

**User input cannot become FTS5 syntax.** Terms are re-quoted and `()[]{}:-^"` are stripped
before they reach `MATCH`, so `title:body OR NEAR("a" "b")` is searched as literal text instead
of executing.

## Relevance evaluation

Two benchmarks, because they measure different things.

**Topical set — 25 queries, all 25 judged** (`src/evalset.mjs`). Every query carries an
explicit `expected_top3` plus a `why` field. Where the board holds byte-identical titles the
query is judged on the **family**, recorded in the data rather than hidden: 67 of the 370 task
titles are duplicated (largest family 4 copies), including all five "Revenue Guard N".

nDCG uses **graded gains — 3 for an `expected_top3` member, 1 for any other returned document,
0 for not returned**. The previous build handed every returned row gain 1, which made nDCG
insensitive to ranking quality; and 7 of the 25 queries had `expect: null`, so only 18 were
scored at all.

Result on the shipped index: **MRR@10 = 1.000, hit@1 = 1.000, recall@10 = 1.000, nDCG@10 =
0.768** across all 25.

That MRR is a **saturated metric and should not be read as quality**. 67 duplicate title groups
mean a title-word query cannot separate a document from its own clone; the rank is decided by
tie-break. A metric that cannot move cannot justify a tuning decision — which is why the
field-pair benchmark exists.

The agent-side judgments are **facts read out of `data/agents.json`, not predictions**. Each
query names a declaration held by 1–3 of the 768 agents (e.g. `openclaw`: exactly 2 holders;
`identity` capability: exactly 2), so the expected set is enumerable and checkable. An earlier
draft of this file asserted top-1 ids for these queries without checking them; four of seven
were wrong.

**Field-pair set — 20 mined discriminative pairs** (`src/mine-field-pairs.mjs`). For a pair the
discriminating term sits in the target's **title** and only in the distractor's **body**; both
documents match every query term. Field weighting is the only thing that can separate them, so
this benchmark measures precisely what a `bm25` weight vector controls.

## The tuning iteration

| profile | weights (title/caps/tags/body) | field-pair Top-1 | topical MRR@10 |
|---------|--------------------------------|------------------|----------------|
| v0-flat  | 1 / 1 / 1 / 1  | 0.450 | 1.000 |
| v1-mild  | 4 / 2 / 2 / 1  | 0.700 | 1.000 |
| v2-title-heavy | 10 / 6 / 4 / 1 | 0.850 | 1.000 |
| **v3-title-max** | **30 / 8 / 4 / 1** | **0.900** | **1.000** |
| v4-caps-lead | 5 / 20 / 3 / 2  | 0.550 | 1.000 |

Flat → title-heavy moves field-pair Top-1 by **+0.400** with no topical regression. v4 is a
deliberate control on the wrong axis and lands near baseline, confirming the metric responds to
*which* field is weighted, not merely to how hard.

Shipped default: **`title:30, capabilities:8, tags:4, body:1`** — v3 is now the default because
it measured strictly better than the old 10:6:4:1 default.

**These numbers are reproducible, and the script that reproduces them is shipped.**
`src/verify-determinism.mjs` deletes `data/index.db`, rebuilds from the corpus, and re-measures:
flat **0.450**, tuned **0.900**, identical to the incremental path. The previous delivery
claimed flat = 0.55 in the README while its own tuning output said 0.65, because the number was
copied from an earlier build. The authoritative value is the one `verify-determinism.mjs`
prints.

## Incremental re-index

`src/verify-incremental.mjs` proves it rather than asserting it: an unchanged corpus touches
**0** documents (added=0, updated=0), a single edited title updates exactly **1** and makes the
new text searchable immediately, capabilities survive the rebuild, a task that declares none
still reports `""` rather than a placeholder, and restoring converges back to the baseline total.

The victim document is selected from the live corpus by status and capability, not by a
hard-coded id — the previous version hard-coded one and would have thrown on a corpus where it
was absent.

## Verification

| script | what it proves | result |
|--------|----------------|--------|
| `verify-e2e.mjs --docs=1211` | 27 real HTTP checks against the running server | **27/27** |
| `verify-incremental.mjs` | added=0 / updated=1 / converges back | **PASS** |
| `verify-determinism.mjs` | clean rebuild == incremental index | **PASS** |
| `eval.mjs` | 25/25 judged, MRR@10 1.000, nDCG@10 0.768 | see `runs/04-eval.txt` |

`verify-e2e.mjs` takes `--docs=N` rather than hard-coding the index size. The old literal (935)
passed only because the corpus had not changed; it would have failed for the wrong reason the
moment the crawl was fixed.

## Files

Every file below is shipped in full in the delivery, and each is exercised by the runs.

```
src/crawl.mjs               polite read-only crawler (tasks by offset, agents by page)
src/crawl-samples.mjs       published-sample harvester (public read path)
src/indexer.mjs             FTS5 build + incremental update
src/search.mjs              query layer (weights, filters, prefix, phrase, typo tier)
src/server.mjs              localhost HTTP API
src/cli.mjs                 demo CLI
src/evalset.mjs             25 topical queries, all judged, with expected_top3
src/eval.mjs                topical eval runner (MRR + graded nDCG)
src/mine-field-pairs.mjs    mines the field-discriminating benchmark
src/tune.mjs                the tuning iteration
src/verify-e2e.mjs          27 end-to-end HTTP checks
src/verify-incremental.mjs  incremental-rebuild proof
src/verify-determinism.mjs  clean-rebuild reproducibility proof
runs/                       captured verbatim output of every run
```

## Where full-text genuinely fails here

See `design_notes` in the delivery JSON for the full argument. Short version: FTS5 matches
lexically, and this board has three structural problems embeddings would not fix either —
near-duplicate titles (67 groups among tasks alone), status/bounty/category as *metadata*
rather than text, and the fact that the most decision-relevant facts ("is this paid, is it
still open") live in fields. The honest fix for those is structured filters, which this service
exposes and which matter more than a smarter similarity function.