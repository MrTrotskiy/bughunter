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
