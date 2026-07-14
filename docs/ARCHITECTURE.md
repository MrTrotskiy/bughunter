# Architecture

Bug-hunting agent for web apps. Ground-up rebuild of `bughunt-agents` (see `decisions.md` for why the old one died and every founding decision).

## Core idea
One incremental **graph** is the central artifact. It grows as the agent actually touches elements — not a static "brain" built ahead of time. Coverage is measured against an honest, non-collapsing denominator; regions the browser cannot see into (closed shadow DOM, canvas, cross-origin iframe) are flagged, never hidden.

## The graph (`state/graph.json`)
Single identity model: **DOM/CSS via `page.evaluate`** is the source of truth; ARIA role/name are attributes. Two-level identity:
- `Route` — a URL/page.
- `State` — a UI state within a route (modal open, tab selected); states nest.
- `Element` — a control at TEMPLATE level (`templateSelector`, structural indices normalized out), carrying `instances[]`.
- `Instance` — one occurrence (`instanceSelector` + `instanceKey`), so a 50-row table is 50 addressable instances of one template.
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
- `step` — the shared browser step primitive: `snapshotStep` + `actStep`, the ONE causal act+capture both the manual CLI and the loop use (BUILT, `lib/recon/step.mjs`).
- `frontier` — receptive-field selection (next unexplored templates) + honest discovered/explored/remaining denominator (BUILT, `lib/recon/frontier.mjs`).
- `recon-loop` — Phase-1 loop-driver: nextBatch → act → markExplored → stop on empty-frontier/budget. Pure control-flow; the browser step and the LLM judge are injected (BUILT, `lib/recon/recon-loop.mjs`).
- `recon-run` — loop runner CLI: baseline snapshot → drive `recon-loop` over a COLD-START step (fresh page per act; graph = cross-step memory) (BUILT, `lib/recon/recon-run.mjs`).
- `frontier-cli` — the recon agent's "what next" tool: emit the receptive-field batch + honest stats, no browser (BUILT, `lib/recon/frontier-cli.mjs`).
- `observe` — the recon agent's "what I learned" writer: records purpose/danger/effect and marks explored; gated by the `danger-floor` backstop (BUILT, `lib/recon/observe.mjs`).
- `danger-floor` — deterministic safety backstop (destructive/auth/payment classification); a net, NOT the judge (BUILT, `lib/recon/danger-floor.mjs`).
- `index` — numeric element-id ledger (BUILT into the ids/graph layer).
- `coverage` — map existing specs → element-ids; report % against honest denominator; return top-N targets (PLANNED).
- `pages` — route/sitemap count (PLANNED).

## Phase-1 loop status
The loop CORE runs end-to-end (frontier + driver + cold-start step, live-proven). The SEMANTIC layer — the "LLM judge" — is also built: the `recon` Sonnet subagent (`.claude/agents/recon.md`) is the OUTER driver; it reads its receptive field from `frontier-cli --emit`, judges what each control is and whether it is safe to fire, acts on the safe ones via `whats-new`, and writes purpose/danger/effect via `observe` (which also flips `explored` — explored ⟺ observed). The node `recon-loop` stays a deterministic identity-judge fallback for smoke-crawl/CI. The design lives in `docs/draft/recon-agent-design.md`. Two paths, one graph; the proven loop core is untouched. Not yet built: PERSISTENT-SESSION steps — cold-start reloads per act, so controls behind in-app state (a row's Edit button revealed only after a search) are discovered but NOT reachable; that surfaces honestly as a step-level error (agent records `unreachable-coldstart`), and the persistent-session + State-node work lifts it. Also unbuilt: coverage/index surfacing and the Phase-2 designer.

## Model split
Fable = architecture/research/planning/Phase-2 case design. Opus = all code authoring. Sonnet-or-lower + script = Phase-1 clicking/recon.

## Ported from bughunt-agents (hardened, do not re-decide)
`lib/core/envelope.mjs` (structured `{ok,error}` + exit codes), `lib/browser/host-policy.mjs` (SSRF gate), `lib/browser/probe.mjs` (causal init-script + settle predicates).

## Status
Keystone slice complete and green (`npm test`): causal attribution and two-level identity proven on a live local fixture; load-burst and background poll stay uncredited. Next: the recon loop (frontier + Sonnet micro-agent), then `coverage`/`index` surfacing, then Phase-2 designer.
