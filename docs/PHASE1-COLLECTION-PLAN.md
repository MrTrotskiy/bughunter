# Phase-1 Full-Collection Plan — authenticated SPA

Status: **FIRST STONE BUILT** (2026-07-16, cto-validated D1–D5, code Opus); Layers 2–5 remain PLAN.
The Layer-1 exhaustive-traversal engine + its fail-reason histogram ship: `/recon` runs until DRAINED-or-STALLED
(not `cap 20`), `frontier-cli --emit` returns `frontierInstanceStats` + a `progress` verdict, `whats-new` writes
the `act.failed` seam, and `report --unreached` renders the histogram (see `decisions.md` 2026-07-16 + CHANGELOG).
The NEXT stone is chosen BY the histogram once a fresh authed run measures the dominant class (§6). Synthesised
from three independent Fable passes — code-architect, industry-SOTA survey, and a code-vs-code validation against
the abandoned reference `bughunt-agents`. Companion artifact (Russian, presentation form): the target-architecture
page published this session. This file is the canonical, English, checked-in version.

The goal: exhaustively collect the **whole reachable authenticated SPA** (the target host — antd/React,
the entire app under one URL, navigation swaps content client-side over POST), not a budget-bounded slice.

---

## 1. The honest bar — what "full collection" actually means

Do **not** target the reference's raw inventory (186 controls / 38 endpoints / 11 states). That number is
discovery inventory, and its JOIN is mostly broken (see §2). The real bar is **fewer-but-causally-joined**
controls + a working CRUD lifecycle:

- every reached control causally attributed to the endpoint(s) it fires (token ∧ CDP initiator, never wall-clock);
- the honest non-collapsing coverage denominator preserved (opaque regions flagged, never hidden);
- mutations collected only through a safe, cleaned-up path (§Layer 4), never by firing creation controls on the live account.

On the only metric with value — causal join — bughunter is **already ahead** of the reference (§2).

## 2. Reference reframe — "collected more" is a myth on join quality

Fable CTO read the reference's final `state/brain-index.json`. Breadth is raw discovery; the connected
knowledge is largely empty — and that (plus a 1038-line `recon-network.mjs` god-object and two unconnected
identity systems) is what killed it, **not** an unfixable attribution mechanism (the reference had already
evolved to the same token+initiator machinery).

| Metric | Reference "collected" | Actually CONNECTED |
|---|---|---|
| controls | 186 | probed/clicked — **64 (34%)** |
| endpoints | 38 | causal control→endpoint — **16** (other 22 page-level only) |
| control→endpoint attributions | 134 | but probed 64 → **~70 NON-causal** (page-inherited = the wall-clock class) |
| construct→endpoint | 52 constructs | **0/52** (two identity systems never joined) |
| self-CRUD | "lifecycle" | create 1 / update 0 / delete 0 = **~0** (collapsed identity killed per-row addressing) |
| causal edges in the final request-graph | 93 edges | **0** (causality lived in a side file, never merged) |
| ws-frames / functions | — | **0 / 0** on this target |

Takeaway: recover the reference's **breadth** without its false edges; we are already past it on join quality.

## 3. Diagnosis (measured + one flagged hypothesis)

From the last live authed run and a code read:

- **Reach depth-N is already built** and is NOT the bottleneck. `reveal-replay.mjs` accretes a depth-N
  reveal path (`revealPathFor`, `REVEAL_MAX_DEPTH=10`), replayed under `__idle__` in both fronts
  (`recon-run.mjs`, `whats-new.mjs`), with cycle-guard + per-step danger-floor.
- **Coverage: 10 genuine explored / 6 unreachable / 33 UNEXPLORED** of 49 templates; 204 instances; 3 routes;
  26 causal edges. Critically, **33 of 39 uncovered are `unexplored` (not reached, but reachable)**, not
  `unreachable` — the loop stopped early, it did not hit a reach wall.
- **The artificial stop is `cap 20`** in the `/recon` driver (`.claude/commands/recon.md`, "budget-bounded,
  not exhaustive").
- **Flagged HYPOTHESIS (unmeasured):** throughput floor ≈ **0.8 template/window** (16 templates over ~20
  windows; nominal 2–5). Windows appear eaten by opener-siblings (2 high-cardinality openers hold most of
  204 instances; `OPENER_INSTANCE_CAP=8` emits 8, flags the rest as `cappedRemainder`). If true, **removing
  cap-20 alone is insufficient** — an exhaustive run just becomes long and still incomplete. This is exactly
  what the first stone MEASURES.

So the gap is **traversal policy + observability + resilience**, not a new reach mechanism.

## 4. Target architecture — 5 layers on one untouched core

The core (graph + causal substrate + reveal-replay + danger-floor) is built and proven; **no layer touches
it**. Every layer is additive or wraps the core, and is designed to preserve every hard invariant.

**CORE (built · green)** — `graph.json` ← `mergeSnapshot` ← two-level identity (template + instance).
Attribution = token (`probe.mjs`) ∧ CDP initiator (`initiator.mjs`), decision frozen in `selectKept` without
await. Reach = `applyReveal` under `__idle__`. Danger = `danger-floor.mjs`.

### Layer 1 — Exhaustive Traversal Engine  *(first stone)*
Terminate on **drained-or-stalled**, not cap-20. DRAINED = empty batch ∧ `frontierInstanceStats.remaining===0`.
STALLED = non-empty batch ∧ Δcoverage=0 over K windows → print the fail-reason histogram. Safety ceiling is a
large hard cap + a stall-detector over `state/recon-progress.json`, giving the DRIVER file-only-handoff
resumability (re-running `/recon` continues from where it stopped). The perceptron invariant (2–5 templates
per context window) is preserved — there are simply many windows that continue one another. Cap-removal and
novelty-first reorder are sub-details **inside** this engine, not the answer.

### Tool — Fail-Reason Histogram  *(first stone; threads all layers)*
Read-only `report.mjs --unreached`: a read over `graph.json` + the run's `runs/<id>/events.ndjson` →
distribution over `{unexplored, not-visible, NO_INSTANCE, REVEAL_STALE, REVEAL_TOO_DEEP, REVEAL_CYCLE,
danger-floor, cappedRemainder}`. NOT a pure function of the graph alone: on the AGENT path (the only path
`/recon` drives) the graph holds only the COARSE `observe` effect (`unreachable-coldstart`/`not-visible`); the
granular reason codes live ONLY in the trail. So a PREREQUISITE seam is an `act.failed` trail event written
at throw time in `whats-new` (a failed act otherwise writes to neither graph nor trail) — the histogram reads
its granular half from those events, its coverage half from the graph. `never-discovered` is structurally
uncountable (you cannot enumerate what was never found) — the histogram names the limit, never invents a count.
On the route-collapse axis it must **FLAG** route-collapse-UNEXPLORED (POST-nav locations collapsed under one
`routeKey`) as `pending-INC.3` — it CANNOT split it from budget-UNEXPLORED before INC.3, because the graph
carries no location identity beyond `routeKey`; any split now would be a heuristic the invariants forbid. That
honest flag is itself the signal that on the first target the dominant class is the INC.3 frontier-key class, not the
L1 budget class. This is the go/no-go artifact the project's empirical discipline requires before L2/L3/L4.

### Layer 2 — Resilience at Scale  *(new · measure-gated)*
`resolveHandle(page, inst)` tries the already-derived durable `locator` (testid > stable-id > role-name > css)
before the raw, drifting `instanceSelector` — kills the `NO_INSTANCE` stale-selector class ([20] user-menu).
It is resolve, **not** re-key: identity still keys on the selector string, zero churn. Reveal-group
amortization (a disciplined INC.4: per-sibling `resetTrackerVerdicts` + dirty-branch detection + fallback to
full replay-from-reset) opens the shared reveal prefix once per window — but ONLY behind a live measurement
that reset-cost dominates act-cost, plus its own ADR. This is the single layer where a wrong step can
resurrect the reference-killing phantom-edge class.

### Layer 3 — POST-nav Openers  *(new — the [9]/[45] class)*
Semantic entry exists: the agent judges read-vs-mutation and stamps `--opener-replayable`; danger-floor
refuses destructive/auth/payment by name. **New structural net — replay-time write-firewall:** during replay
(which must be side-effect-free) `page.route` aborts any non-GET outside the opener's recorded read-endpoint
allowlist. This turns the agent's trusted judgment into a hard constraint: a mocked write makes replay fail
honestly → unreachable, account unmutated. Boundary: read-POST → children genuine; mutation-POST → children
honestly unreachable → handed to Layer 4. Implementation risk (not architectural): the handler must be removed
BEFORE the measured act, or it aborts the legitimate non-GET that the measured act fires.

### Layer 4 — Safe Mutations  *(separate actor phase)*
Key decision: **the read-crawl never mutates the live account.** A new danger-floor class `mutation`
(create|add|new|post|share|submit|upload|send|publish|comment|save) makes the read phase refuse to FIRE and
stamp `effect=mutation-deferred` (symmetric with destructive). A separate post-recon ACTOR phase consumes the
mutation class: fills HUNT-tagged data, writes a `CreatedLedger` (`state/created.json`) with an inverse-delete
plan, and runs a guaranteed cleanup pass (try/finally + resumable ledger) deleting ONLY HUNT-tagged artifacts —
which is also the delete-half of self-CRUD. Separate because a crash mid-read-crawl must not orphan HUNT data.

### Layer 5 — Data Completeness (breadth)  *(new · additive)*
- **Contract shapes:** promote already-trailed redacted bodies into `graph.requests[key].reqShape/respShape`
  (keys + types, NOT values) on the request-node (endpoint-level; values are per-instance and masked).
- **WebSocket split:** the socket OPEN is causally attributed as a normal request (control→socket edge);
  FRAMES go to a new `graph.sockets{}` node type as inventory (`page.on('websocket')` → frame payloads) with
  **NO** `triggers` edge — WS frames are async, outside the causal window; never time-attribute them.
- **Auth-scope:** a read-only `auth-diff.mjs` over TWO graphs (anon vs authed) → {anon-only, authed-only,
  shared}. NOT one graph with a flag (denominator conflict).

## 5. First stone — and why it is not a half-measure

Three parts ship together as **one component** — the Layer-1 engine plus its tool:

1. `report.mjs --unreached` — the fail-reason histogram (read-only pure function), **with the route-collapse
   vs budget distinction**.
2. `frontier-cli --emit` also returns `frontierInstanceStats` (already computed in `frontier.mjs`; just plumb
   the envelope).
3. `/recon` driver: `cap 20` → **drained-or-stalled** + large hard-ceiling + `recon-progress.json` resumability.

Why it is the answer, not a half-measure:
- It IS the traversal engine (drain, not budget) — it directly fixes "stopped at 10/49".
- It produces the measurement the invariants REQUIRE before L2/L3/L4 — building a write-firewall or
  durable-resolve without it violates the project's empirical discipline.
- Blast radius is minimal: read-only + driver doctrine + one additive envelope field. The core is byte-identical.
- Cap-removal and reorder take their honest place as sub-details inside it.

Order: histogram → run the **current** authed graph through it (no new crawl needed for a first signal) →
measure the dominant class + throughput floor → the engine. The second stone is chosen BY the histogram:
`never-discovered` → reorder/throughput; `REVEAL_STALE`/`NO_INSTANCE` → Layer 2; `unflagged-POST-opener` or
route-collapse → Layer 3 / INC.3 frontier-key.

## 6. Live measurements required before further stones

All read-only, from the already-collected trail:
1. **Throughput floor (critical):** decompose 0.8 template/window — windows eaten by opener-siblings vs
   danger/unknown skips vs errors.
2. **Dominant class** in the 33 unexplored + 6 unreachable — selects the second stone.
3. **Reset-cost vs act-budget** — the gate for Layer-2 amortization (INC.4): open it ONLY if nav-time
   dominates wall-clock.
4. **antd overflow** — does it mount overflowed tabs as new portal nodes or un-hide baseline? Determines
   whether a hover-primitive is needed.

## 7. INC.3 dispute — resolved

The POST-nav state-distinction axis IS needed (industry: Burp keys locations by content, not URL), because on
the first target all POST-nav pages currently collapse under one `routeKey` (`scope.mjs`) — the [9]/[45] blocker.
But implement it as a **frontier dedup KEY** (url + method + payload-shape, the Crawlee `useExtendedUniqueKey`
pattern), **NOT** as a parallel `graph.states{}` DOM-identity. A second DOM-identity is exactly the reference's
trap (two unconnected identities → construct 0/52). Invariant to hold: the payload-shape must never leak into a
graph node's identity or into a causal edge — it is a frontier-layer hint only.

## 8. Honest boundaries — what will NOT be collected, and why that is correct

- **Adaptive/hostile GET→POST body-swap** on the same selector — the firewall catches non-allowlist writes, but
  a same-path swap inside the body of a known read endpoint passes. Unresolvable by click-replay without server
  semantics. Boundary is honest; we do not claim protection from a hostile adaptive target.
- **Hover-only reveal** (`…more` opens on hover, not click) — neither panel-reach nor click-replay reaches it.
  A separate hover-primitive increment, opened by the histogram, not speculatively.
- **Closed shadow DOM / canvas / cross-origin iframe** — structurally invisible, flagged opaque, never hidden.
  An honest limit of perception, not a bug.
- **Mutation-class controls stay `mutation-deferred`** in the read phase until the actor phase — correct: the
  read-map must not touch the live account.
- **Multi-step / SSO / OAuth / 2FA + mid-crawl session-expiry** — single-form auth is built; the rest is behind
  an ADR gate (no second target requiring SSO yet).
- **Trusted read-vs-write judgment** — firewall + per-opener cap drive blast radius to ~0 but do not eliminate a
  logical misclassification. The double net (floor by name + firewall by method) is the accepted bound.

## 9. Success conditions + operational gaps

The plan reaches / exceeds the reference IF:
- (a) the histogram is built and run FIRST (an honest go/no-go);
- (b) the second stone is chosen BY the histogram, not by taste (on the first target almost certainly the INC.3
  frontier-key, because L1 alone lifts a single-URL SPA only moderately);
- (c) Layer-2 amortization stays behind a live reset-cost measurement + its own ADR;
- (d) **drill-selection discipline** (one representative per list) is explicitly written into L1/frontier —
  otherwise detail pages are either unreached or they blow the budget. This is the single operational breadth
  gap the reference exposes (it capped `DRILL_PER_LIST=1`).

Open items to resolve on a fixture before the plan leans on "mechanism ready":
- The **"depth-2" doc contradiction** is a NAMING collision, not a functional one (resolved 2026-07-16, verified
  against `cdc9605` + `panel-reach.test.mjs`): "depth-2 panel reach" — uncovering a control PRESENT at baseline
  but hidden behind ONE opener (an antd "…more" → tab) — IS built and fixture-proven. What CLAUDE.md lists as
  "still unbuilt" is the "depth-2 CHAIN" = TWO sequential in-app hops (open-panel → tab → content) plus per-row
  instance reveal-paths. Both statements are consistent under that distinction; no line is stale.

## 10. Provenance & invariants

Provenance: three Fable passes (code-architect target architecture · industry-SOTA survey · code-vs-code
validation against `bughunt-agents`) + facts from the last live authed run. Base (GAP-2 / INC.1 / panel-reach /
div-soup / login-hardening) is committed and pushed — sequence risk closed.

Hard invariants every layer preserves: causal attribution = in-page token ∧ CDP initiator (never a wall-clock
window) · one two-level identity (template + instance), never a second identity or a re-key · honest
non-collapsing denominator, opaque regions flagged · danger-floor (destructive/logout/payment never fired;
node-loop is unsafe on a live authed account, so live = agent-path only) · perceptron windows (2–5 new
templates/window, anti-context-blowup) · model split (Fable → architecture, Opus → all code, Sonnet → clicking) ·
SSRF gate · secrets outside git.
