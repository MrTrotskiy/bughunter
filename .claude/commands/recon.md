---
description: Run a full Phase-1 recon on a target — daemon + AI loop until the frontier drains, then a coverage report.
argument-hint: <url>
---

Run a complete Phase-1 recon of the target below by orchestrating the `recon` subagent over a shared browser daemon. You are the RUN DRIVER: you bracket the daemon and re-invoke the recon worker until the frontier drains. Follow this procedure exactly.

Target: $ARGUMENTS

## Setup
1. Resolve the target URL from the argument above. If it is empty, ask the user for a URL and stop until they answer. If it is a localhost / 127.0.0.1 / private host, every command below MUST be prefixed with `PW_ALLOW_PRIVATE=1` (the SSRF gate refuses private hosts otherwise). Public URL → no prefix.
2. State lives in the default `state/` dir (gitignored) — do NOT set BUGHUNTER_STATE_DIR. If the user asks for a clean run, `rm -f state/graph.json state/element-ids.json` first.
3. Start the shared browser daemon: `node lib/recon/recon-session.mjs --start`. Confirm `{ok:true}`. This is ONE chromium for the whole run — every `whats-new` below connects to it instead of launching its own.

## Baseline
4. `node lib/recon/whats-new.mjs --url=<url>` — snapshots the initially-present controls into the graph and seeds the frontier. Report the baseline counts (`total`, `new`, `opaque`).

## Recon loop (the AI perceptron loop)
5. Repeat these steps until the frontier drains, up to a hard cap of 20 iterations:
   a. Check what is left: `node lib/recon/frontier-cli.mjs --emit`. If `batch` is EMPTY (`stats.remaining` 0), the frontier is drained — leave the loop.
   b. Otherwise invoke the **`recon` subagent** (the Agent tool, subagent_type `recon`) to study ONE receptive field. In its prompt give it: the target URL, the exact env prefix to use on every command (`PW_ALLOW_PRIVATE=1` if localhost, plus the repo cwd), and the instruction that a daemon is already running so it must NOT touch `recon-session` — only `whats-new` / `frontier-cli` / `observe`. It studies 2-5 NEW templates, acts on the safe ones, writes purpose/danger/effect, and returns a short digest. Relay one line of that digest.
   c. Continue the loop. The graph persists between invocations, so `explored` accumulates and each pass sees fewer unexplored templates.
6. If you hit the 20-iteration cap with templates still remaining, stop looping and say so honestly (the run was budget-bounded, not exhaustive).

## Teardown + report
7. ALWAYS finish by stopping the daemon: `node lib/recon/recon-session.mjs --stop` — even if a step above failed. Never leave an orphaned chromium.
8. `node lib/recon/report.mjs` — print the coverage report: honest denominator (explored / discovered / unreachable / remaining), per-route controls with danger/effect/purpose, and the causal control→endpoint map.
9. Summarize for the user: how many templates were explored vs discovered, which controls are `unreachable-coldstart` (behind in-app state a cold-start reload can't reach — the known Phase-1 boundary), any controls skipped as destructive/auth/payment, and the causal edges found. This graph is the input to Phase-2 test-case design.

## Boundaries (state honestly, do not paper over)
- Multi-route, same-origin: recon follows same-origin navigation and maps every page reachable by a DIRECT navigation, attributing each page's controls to its own route. Off-origin links are recorded (`external-link`) but never fired.
- Direct-navigation reach only: controls (or whole routes) revealed only after an in-app CLIENT-state action (a row's Edit after a search; an SPA view reachable only by clicking, not by URL) are DISCOVERED but recorded `unreachable-coldstart` — reaching them is the stay-on-page work, not yet built.
- Cookie/consent overlays are dismissed automatically before each snapshot/act (curated framework accept buttons + a consent-scoped accept-text fallback), so a consent wall no longer hides the controls beneath it. A fully custom banner the curated list misses still leaves its controls `not-visible` (honest, no silent skip).
- No login: recon does not authenticate. It maps the surface reachable without logging in. Credentials in `test.md` are NOT used here.
- Recon maps behavior; it does NOT fire destructive/logout/payment controls or fuzz inputs. That is later-phase work.
