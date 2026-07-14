# Architecture

Bug-hunting agent for web apps. Ground-up rebuild of `bughunt-agents` (see `decisions.md` for why the old one died and every founding decision).

## Core idea
One incremental **graph** is the central artifact. It grows as the agent actually touches elements — not a static "brain" built ahead of time. Coverage is measured against an honest, non-collapsing denominator; regions the browser cannot see into (closed shadow DOM, canvas, cross-origin iframe) are flagged, never hidden.

## The graph (`state/graph.json`)
Single identity model: **DOM/CSS via `page.evaluate`** is the source of truth; ARIA role/name are attributes. Two-level identity:
- `Route` — a URL/page.
- `State` — a UI state within a route (modal open, tab selected); states nest.
- `Element` — a control at TEMPLATE level (`templateSelector`, structural indices normalized out), carrying `instances[]` and a `locator` KIND.
- `Instance` — one occurrence (`instanceSelector` + `instanceKey`), so a 50-row table is 50 addressable instances of one template. Each carries a `locator` — the most DURABLE handle Phase-2 should generate on (test-id > strictly-stable `#id` > role+name > css), with a two-level uniqueness gate (page-unique test-id = discriminator; shared across a template's rows = marker). Locator is a DERIVED attribute; identity still keys on the selector string, so it never churns ids/edges.
- `Request` — `{method, urlPattern}` (query values and numeric/uuid path segments masked to `:param`).
- Edge `Element --triggers--> Request` with `provenance:"causal"`.

Every element gets a stable small numeric id from an append-only ledger (`state/element-ids.json`) — the coverage addressing scheme.

## Causal capture (the keystone — PROVEN)
A request is bound to the control that fired it by TWO mechanisms together (`lib/browser/{probe,causal,initiator}.mjs`):
1. **Token** — an init-script injected before navigation monkeypatches fetch/XHR and records each request into `window.__bughuntFires` as `{cause, method, url, seq}`, where `cause = window.__bughuntCause` at fire time. The walker snapshots `seq0`, sets the cause to the control, clicks, waits for settle, keeps fires with matching cause and `seq >= seq0`. No wall-clock window.
2. **CDP initiator** — a page-lifetime CDP tracker classifies each request's initiator stack and rejects timer/parser-rooted fires. This catches a background poll that ticks INSIDE a control's window and inherits its token — which the token alone cannot see. A pathname is "background" only if no request to it was ever click-rooted, so a poll sharing a path with a real click never suppresses the real edge.

CDP-dependent (chromium); degrades to token-only on other engines.

## Two phases
- **Phase 1 — Recon ("perceptron loop")** — cheap model (Sonnet/lower) + scripts. Each context window studies only 2-5 NEW elements (frontier-based online exploration), acts with a causal token, writes observations to the graph, loops. `whats-new` is the per-step primitive: snapshot → diff vs graph → act on one control → report what it CAUSED (requests) and REVEALED (new instances).
- **Phase 2 — Test-case design** — Fable/Opus reads the compact graph (ids + roles + requests, not raw DOM), reasons about risk, designs Given/When/Then cases; a cheap model + script generate Playwright specs. Coverage loop: specs → `coverage` script → gaps → back to Phase 2.

## Scripts
- `whats-new` — DOM-diff + causal-token capture, single manual step (BUILT, `lib/recon/whats-new.mjs`).
- `step` — the shared browser step primitive: `snapshotStep` + `actStep`, the ONE causal act+capture both the manual CLI and the loop use. Attributes revealed controls to the route the act LANDED on (`routeKey(page.url())`) and refuses to fire off-origin links (BUILT, `lib/recon/step.mjs`).
- `scope` — route identity + origin boundary: `routeKey(url)` (navigable key — query/plain-anchor dropped, path-like SPA hash kept, concrete path NOT masked) and `sameOrigin(a,b)` (RFC 6454 scheme+host+port). The single source of route identity the multi-route crawl hangs on (BUILT, `lib/recon/scope.mjs`).
- `overlays` — `dismissOverlays(page)`: clears a cookie/consent wall (curated framework accept-selectors + a consent-scoped accept-text fallback) so it stops intercepting clicks on every underlying control. Runs after navigation, BEFORE the causal window (the accept-click's request is idle-tagged, never a causal edge) (BUILT, `lib/recon/overlays.mjs`).
- `frontier` — receptive-field selection (next unexplored templates) + honest discovered/explored/remaining denominator (BUILT, `lib/recon/frontier.mjs`).
- `recon-loop` — Phase-1 loop-driver: nextBatch → act → markExplored → stop on empty-frontier/budget. Pure control-flow; the browser step and the LLM judge are injected (BUILT, `lib/recon/recon-loop.mjs`).
- `recon-run` — loop runner CLI: baseline snapshot → drive `recon-loop` over a COLD-START step (fresh page per act; graph = cross-step memory) (BUILT, `lib/recon/recon-run.mjs`).
- `frontier-cli` — the recon agent's "what next" tool: emit the receptive-field batch + honest stats, no browser (BUILT, `lib/recon/frontier-cli.mjs`).
- `observe` — the recon agent's "what I learned" writer: records purpose/danger/effect and marks explored; gated by the `danger-floor` backstop (BUILT, `lib/recon/observe.mjs`).
- `danger-floor` — deterministic safety backstop (destructive/auth/payment classification); a net, NOT the judge (BUILT, `lib/recon/danger-floor.mjs`).
- `index` — numeric element-id ledger (BUILT into the ids/graph layer).
- `recon-session` — start/stop/status for the shared browser daemon: ONE chromium per run (BUILT, `lib/recon/recon-session.mjs`).
- `report` — render the graph: honest coverage denominator + per-route controls (danger/effect/purpose) + causal control→endpoint map (the Phase-2 input) (BUILT, `lib/recon/report.mjs`).
- `/recon <url>` — run orchestrator (slash command): brackets the daemon, loops the recon agent until the frontier drains, prints the report (BUILT, `.claude/commands/recon.md`).
- `coverage` — map existing specs → element-ids; report % against honest denominator; return top-N targets (PLANNED, Phase-2).
- `pages` — route/sitemap count (PLANNED).

## Phase-1 loop status
The loop CORE runs end-to-end (frontier + driver + cold-start step, live-proven). The SEMANTIC layer — the "LLM judge" — is also built: the `recon` Sonnet subagent (`.claude/agents/recon.md`) is the OUTER driver; it reads its receptive field from `frontier-cli --emit`, judges what each control is and whether it is safe to fire, acts on the safe ones via `whats-new`, and writes purpose/danger/effect via `observe` (which also flips `explored` — explored ⟺ observed). The node `recon-loop` stays a deterministic identity-judge fallback for smoke-crawl/CI. The design lives in `docs/draft/recon-agent-design.md`. Two paths, one graph; the proven loop core is untouched. Not yet built: PERSISTENT-SESSION steps — cold-start reloads per act, so controls behind in-app state (a row's Edit button revealed only after a search) are discovered but NOT reachable; that surfaces honestly as a step-level error (agent records `unreachable-coldstart`), and the persistent-session + State-node work lifts it. Phase 1 now runs END-TO-END: `/recon <url>` (`.claude/commands/recon.md`) starts the shared browser daemon, baselines, loops the `recon` subagent one receptive field at a time until the frontier drains (20-iteration cap), always stops the daemon, and prints `report` — the honest coverage denominator + routes mapped + per-route controls (danger/effect/purpose) + the causal control→endpoint map (the Phase-2 input). Recon is MULTI-ROUTE: a nav act's revealed controls are attributed to the route it landed on (`routeKey(page.url())`), the persistent step re-navigates per act to the target's own `node.route`, and off-origin links are recorded but never fired (`scope.mjs`) — a run on any same-origin site collects more than the entry page. Stated boundaries: only routes reachable by a DIRECT same-origin navigation are covered (routes/controls behind in-app CLIENT state — revealed by an in-page action, not a reload — stay `unreachable-coldstart` until the stay-on-page work); cookie/consent overlays ARE dismissed before each snapshot/act (`overlays.mjs` — a fully custom banner the curated list misses still leaves its controls `NOT_VISIBLE`, honestly); no login/auth; no destructive/fuzz actions; opaque regions are counted at snapshot time but not yet persisted in the graph. Still unbuilt: the Phase-2 designer (and the `coverage` script that maps specs→ids against the recon graph).

## Debug capture + admin viewer
A Phase-1 run is INSPECTABLE. When `BUGHUNTER_RUN_ID` is set (by `/recon`), the acting CLIs write a per-run trail under `state/runs/<runId>/` via `lib/debug/trace.mjs` (the single writer): `events.ndjson` (`{seq,ts,kind,payload}` for `route`/`frontier.emit`/`act`/`observe`), per-step `graph/<seq>.json` snapshots (graph GROWTH), and per-act before/after viewport key-frames + the target rect + per-phase timings. CAUSAL SAFETY is structural: key-frames are taken ONLY while the cause token is `__idle__` (before `beginCause` / after `endCause`) and always `fullPage:false`, so they fire no request inside a causal window and cannot forge a phantom edge — the biggest risk, proven inert by `tests/live/capture-causal.test.mjs` (capture ON, the in-window poll still rejected). The trail is opt-in: no `BUGHUNTER_RUN_ID` → the CLIs are byte-identical. `lib/debug/admin-server.mjs` is a zero-dep `node:http` viewer bound 127.0.0.1 ONLY (loopback Host-guard = DNS-rebinding defense, NO CORS header, resolved-path artifact allowlist) serving `admin.html` — a self-contained page with Walk (timeline + before/after screenshots + rect box + caused control→endpoint + timing bars), Graph (route→control→endpoint + step scrubber), Log, and Speed, live-polling as the crawl runs. `/recon` opens the run, boots the viewer (http://127.0.0.1:7666/), and closes the run at teardown.

## Model split
Fable = architecture/research/planning/Phase-2 case design. Opus = all code authoring. Sonnet-or-lower + script = Phase-1 clicking/recon.

## Ported from bughunt-agents (hardened, do not re-decide)
`lib/core/envelope.mjs` (structured `{ok,error}` + exit codes), `lib/browser/host-policy.mjs` (SSRF gate), `lib/browser/probe.mjs` (causal init-script + settle predicates).

## Status
Keystone slice complete and green (`npm test`): causal attribution and two-level identity proven on a live local fixture; load-burst and background poll stay uncredited. Next: the recon loop (frontier + Sonnet micro-agent), then `coverage`/`index` surfacing, then Phase-2 designer.
