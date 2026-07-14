---
name: writing-skills
description: Canonical reference for authoring Claude Code SKILLs in this repo (the `.claude/skills/<name>/SKILL.md` files Claude auto-invokes). Use whenever creating a new skill, editing one, splitting an oversized skill, debugging auto-invocation, choosing between skill / subagent / command / main, or wiring `allowed-tools`. Triggers on "напиши скилл", "новый skill", "edit SKILL.md", "skill format", "auto-invoke", "allowed-tools", "почему skill не срабатывает", "skill description".
---

# writing-skills

What makes a SKILL.md work — frontmatter contract, invocation, progressive disclosure. Body format/style → [[writing-llm-docs]]. CLAUDE.md authoring → [[writing-claude-md]]. Subagent authoring → [[writing-subagents]].

<invariants>

- A skill is a directory `.claude/skills/<name>/SKILL.md` plus optional adjacent files. The directory IS the unit; bare `.md` files in the skills dir are ignored.
- Frontmatter `name` + `description` are loaded into every session start. The body loads only when the skill is invoked (auto or `/name`). Frontmatter is the contract; body is the implementation.
- `description` is the routing signal. Vague description → skill never auto-fires. This is the #1 failure mode and the only thing the auto-router uses.
- The body MUST follow [[writing-llm-docs]] format: XML semantic tags, front-loaded `<invariants>`, no human prose, no emoji, no preamble. The skill is read by an LLM, not a human.
- Body cap: ≤ 500 lines. Above that, split detail into adjacent `reference.md` / `examples.md`, link from SKILL.md, never nest references deeper than one level.
- `allowed-tools` GRANTS tools without per-use prompts while the skill is active. It does NOT deny anything. Use `.claude/settings.json` `permissions.deny` to block.
- Skill body should not duplicate CLAUDE.md content — root CLAUDE.md is already in every session's context.

</invariants>

## Skill vs command vs subagent vs main

| Need | Use |
|------|-----|
| Knowledge base / authoring helper auto-loaded by keyword | **skill** (`.claude/skills/<name>/SKILL.md`) |
| User-facing slash command with documented args (`/hunt`, `/describe`) | **command** (`.claude/commands/<name>.md`) |
| Verbose research / exploration that returns a digest | **subagent** (`.claude/agents/<name>.md`) |
| Hard tool restriction (read-only auditor) enforced by allowlist | **subagent** |
| Iterative work with shared context across phases | **main** |

Same expertise needed by many subagents → extract into a skill, preload via `skills:` frontmatter.

In this repo:
- `.claude/skills/pw/SKILL.md` — bundled wrapper over `@playwright/cli`. Auto-invoked when explorer/bug-hunter/ux-auditor need browser actions.
- `.claude/commands/<name>.md` — the 7 pillar slash commands (`/hunt`, `/describe`, `/design`, `/gen`, `/learn`, `/heal`, `/hunt-retry`).
- `.claude/skills/writing-*` — meta-authoring skills (this directory).

## File layout

```
.claude/skills/<name>/
├── SKILL.md            # required
├── reference.md        # optional, loads on demand if SKILL.md links it
├── examples.md         # optional
└── scripts/            # optional, executed via ${CLAUDE_SKILL_DIR}/scripts/...
    └── helper.sh
```

Precedence (high → low): enterprise / managed → `~/.claude/skills/` (personal) → `.claude/skills/` (project) → plugin (namespaced `plugin:name`).

Naming: lowercase letters/digits/hyphens, ≤ 64 chars. Gerund form preferred (`writing-skills`, `processing-pdfs`, `using-prior`). Names like `helper`, `utils`, `tools` do not trigger semantically — avoid.

## Frontmatter schema

```yaml
---
name: short-kebab-case            # optional; defaults to dir name. ≤ 64 chars.
description: |                    # CRITICAL. Routing signal. ≤ 1024 chars. Third person.
  What it does + when to use it. Include the literal phrases the user would say
  so the matcher fires. Specific > general.
when_to_use: extra triggers       # optional. Appended to description (combined cap 1536).
allowed-tools:                    # optional. GRANTS — does not block.
  - Bash(node lib/bug-add.mjs *)
  - Bash(npx playwright *)
  - Read
disable-model-invocation: false   # if true, only user can invoke via /name. Use for irreversible ops.
user-invocable: true              # if false, hidden from /menu — only Claude auto-invokes.
model: inherit                    # optional: opus | sonnet | haiku | inherit
effort: medium                    # optional: low | medium | high | xhigh | max
context: fork                     # optional. `fork` runs the skill body in a subagent context.
agent: Explore                    # optional, paired with `context: fork`.
paths:                            # optional. Glob list — skill auto-loads only when files match.
  - "lib/**/*.mjs"
argument-hint: "<url>"            # optional. Hint shown in autocomplete.
arguments: [url, depth]           # optional. Named args usable as $url / $depth inside the body.
shell: bash                       # optional: bash (default) | powershell
hooks: {...}                      # optional. Scoped lifecycle hooks.
---
```

Only `description` is morally required. Anything without it cannot auto-invoke usefully.

## Description recipe

`<verb-phrase what it does>. Use when <trigger conditions>. Triggers on "<phrase 1>", "<phrase 2>", "<phrase 3>".`

<do>

- Include 3+ concrete trigger phrases the user would literally say.
- Include Russian and English variants — the user code-switches.
- State the use case and the exclusion ("Does NOT cover X") if confusable with another skill.

</do>

<dont>

- "Helps with bugs." — never auto-fires. Too vague.
- Multiple sentences of role narrative — description is a routing label, not a system prompt.
- Promises capabilities the body and tools cannot deliver.

</dont>

Example (good — from our `pw` skill):
> Inspect or drive a web page for the bughunt pipeline. Single-file skill — one entrypoint routes to @playwright/cli for stateful multi-step flows (persistent session, click/fill/snapshot) and falls back to a one-shot Playwright API call for modes CLI can't emit (full a11y tree, network log, plain text/html/screenshot).

## Invocation matrix

| Frontmatter setting | User `/name` invokes | Claude auto-invokes |
|---|---|---|
| default | yes | yes |
| `disable-model-invocation: true` | yes | no |
| `user-invocable: false` | no | yes |
| both above | no | no (dead skill) |

Auto-invocation depends entirely on `description` matching the user's intent. When a skill never fires automatically, the fix is almost always strengthening the description with specific trigger phrases.

## Body format

The body is rendered into the model's context when the skill is invoked. Apply [[writing-llm-docs]] in full:

- Front-loaded `<invariants>` block (5-8 items) immediately after H1 and one-line role.
- XML semantic tags from the canonical set: `<invariants>`, `<rule>`, `<do>`, `<dont>`, `<pitfall>`, `<reminders>`, `<example>`.
- Markdown headings (`##`) for navigation only.
- Third person, declarative. No "you should…", no "I will…".
- No emoji, no decorative tables, no preambles, no tutorials.
- Reference, do not inline. Link contracts, configs, sibling skills.
- Tail `<reminders>` block only when body ≥ 80 lines AND ≥ 6 invariants AND restatement is non-obvious.

Cross-link related skills with `[[skill-name]]` (same syntax as auto-memory).

## Dynamic content

Inject runtime context at skill-load time:

```markdown
## Current state
!`git status --short`
```

The backtick-bang form runs the command BEFORE the body reaches the model and replaces itself with stdout. Adds latency to every invocation — use sparingly. Never put expensive commands here.

Body variables:
- `$ARGUMENTS` — full arg string the user passed
- `$0`, `$1`, … — positional args
- `$<name>` — named args (requires `arguments: [<name>, …]` in frontmatter)
- `${CLAUDE_SKILL_DIR}` — absolute path to this skill's directory (use for bundled scripts)
- `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}` — session metadata

## Tool grants

`allowed-tools` removes per-use approval prompts while the skill is active. It is permissive, not restrictive.

MCP tools require fully-qualified names: `ServerName:tool_name`.

Example — a bug-recording skill:
```yaml
allowed-tools:
  - Bash(node lib/bug-add.mjs *)
  - Bash(node lib/bug-verify-mark.mjs *)
  - Read
disable-model-invocation: true   # mutating; user-initiated
```

To deny tools globally, use `.claude/settings.json` `permissions.deny` — that is the only structural deny mechanism. Body prose ("do not use Edit") is advisory, not enforced.

## Progressive disclosure

For larger skills (framework guides, reference material), keep SKILL.md as the index and offload detail one level deep:

```
.claude/skills/<name>/
├── SKILL.md             # high-level: routing + invariants + links
├── topics/
│   ├── <topic-a>.md     # deep reference, loaded on demand
│   └── <topic-b>.md
└── examples.md
```

Claude reads the linked file via Read tool when needed — no context cost until then.

<dont>

- Do not mirror the surface of a self-describing source (CLI, generated schema, OpenAPI doc) inside the skill. If the source can dump its own command/route/field list, the skill points at it and teaches *when* to call it — not *what* it contains.
- Example anti-pattern: per-command markdown files for a CLI whose own `<cli> --help` returns the full surface. The skill carries routing/pitfalls; the CLI is authoritative.

</dont>

## Pitfalls

- **Vague description.** Never auto-fires. Always 3+ concrete trigger phrases, RU + EN.
- **Body over 500 lines.** Context bloat, slower load. Split via progressive disclosure.
- **Nested references** (SKILL.md → ref.md → ref2.md). Claude does not reliably follow refs of refs. Keep one level deep.
- **Time-bound text** ("as of 2026-04-18", "currently F1=0.67"). Rots. Remove or move to auto-memory / `decisions.md`.
- **Inconsistent terminology.** Pick one canonical word per concept (`subagent`, not `worker`/`agent`/`bot`) and use it across every skill.
- **Backslashes in paths.** Always forward slashes.
- **Five alternatives** ("axios, fetch, undici, got, or node:http"). Pick one.
- **Re-explaining what Claude knows.** "Playwright is a browser automation library" → delete.
- **Embedded secrets.** Skills are repo files — treat as public.
- **Punt to Claude** ("you should figure out…"). The skill exists so figuring out is NOT repeated each session.

## Checklist

- [ ] Filename is `SKILL.md` (uppercase) inside a directory matching `name`.
- [ ] `description` is third-person, ≤ 1024 chars, 3+ trigger phrases, RU + EN.
- [ ] Body follows [[writing-llm-docs]]: front-loaded `<invariants>`, XML tags, no emoji, no preamble, no tutorials, no second-person.
- [ ] Body ≤ 500 lines. If longer, progressive disclosure with one-level-deep links.
- [ ] All paths forward-slash.
- [ ] No timestamped state, no embedded secrets, no embedded CLAUDE.md content.
- [ ] State-mutating skills set `disable-model-invocation: true`.
- [ ] Cross-references to sibling skills / memory use `[[name]]`.
- [ ] Examples use actual project paths/commands, not placeholders.

## When auto-invocation fails

If a skill is not triggering on intent that should fire it: read `description` aloud. Does it literally contain the words the user (or Claude) would say? If not, that is the fix — strengthen the description.

If a skill is too long: which 80% of the body is reference detail Claude can fetch on demand? Move it to `reference.md`, leave a one-line pointer.

If a skill triggers when not needed: narrow the description; remove generic trigger words.

## Related

- [[writing-llm-docs]] — body format/style (mandatory for skill bodies)
- [[writing-claude-md]] — CLAUDE.md authoring
- [[writing-subagents]] — `.claude/agents/<name>.md` authoring

<!--
Sources (stripped before LLM injection):
- Skills overview — https://code.claude.com/docs/en/skills
- Authoring best practices — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Anthropic skill examples — https://github.com/anthropics/skills
-->
