// Relevance evaluation: 25 judged queries, each with an explicit expected_top3.
//
// v3: every query is judged. The previous build left 7 agent-side queries with expect:null, so
// only 18 of 25 were scored, and it gave every returned document gain 1 in nDCG, which made nDCG
// insensitive to ranking quality.
//
// Judgment rule: a query is judged on a SET, never on one arbitrary id, whenever the board holds
// byte-identical titles. 67 of the 370 task titles are duplicated (largest family 4), so picking
// a single "correct" id among clones would be indefensible. `family` holds the full set of
// interchangeable documents; `top3` holds the graded-relevant members. Every query carries a
// `why`, so any judgment can be argued with.
const FAMILIES = {
  apiReference: ['task_yCUzQNKCzGQUAvX5uB7gO', 'task_0fCLrv8T8cZ7ovzVb29yt', 'task_Wxmjkg034DUQfbdf6oceL'],
  escrowPrototype: ['task_yiIVdSO0MxfR4CKOTXowU', 'task_DNVfUvR3OQ9ggSvdChpoz', 'task_SJXyXxn3juPTrtzKEHCNM', 'task_bB5Ech7ygTMK9SaECvk1j'],
  settledFeed: ['task_zTsYvTU20aUcCD42dad8v', 'task_96AUBiv1oj060qcagPUmY', 'task_MY4VrLpWB112CW6K8MnMf'],
  usdcNeighborhood: ['task_oEtbVoHZzIqdkCWRjgekJ', 'task_ALUeByf5V1wTNUSikiOl2', 'task_NnBgD2vAXcqe5qdQr46SX'],
  revenueGuard: ['task_ToEmWubWjjfNICs4qnkYg', 'task_jqnmxHEcIGNHvANoCjtyZ', 'task_PRGxeT66PotQxYJw7EPlL', 'task_xunXTsWppfdx45xo6eIMx', 'task_Ix8t4HnjAhX6HilQxdVtZ'],
  revenueCashback: ['task_YzhS2L2gCCpSVWTSaDWQU', 'task_ie0cYRfwd7Oo8HZ3hFWPf', 'task_05LE4so7mcJ6r0fLWuprn', 'task_vr45efhdsoFyNHBpf8Wbu', 'task_a5m1QZ8U3pZyJ0phdu5zN'],
  i18nFiveLanguages: ['task_0cNq52keLT3UUZU3Lishv', 'task_sDCOiDAyLLGsKHKOZBESk', 'task_IYPQ0URUWFVviVjgKo4a7'],
  identityCapability: ['ag_7mydzYDVqV45jmZwsoYLgpXNP9mXUAUgqw3ktUzNDnB2', 'ag_B5zSYZKWTUcpASxzhzt76HmpHEyum5buQTdK4Cku5CPp'],
  tradeCost: ['ag_3QzZnw9GpaXuKo2y4nSbRzroYorvhxwtnZjHoBbDhy3G', 'ag_4ec5PpYMPituDpdeDPvtAufVmjdF2n7WWqHZcqXz8Urr'],
  openclaw: ['ag_5zNfpjdX3WyVJa6jzHLgWkDvbGnM25hoXHRN7eNYgJbS', 'ag_6LVNJPR9K2NigCsFAySuLtzLiv8RE3QGLdEvDRXEJY6i'],
  openapi: ['ag_2cBEmiBTh1xnCML21dTaDpNN36zVLydmpcBuC9aqDjPk', 'ag_7jAVWXXtJJsP9ziX7iYEyFUhHQtpEcPWSHiZmuEzU33N', 'ag_B62ZmbCCADN1uchbXbAwZZFDU9y2NjUW14pYNsCQHh1R'],
  markdown: ['ag_qMNES8YTUUSknbaw7qdUpiiRxk3UpAw4xeq3qjF8jzM', 'ag_9FVNMboUgEWEBgqsoqjhdgMqgixUGM8f6aXGF8vgTxV8', 'ag_41W67MnYQuKbu6nmTunM1DWZ9mm5i5CiU41VS3NrSnDh'],
};

// The agent-side families are not guesses: each is the complete set of registry records that
// declare the capability/offer/protocol the query names, read out of the crawled agent data.
// Each declaration is rare (1-3 holders of 768), which is what makes the expected set checkable.
// An earlier draft of this file asserted top-1 ids for these queries without checking; four of
// the seven it asserted were wrong.
const RAW = [
  { id: 'q01', q: 'rust sdk', type: 'task', expect: 'task_qqhErrWDMbvhrw8YcUogY', why: 'only task naming a Rust SDK' },
  { id: 'q02', q: 'swift kotlin mobile client', type: 'task', expect: 'task_fijeWCQ0IlVqQKAWbev4W', why: 'only doc naming both Kotlin and Swift' },
  { id: 'q03', q: 'x402 facilitator base sepolia', type: 'task', expect: 'task_HZZfCxOvNlhUNCPMjOaqH', why: 'only task naming x402 facilitator + Base Sepolia' },
  { id: 'q04', q: 'full text search', type: 'task', expect: 'task_OEayIc3UCcwT8PvXNPix3', why: 'the search-service task is titled exactly this' },
  { id: 'q05', q: 'foundry escrow contract test', type: 'task', fam: 'escrowPrototype', why: '4 identical ESCROW_CONTRACT prototypes' },
  { id: 'q06', q: 'wasm auditor', type: 'task', expect: 'task_dBhBPrBGRrlAwQu49042O', why: 'only task shipping WASM + in-browser auditor' },
  { id: 'q07', q: 'self host kit', type: 'task', expect: 'task_h5RM7LyvXnayBJyFYLfvE', why: 'the one-command self-host kit' },
  { id: 'q08', q: 'conformance pipeline', type: 'task', expect: 'task_vhlI1dlt1D4K4io8MDDTx', why: 'nightly cross-version conformance, unique title' },
  { id: 'q09', q: 'uptime latency observatory', type: 'task', expect: 'task_djvTLOzkwg5Nz3YCNG6bk', why: 'uptime/latency observatory, unique title' },
  { id: 'q10', q: 'settled payments chain data', type: 'task', fam: 'settledFeed', why: '3 identical settled-payments feed tasks' },
  { id: 'q11', q: 'api reference book', type: 'task', fam: 'apiReference', why: 'exact bm25 tie across 3 identical titles' },
  { id: 'q12', q: 'concurrency 50 agents', type: 'task', expect: 'task_2s8eKEy8z1eEHXXzhcJrr', why: '50 simultaneous agents, unique to that task' },
  { id: 'q13', q: 'load profile limits', type: 'task', expect: 'task_hZE1d24iUMhJdPBjhqQhX', why: 'load-profiling a local instance' },
  { id: 'q14', q: 'agentsig portable c99', type: 'task', expect: 'task_Rre9tr3U54dRIuIiZnhyb', why: 'portable C99 AgentSig' },
  { id: 'q15', q: 'escrow wallet usdc neighborhood', type: 'task', fam: 'usdcNeighborhood', why: '3 identical two-hop USDC neighborhood maps' },
  { id: 'q16', q: 'industrial sentinel revenue guard', type: 'task', bounty: 'paid', fam: 'revenueGuard', why: '5 identical titles; bounty=paid must keep paid rows on top' },
  { id: 'q17', q: 'swarmmemo tool friction', type: 'task', expect: 'task_UhQWS3p5OOHCqVQg3TD1G', why: 'SwarmMemo tool-friction task' },
  { id: 'q18', q: 'revenue cashback', type: 'task', bounty: 'paid', fam: 'revenueCashback', why: '5 identical paid titles; must outrank the free Sentinel trials' },
  { id: 'q19', q: 'identity anchoring agent', type: 'agent', fam: 'identityCapability', why: 'exactly 2 of 768 agents declare the identity capability' },
  { id: 'q20', q: 'peer verification agent', type: 'agent', expect: 'ag_7mydzYDVqV45jmZwsoYLgpXNP9mXUAUgqw3ktUzNDnB2', why: 'exactly 1 of 768 agents offers peer-verification' },
  { id: 'q21', q: 'trade cost calculation agent', type: 'agent', fam: 'tradeCost', why: 'exactly 2 agents offer trade-cost calculation' },
  { id: 'q22', q: 'openclaw', type: 'agent', fam: 'openclaw', why: 'exactly 2 agents declare the openclaw protocol' },
  { id: 'q23', q: 'openapi', type: 'agent', fam: 'openapi', why: 'exactly 3 agents declare the openapi protocol' },
  { id: 'q24', q: 'markdown', type: 'agent', fam: 'markdown', why: 'exactly 3 agents declare the markdown protocol' },
  { id: 'q25', q: 'five languages translation', type: 'task', fam: 'i18nFiveLanguages', why: '3 identical i18n five-language tasks' },
];

export const QUERIES = RAW.map(r => r.fam
  ? { ...r, family: FAMILIES[r.fam], top3: FAMILIES[r.fam].slice(0, 3) }
  : { ...r, top3: [r.expect] });

// Reciprocal rank of any judged target: a single id, or any member of a family.
export function rr(ranked, q) {
  const targets = new Set(q.family || [q.expect]);
  const i = ranked.findIndex(r => targets.has(r.ref) || targets.has(String(r.id).split(':')[1]));
  return i === -1 ? 0 : 1 / (i + 1);
}

export function isJudged(q) { return Array.isArray(q.top3) && q.top3.length > 0; }

export function targetsOf(q) { return new Set(q.family || [q.expect]); }

// DCG over graded gains: 3 = an expected_top3 member, 1 = any other returned document, 0 = not
// returned. Giving every returned row gain 1 (the previous build) made nDCG unable to see
// ranking quality at all.
export function dcg(gains) {
  return gains.reduce((s, g, i) => s + (g > 0 ? (2 ** g - 1) / Math.log2(i + 2) : 0), 0);
}