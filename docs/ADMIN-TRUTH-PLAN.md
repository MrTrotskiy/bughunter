# Admin truth plan — make the viewer stop lying, and record every decision

Status: PROPOSED (2026-07-21). Evidence: run `fix1` (1092 events, 200 acts, 693 instances, 228 graph
snapshots). Three independent Fable agents produced the decision contract, the truth audit (52 claims)
and the screen design; this file reconciles them into one ordered plan.

THE OPERATOR'S REQUIREMENT: know every movement of the script AND the agent, and the REASON for it —
why it pressed, why it did NOT press, why it went there. The admin introspects OUR crawler, never the
target app: a 500 on the target is data recorded for Phase 2, not a screen we build.

## Why two code reviews passed a lying screen

None of the defects are visible in a diff. Each is an inconsistency BETWEEN three layers that are
individually correct: the writer writes the field, the projection drops it, the renderer prints its
"field is absent" branch. The invariant review read the writer, the quality review read the renderer,
and nothing executed them together against real data. Compounding it: every sentence the failure card
prints lives inline in `admin.html` (1277 lines) and is therefore unreachable by any `node:test`.

Three defect classes, all three must be closed or the class returns:
- **A. Lost field** — writer → projection drops → renderer claims "not recorded".
- **B. Unconditional sentence** — prose about the run hardcoded, with no field licensing it.
- **C. Inert mechanism** — a lookup / threshold / detector that never fires on a real trail.

## Stage 0 — precondition (no gate is possible without it)

Extract the text-producing functions out of `admin.html` into `lib/debug/walk-view.mjs`: `actSummary`,
`stepDetailHtml`, `failurePanel`, `verdictOf`, `outcomeOf`, the KPI strip, `sectionCounts` — pure
`(step, graph, run) → string`, zero DOM. Precedent: `pipeline-shell.mjs` was split out the same way and
`admin-server.mjs` serves it through a one-line allowlist branch. Also repairs the <200-line convention
on a 1277-line file.

## Stage 1 — stop lying (rendering only; every datum is already on disk)

Ordered by measured operator harm.

1. **The headline coverage number is wrong.** `118/295` is printed under "изучено контролов" — those are
   TEMPLATES. Instance truth from the graph the page already loads: `148/693` = 21.4%. The label inflates
   40% against 21.4%; this would be the project's fourth inflated headline. Print the instance number and
   the split beside it: 373 declined by our own sampling policy vs 141 genuinely owed.
2. **"список попыток не записан" on 39 of 39 failures.** Each `act.failed` carries
   `target.attempts` — 6 per-strategy records with `ran/raw/visible/sameTemplate`. Cause: `deriveSteps`
   does not carry `target` while its sibling `derivePipeline` does. One line. Also restores
   `hadRevealPath`, so the walk stops contradicting the pipeline about the same act.
3. **«Находки» declares impossible what is in the payload.** 5×500 + 1×422 are in `requests[].status`;
   the stub says the status does not reach the step and tells the operator to re-run the crawler.
   `stepDetailHtml` renders 2 of the 7 request fields, discarding `status` and `durationMs`.
4. **The stage is blank on all 200 steps and blames the step.** "кадр не снят для этого шага" is a
   run-level fact (`BUGHUNTER_VIEW=1` was not set), and 39 DOM skeletons ARE written and ARE served by
   `admin-server` — the viewer never mentions `skel`.
5. **"Отмечен недостижимым. Недостижимых: 39"** — two errors in one line on the card opened when
   something broke: the wrong quantity (39 failed acts, not 21 unreachable controls) and the wrong
   verdict (a `DISABLED` FINDING and an `OUTWARD_REFUSED` policy decision are both labelled unreachable).
6. **Stubs that deny existing capture.** «Обход» claims a page visit is not recorded as its own event —
   four kinds record it (`drain-outcome` 87, `route` 67, `route-choice` 66, `retire` 62) — and prints 19
   under "страниц в этом прогоне" while 65 were visited.

## Stage 2 — the gate, so the class cannot return

One unit file, no browser, no DOM: `tests/unit/viewer-truth.test.mjs`.

- **Carrier — golden trail fixture** `tests/fixtures/trail-golden/`: a masked ~120-event slice of a real
  run (hosts, control names and ids → placeholders; codes, payload shapes, statuses and structure kept
  byte-for-byte). Must contain ≥1 event of each of the 13 kinds, ≥1 act per failure code, ≥1 request with
  status ≥500, ≥1 `target.attempts`, ≥1 `hadRevealPath:true`, `notFoundSig` with zero `contentSig`, and
  acts with `shots.before === null`. A synthetic happy-path fixture is what would miss all of this.
- **Core — claim registry** `lib/debug/claims.mjs`: every operator-visible sentence is a record with TWO
  predicates, `licensedBy(view)` and `contradictedBy(event)`. Three assertions:
  1. *Contradiction* — no event may satisfy both. Catches class A mechanically. **Red today** (39 + 5).
  2. *Conditionality* — every claim must both render and not-render somewhere in the trail. A sentence
     true on 100% of rows has no data behind it. Kills class B.
  3. *Completeness* — scan Cyrillic literals in the view modules; any sentence longer than N words must
     appear in the registry, or the registry rots within a month.
- **Liveness** — each classifier declares a minimum firing rate on the golden trail: `KIND_STYLE` covers
  ≥90% of rows (today 24.5%), `foldAll` yields ≥1 fold (today 0), every `DECISION_KINDS` key must occur
  in the trail (today none of the three is emitted by any writer). The failure message prints the NUMBER,
  not "assertion failed". Kills class C.
- **Writer-reader parity** — every field a viewer reads must have a writer on the DEFAULT (stateful)
  path. **Red today** on `contentSig`: `route-coverage.mjs` filters on it, only `visitRoute` writes it,
  `stateful-loop` never calls `visitRoute`, so the client-404 detector reports zero findings on 88 routes
  and that zero is presented as a result.

FAIL-ON-REVERT levers (each verified by hand per `tests/CLAUDE.md`): drop `target` from `derivePipeline`
→ contradiction assertion reds naming 39 events; make the "model decides nothing" claim unconditional →
conditionality reds at 1092/1092; remove `'route'` from `KIND_STYLE` → liveness reds with the coverage
percentage; restore the fixed 1000 ms budget → slow-flag rate reds at 98.7%; read `contentSig` without a
writer on the stateful path → parity reds naming 0 of 88.

## Stage 3 — the stub rule

**A stub may describe its own absence. It may never describe an absence of data.**

- About itself: a constant. About the trail: a predicate evaluated against the LOADED run at render time;
  if the predicate is false the block does not render at all. `STUBS` stops being an object of constants.
- A gap must name the floor it is on: *capture does not write this* / *the projection loses it* / *the
  screen does not draw it*. "Статус не доезжает до шага" described a rendering defect as a capture gap
  and sent the operator to re-run the crawler.
- A number carries its population in its label — `19 из 65`, never a filtered number under an unfiltered
  caption.

By this rule `walk`, `finds` and half of `cover` stop being stubs today, with no new run: they are
unrendered existing data.

## Stage 4 — the row vocabulary and the conclusions

- **13 kinds, 3 styled.** 825 of 1092 rows (75.5%) fall to the default badge and 438 render a raw English
  kind name in a Russian UI; 317 policy verdicts render as a bare control name, indistinguishable from an
  unnamed stage. Every kind gets a Russian label and a sentence that names the ACTION, the ALTERNATIVES
  and the RULE — a route choice names what it passed over and why, a pick names how many candidates and
  the ranking rule, a refusal names the gate and the evidence.
- **Fold the CYCLE, not the row.** The existing folds produced ZERO on 1092 real rows because they demand
  adjacent rows and something always sits between them. The natural unit is the page-drain cycle; a cycle
  that produced no acts collapses to one line — **fires 54 times on `fix1`**. Consecutive identical policy
  verdicts fold with a counter. Both expand on click: folding is a reading aid, never a filter.
- Outliers, unlike folds, already work (3 anomalies, 49 slow rows) — do not touch them.

## Stage 5 — the «Покрытие» screen (the answer to "почему не нажал")

A registry by OWNER, partitioning all 693 instances with zero residue: 148 walked, 141 genuinely owed,
373 declined by our sampling policy (site-cap 273, list-row sample 53, widget chrome 44, opener-cap 3),
13 taken by re-render churn, 18 unreachable. "We declined on purpose" and "we could not" are kept apart
by STRUCTURE — physically separate tables with their own subtotals — never by colour or caption.

Structural dependency, the only one in this plan: the numbers come from `frontierInstanceStats` in
`lib/recon/frontier.mjs`, which is not in the `admin-server` module allowlist. Either add a branch or
compute server-side.

## Stage 6 — new capture (the decision record)

- **`frontier.census`, one per drain, plus a first-time-only row per instance.** This is the event that
  answers "почему не нажал". Do NOT emit per candidate per pass: measured, that is ~33 500 events and
  ~16 MB per run, and this project has already been burned twice by exactly that (a census counted eleven
  times reported a tenfold inflation). Aggregate + first-time-only is ~+45% events and explains all 386
  never-offered instances by name, once.
- **Name the rule AT THE SITE THAT APPLIES IT.** The largest bucket is currently mislabelled: 273 of 386
  instances are reported as an authored-testid site-cap leftover, but every large template has exactly ONE
  distinct testid, so the key is never built and control falls through to a "one representative, no
  authored key" fallback. Today we would answer the operator's question with the wrong rule.
- **`driver.open`** — the run currently records no driver, argv or flags, so "script or agent" must be
  inferred from which kinds appear, and the viewer instead hardcodes the claim. One event kills that.
- **`route.skip` + the `markRouteVisited` ordering fix**: a route rejected from the queue is stamped
  visited BEFORE the eligibility test and is then counted as mapped. This is a coverage-number bug, not
  only a logging gap.
- **`gate` events at all 8 sites in `step.mjs`, permits and refusals, in both modes**, carrying the
  ownership-proof cost. Do NOT put timings on `policy-verdict`: `decide()` is a pure synchronous rule
  table with no I/O; the cost is in the DOM ownership probes that precede it. Measured, that proof eats
  30.4% of wall clock — more than the acts themselves (26.0%).
- **`drain-outcome.rule`**: four distinct stop rules currently collapse into the single string `drained`,
  which is 67 of 87 outcomes.
- **The one real capture hole**: 3314 candidates lost on rank and only a counter survives. 374 rejection
  records with reasons ALREADY exist in the trail and are rendered by nothing — that half is a rendering
  gap, not a capture gap.

## Numbers that will MOVE, and must not be slipped in silently

- Fixing `markRouteVisited` lowers the mapped-route count (65 today).
- Applying the route alias in `retireLeftovers` will start judging leftovers that were invisible, so
  `unreachable` rises from 0.
- The headline changes from 40% to 21.4% because the current one counts the wrong population.

Each is a correction, and each is a headline number: per the project rule, audited by another agent
before it is quoted, and reported as a correction rather than a regression.

## Sequencing

Stage 0 → Stage 1 (all rendering, data on disk) → Stage 2 (the gate, red today on real defects) →
Stage 3-5 → Stage 6. Stages 0-5 need no new crawl. Only Stage 6 changes what the crawler writes.
