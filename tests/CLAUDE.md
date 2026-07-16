# tests

Test-authoring doctrine for bughunter. Auto-loads when working under tests/. The point of every rule below: a test that cannot fail is worse than no test — it reports safety that is not there.

<invariants>
- IMPORTANT: FAIL-ON-REVERT is the anti-vacuous gate. Every behavior test carries `// Guards: <capability it protects>` and `// FAIL-ON-REVERT: <how to break it>`, and is PROVEN red by reverting the guarded code before it counts. Undo the mechanism → the test must go red with a useful message → restore. A test never revert-proven does not count as coverage.
- A test guards a NAMED class of regression. No guarded capability → delete the test. Keep the live-guard index at the bottom of this file current in the same change.
- Behavior or delete. No `assert(true)`, no "ran without throwing", no snapshot-only, no asserting an element merely exists. Assert the OUTCOME (attributed request, instance count, exit code, envelope field).
- Layer rule: pure function (envelope, host-policy, id ledger, url-pattern mask, classifyInitiator, settle predicates) → unit (tests/unit/, node:test, NO browser). Anything needing a real page (dom-snapshot, causal attribution, whats-new end to end) → live (tests/live/, real chromium + local fixture). Crossing the browser boundary → ONE live test, not many.
- Live tests drive a REAL chromium against a REAL local fixture. Never stub the page, CDP, fetch, or the graph. The fixture MUST exercise the real traffic classes (load-burst, background poll, click-caused request) — a happy-path-only fixture makes causal attribution vacuous.
- Prove the HARD case. The causal test MUST include the adversarial in-window background poll; asserting only the click request passes even with the token alone (the bug that killed bughunt-agents). Assert both that the raw ring WOULD miscredit it and that attribution drops it.
- Wire before DOM. Assert the attributed request (the control→request contract, bughunter's whole value) before or alongside the revealed elements.
- No sleeps as waits. Use the settle predicate (waitSettled / deriveNetworkSettled), never a timer to "let it finish". A setTimeout is allowed ONLY to force an adversarial condition (hold the window open so a poll must tick) — and then assert the condition actually occurred, else the guard is vacuous.
- Isolate. Tests write to a temp BUGHUNTER_STATE_DIR, never repo state/. Ephemeral ports (listen 0). PW_ALLOW_PRIVATE=1 for loopback fixtures. Tear down server + tmp dir in t.after.
- CDP-only mechanisms (the initiator classifier) are asserted honestly: a test must not pass on the token alone. Where a mechanism is chromium-specific, say so in the test.
</invariants>

## Layers
| Layer | Dir | Deps | Guards |
|---|---|---|---|
| unit | tests/unit/ | node:test only | pure fns: SSRF classification, id ledger, url-pattern mask, classifyInitiator over synthetic CDP stacks, settle predicates |
| live | tests/live/ | real chromium + tests/fixtures/ | dom-snapshot identity, causal attribution, whats-new end to end |

Fixtures live in tests/fixtures/ (shared). A fixture is source: it must model the real traffic classes it exists to test, documented in its header.

## Process
1. Write the failing test FIRST, with `// Guards:` + `// FAIL-ON-REVERT:` headers. Confirm it is RED against the unfixed code.
2. Implement to GREEN.
3. Revert-verify: undo the guarded code, rerun, confirm RED with the recorded message, restore. Record the sentinel fragment in the header.
4. Run `npm test` once at the end; report numeric pass counts.
5. Review against these invariants; every finding cites the rule + a 1-3 line fix shape. Code authoring is Opus; this doctrine and review are Fable.

## Live-guard index
Each live capability guard → test path (revert-verified).
- causal attribution drops in-window background polls — tests/live/whats-new.test.mjs
- two-level identity: one template, N addressable instances — tests/live/whats-new.test.mjs
- recon loop composes frontier + causal capture on a live browser: attributes the caused edge, drains the frontier — tests/live/recon-loop.test.mjs
- recon tool chain (baseline → emit → act → observe) persists causal edge + semantics and drains the observed template — tests/live/recon-sequence.test.mjs
- the fire path refuses to click a destructive control and fires no request (DANGER_FLOOR before the click) — tests/live/danger-gate.test.mjs
- one browser for the whole crawl, not one per act (launch-count guard) — tests/live/recon-loop.test.mjs
- attach() connects to the shared daemon (mode 'attached'), one process serves N acts — tests/live/daemon.test.mjs
- the CDP initiator classifier still rejects an in-window poll over a chromium.connect() session — tests/live/daemon.test.mjs
- reused page (persistentStep) does not mis-credit an earlier act's foreground path to a later act's same-path background poll — tests/live/cross-act.test.mjs
- the fire path fast-fails NOT_VISIBLE on a DOM-present-but-hidden control instead of hanging the 30s click timeout — tests/live/not-visible.test.mjs
- recon crawls multiple same-origin routes, attributes controls to the LANDED route, and never fires an off-origin link — tests/live/multi-route.test.mjs
- the off-origin skip is http(s)-scheme-gated: a javascript: anchor is fired, not dropped as external — tests/live/scheme-gate.test.mjs
- a cookie/consent overlay is dismissed so the underlying control becomes reachable; a non-consent accept-text control is left alone — tests/live/overlay.test.mjs
- the snapshot classifies each control's durable locator (testid/id/role-name/css) and gates test-id uniqueness (page-unique discriminator vs shared marker) — tests/live/locator.test.mjs
- debug capture rides an act (before/after key-frames + rect + per-phase timings) WITHOUT perturbing causal attribution (real edge credited, in-window poll rejected) — tests/live/capture-causal.test.mjs
- request/response BODY capture (opt-in) writes REDACTED bodies to the trail (files), keeps requests[] body-free, and re-proves the in-window poll is still rejected with capture ON; default OFF captures nothing; text/html is off-allowlist — tests/live/response-body.test.mjs
- endCause freezes the kept-set (selectKept) BEFORE any body await, so a mid-await verdict flip adds no phantom edge (white-box tracker-seam) — tests/live/response-body.test.mjs
- (unit) selectKept applies token + initiator + static filters synchronously (the kept-set decision is await-free) — tests/unit/select-kept.test.mjs
- (unit) redact.mjs redacts secret KEYS and secret VALUES (JWT/Bearer/AWS/card/SSN/email under an innocent key — the H1 bypass), walks form structurally, and is LINEAR on a pathological body (no ReDoS) — tests/unit/redact.test.mjs
- (unit) the response ledger's double-gate defaults OFF (no body without the flag+run — the login state), gates the request body on the content-type allowlist (multipart skipped), and redacts request bodies at store time — tests/unit/response-ledger.test.mjs
- (unit) bodyCaptureEnabled is the double gate: half-open (flag set, no run) → false (the login-safe default) — tests/unit/initiator.test.mjs
- (unit) the debug admin serves the trail behind a loopback Host-guard + no-CORS + resolved-path containment; a foreign Host is 403'd — tests/unit/admin-server.test.mjs
- authed recon: a login storageState makes the crawl map the logged-in surface (authed-only control present) — tests/live/auth.test.mjs (T1)
- login VERIFIES success before persisting: wrong creds never write a storageState — tests/live/auth.test.mjs (T2)
- the crawl refuses to NAVIGATE to a danger route (/logout), so an authed run never logs itself out — tests/live/auth.test.mjs (T3)
- login output carries counts only — the credentials never appear in its result envelope — tests/live/auth.test.mjs (T5)
- (unit) contextOptions injects storageState at newContext, fails loud on a missing state file, anonymous forces a clean context, and every context carries a FIXED desktop viewport (reproducible NOT_VISIBLE denominator); AND readSessionEndpoint trusts a bracketed IPv6 loopback endpoint (ws://[::1]:PORT, the macOS launchServer form) but refuses a non-loopback LAN endpoint — tests/unit/session-context.test.mjs
- (unit) isLoopbackHost is the strictly-narrower daemon-endpoint trust boundary: loopback-only (127.0.0.0/8, ::1, [::1], localhost/*.localhost) accepted, every private-but-not-loopback form (RFC1918/CGNAT/link-local/metadata) + look-alike "127.evil.com" + malformed rejected — tests/unit/host-policy.test.mjs
- (unit) routeRefused classifies /logout, /account/delete, /checkout as refused; ordinary routes pass — tests/unit/danger-floor.test.mjs
- GAP 2 stay-on-page: a control behind a depth-1 modal is reached via the replay prologue, causally attributed at depth (in-window poll still dropped, raw-ring proven), the GET-only gate leaves a POST-opener's children unreachable, and a replay hop that is stale / too-deep / CYCLIC / an off-origin link / a /logout danger route is REFUSED before the click — tests/live/stay-on-page.test.mjs
- agent-path stay-on-page: whats-new (the /recon path) replays a reveal path so a modal/panel control is reached + attributed at depth, and a POST-that-READS opener's children are stamped replayable ONLY under the agent's --opener-replayable judgment (omit it → GET-only default leaves them unstamped) — tests/live/agent-stay-on-page.test.mjs
- (unit) mergeSnapshot stamps node.reveal on NEW nodes only (first-reveal-path-wins) with ZERO id churn (ledger + diffIdentity), and frontier.nextBatch carries reveal — tests/unit/reveal-annotation.test.mjs
- (unit) identity-diff catches a re-keyed OR dropped template/instance key + dropped edge, and its CLI loader fails loud on a corrupt (present-but-unparseable) state file — tests/unit/identity-diff.test.mjs
- INC.1 framework-id de-fragmentation: framework-generated wrapper ids (`rc-*`, hashed) stop anchoring identity, so 3 antd tabs collapse to ONE template with 3 instances + a role+name durable locator (not 3 per-reload-shifting id-anchored templates); a plain semantic #id still anchors (rejection is scoped) — tests/live/framework-id.test.mjs
- (unit) the schemaVersion gate: loadGraph RESETS a legacy (no-schemaVersion, framework-anchored) graph rather than co-mingling it with re-keyed ids, and preserves a current-scheme graph intact — tests/unit/graph-store.test.mjs
- opener-drain guard (agent path): whats-new REFUSES acting a proven multi-instance opener without --instance (would else act the wrong instance[0] and record against a control never clicked) — tests/live/opener-drain.test.mjs; the drain-point twin (observe refuses template-level draining a proven multi-instance opener) — tests/unit/observe.test.mjs
- (unit) frontierInstanceStats reports the honest instance-level frontier (opener siblings walkable/walked/remaining) + cappedRemainder for opener instances beyond OPENER_INSTANCE_CAP (flagged, never hidden) — tests/unit/frontier.test.mjs
- (unit) DRILL_PER_LIST honesty: a 50-row NON-opener list-row template drills 1 representative (nextBatch unchanged) and counts the other 49 rows in `drillSkipped` (the non-opener analog of cappedRemainder — counted, flagged, never walked); a non-listRow template drills 0 extra; an opener list uses cappedRemainder, NOT drillSkipped (mutually exclusive) — tests/unit/frontier.test.mjs
- (unit) mergeSnapshot sets a write-once node.listRow from an instance's el.inRow (a row-resident template), false/absent inRow leaves it unset, once-true never flips false; AND inRow/listRow add ZERO identity churn (ledger maps identical, diffIdentity ok — never an identity key) — tests/unit/graph-store.test.mjs
- depth-2 panel reach: a control present-but-hidden at baseline (pathless) that a "…more" opener uncovers acquires a reveal path via the fill (hiddenWhenSeen + now-visible), is reopened + re-emitted, and is reached by replay [More] with its GET attributed; the pure-uncover opener is flagged even though it reveals no NEW instances — BOTH DOM orderings: tabs-first (cross-batch REOPEN) AND opener-first (same-batch persistentStep graph re-read; reverting the re-read leaves the opener-first tab unreachable, tabs-first stays green) — tests/live/panel-reach.test.mjs
- (unit) the reveal fill's genuine-coverage guard: a hidden-at-baseline instance genuinely reached (explored, not unreachable, no reveal) is NEVER reset by a later opener's fill; only a NOT_VISIBLE-drained or unacted hidden instance acquires the path + reopens — tests/unit/graph-store.test.mjs
- (unit) report --unreached fail-reason histogram: every not-fully-exercised control lands in the right bucket, the trail's GRANULAR act.failed code OVERRIDES the graph's coarse reason, a danger-floor-skipped control is surfaced as NOT covered, the honesty flags (routeCollapse:'pending-INC.3' + the no-invented-never-discovered note) are emitted, the trail readers (readActFailed filters to act.failed, latestRunId picks the most recent run) parse correctly, and report() renders the block with the route-collapse tag — tests/unit/report-unreached.test.mjs
- Layer-3 replay-time write-firewall: during reveal replay a non-GET outside the opener's OWN recorded-read allowlist is ABORTED by page.route (the mutation POST never reaches the server, trackHits stays 0) and the reveal fails honestly with REVEAL_WRITE_BLOCKED → target unreachable, live account unmutated; a safe GET + an allowlisted read-POST are NOT aborted, and an all-allowed opener's replay COMPLETES and reveals its child (firewall does not break reach); FAIL-ON-REVERT removes the page.route install → POST /api/track hits → trackHits>0 + no REVEAL_WRITE_BLOCKED — tests/live/write-firewall.test.mjs
