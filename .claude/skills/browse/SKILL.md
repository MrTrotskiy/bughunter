---
name: browse
description: Main-thread tool for previewing or exploring a single web page OUTSIDE the /hunt pipeline — preview a URL before recommending a mission, explore an SPA WebFetch can't render, or drive a login→inspect flow via delegated CLI session. Not used by pillar workers — those go through `pw` + `lib/browser-session.mjs`. Token-cheap envelope ({ok, error:{code,message,where?,fix[]}}); artifacts on disk, stdout is JSON metadata only. Triggers on "browse the URL", "preview the page", "explore the SPA", "посмотри страницу перед", "открой URL чтобы посмотреть", "залогинься и посмотри что внутри".
allowed-tools:
  - Bash(node .claude/skills/browse/browse.mjs *)
  - Bash(npx -y @playwright/cli*)
  - Read
argument-hint: "<action> [args...]   or   --url=<URL> --mode=<text|aria|a11y|html|screenshot|api>"
---

# browse

Single-file skill driving a web page via `browse.mjs`. Two backends: one-shot Playwright API (`--url=…`) and persistent `@playwright/cli` session for multi-step flows. Execution of multi-step sequences → [[browse-operator]].

<invariants>
- Entrypoint is `node .claude/skills/browse/browse.mjs <args>`. Args starting with `--url=` route to one-shot; anything else routes to CLI mode.
- Both modes emit one JSON envelope on stdout. Success: `{ok: true, outPath?, payload?, …}`. Failure: `{ok: false, error: {code, message, where?, fix[]}}`. Read the artifact for content; envelope alone is often enough.
- Exit codes: `0` ok · `1` runtime error (timeout, selector, network, CLI fault) · `2` usage error or refused input · `3` env (playwright not installed). LLM dispatches retry vs fix from the code alone.
- Public-host gate via `lib/host-policy.mjs`. One-shot `--url=…` and CLI `open/goto <url>` against private/loopback/metadata hosts emit `PRIVATE_HOST_REFUSED` (exit 2). Override only with operator-set `PW_ALLOW_PRIVATE=1`. Agents never set this env var (same contract as `pw`).
- CLI action whitelist mirrors `pw.mjs`. Unknown verb or `--flag-like` positional → `USAGE` (exit 2). Closes argument-injection via LLM-extracted attacker URLs.
- CLI stdout/stderr piped through `lib/bug-add.mjs#redactSecrets` before emission and before writing artifacts. Cookie / Authorization / JWT / API-key shapes do not land in the transcript.
- Artifacts always land in `/tmp/browse/`. One-shot writes one file (plus `out.full.json` for compacted `--mode=api`). CLI mode writes `cli-snapshot.yml` for `snapshot` action, `cli-out.json` for any payload > 4KB.
- One-shot defaults: `ignoreHTTPSErrors: true`, `waitUntil: 'domcontentloaded'`, timeout 30s, viewport 1440×900. No `networkidle` — pass `--wait=<selector>` for SPAs.
- CLI session `default` auto-closes after 10 minutes of inactivity (TTL in `/tmp/browse/session.json`). Cookies, localStorage, auth state persist across calls inside that window — `close` between unrelated targets.
- Output ≥ 200KB → envelope adds `warning` field. Read with `offset`/`limit` rather than dumping the file.
</invariants>

## Modes

One-shot artifact map:
- `text` → `/tmp/browse/out.txt` (default; `body.innerText()`)
- `aria` → `/tmp/browse/out.yml` (`snapshotForAI()` else `ariaSnapshot`, LLM-friendly)
- `a11y` → `/tmp/browse/out.json` (full accessibility tree via CDP)
- `html` → `/tmp/browse/out.html` (post-hydration)
- `screenshot` → `/tmp/browse/out.png` (full page)
- `api` → `/tmp/browse/out.json` (network responses: url/status/content-type). Logs > 10 entries auto-compact to `{_count, _byStatus, _byType, _errors[≤20], _first10, _last10, _truncated:true}`; the unbounded log lands at `/tmp/browse/out.full.json`. Pass `--full` to inline the full log into `out.json`.

CLI mode persists session state under `/tmp/browse/.playwright-cli/`. The action surface is self-describing — `npx -y @playwright/cli@latest --help`. `--json` is injected automatically; raw CLI text is never proxied to stdout. Canonical interaction loop: `open <url>` → `snapshot` (yields ARIA with `ref` anchors in `cli-snapshot.yml`) → `click <ref>` / `fill <ref> <text>` → `snapshot`. `state-save` / `state-load` persist auth across sessions; `close` shuts the session down.

## Picking a mode

<do>
- Single static page or token-cheap probe → one-shot `--mode=aria`.
- Raw DOM / text dump → one-shot `--mode=html` or `--mode=text`.
- Network traffic inspection → one-shot `--mode=api` (CLI cannot stream this).
- Login + interaction + post-action state → CLI mode delegated to [[browse-operator]].
- ARIA with clickable refs for a multi-step flow → CLI `snapshot`.
- Quick one-shot for a public page → main thread invokes `browse.mjs` directly.
</do>

<dont>
- Do not run CLI sequences from the main thread. Delegate to [[browse-operator]] (Sonnet) — main thread (Opus) stays on interpretation.
- Do not omit `--wait=<selector>` on SPAs; `domcontentloaded` fires before client routing settles.
- Do not chain sessions across unrelated sites — cookies leak. `close` between targets.
- Do not interpret artifacts inside [[browse-operator]] — bug analysis, test design, UX judgment are main-thread work.
</dont>

## Stdout shape

One-shot success:
```json
{ "ok": true, "outPath": "/tmp/browse/out.yml", "title": "…", "finalUrl": "…", "httpStatus": 200, "size": 4821, "mode": "aria" }
```

CLI success (small payload inline; large payload → `outPath`):
```json
{ "ok": true, "mode": "cli", "action": "snapshot", "outPath": "/tmp/browse/cli-snapshot.yml", "size": 6280 }
```
```json
{ "ok": true, "mode": "cli", "action": "close", "payload": { "session": "default", "status": "closed" } }
```

Failure (same shape for both modes):
```json
{ "ok": false, "error": { "code": "SELECTOR_NOT_FOUND", "message": "Timeout 30000ms exceeded.", "where": "page.waitForSelector", "fix": ["selector \"…\" did not appear in time", "inspect actual DOM: rerun with --mode=html or --mode=aria", "raise --timeout=<ms>"] } }
```

Error codes — one-shot: `USAGE`, `PRIVATE_HOST_REFUSED`, `PLAYWRIGHT_NOT_FOUND`, `TIMEOUT`, `SELECTOR_NOT_FOUND`, `DNS_FAILED`, `CONN_REFUSED`, `BAD_URL`, `RUNTIME`. CLI: `USAGE` (unknown action / flag-like arg), `PRIVATE_HOST_REFUSED`, `CLI_ERROR` (e.g. stale ref, missing session), `CLI_RUNTIME` (process fault). `error.fix[]` carries concrete next steps — read it before guessing.

After Reading the artifact, summarise in Russian (≤150 words), focused on what is useful for the current task.

## Delegation template

```
Agent({
  subagent_type: "browse-operator",
  description: "<short browse task>",
  prompt: "<explicit step-by-step plan: URLs, selectors, refs if known, what to snapshot at each stop, when to close the session>"
})
```

Subagent returns a compact report (actions taken, status, artifact paths, problems). Main thread Reads artifacts on demand and decides the next move.

## Pitfalls

- `networkidle` is disabled by design — Playwright deprecates it for SPAs. SPA navigation needs `--wait=<selector>`.
- Session-leak between sites: cookies, localStorage, auth state survive in the `default` session. Run `close` before switching targets.
- Stale `cliDaemon` / `ffmpeg` survive after a crashed session. `reapStaleDaemons()` in `browse.mjs` kills processes older than 30 min on the next invocation; manual cleanup is rarely needed.
- `snapshotForAI()` is only on recent Playwright. The code falls back to `ariaSnapshot` silently — output schema differs slightly.
- `allowed-tools` glob `Bash(node .claude/skills/browse/browse.mjs *)` matches invocations from the project root. Running from a sub-directory needs an absolute path.

## Related

- [[browse-operator]] — Sonnet subagent that executes CLI sequences
- `browse.mjs` — single-file implementation, source of truth for flags, defaults, and TTL constants
