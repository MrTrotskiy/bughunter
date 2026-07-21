# trail-golden — masked golden-trail fixture

A small, committed, **masked slice of a REAL run** (`fix1`) that a `node:test`
renders headlessly so the admin viewer's on-screen claims can be asserted true
(ADMIN-TRUTH-PLAN.md, Stage 2). A synthetic happy-path trail is explicitly
rejected by the plan — it would miss exactly the defects the gate exists to
catch. So this is a real slice with sensitive identifiers masked and every
diagnostic field preserved.

**The test depends only on the committed output here — never on the tmp source.**
`build.mjs` is the reproducible masker; re-run it (`node build.mjs`) to
regenerate. It reads the real `fix1` paths, applies a consistent mask map, and
writes `events.ndjson`, `graph/`, `run.json`, `graph.json`, `manifest.json`.

## Files
- `events.ndjson` — 63 masked events, original order preserved.
- `graph/<seq>-<pid>.json` — 6 masked per-step graph snapshots (only those a case
  needs; a snapshot is written by every `route`/`act` event, keyed by seq).
- `run.json` — masked run metadata.
- `graph.json` — the masked FINAL graph (693 instances; the coverage denominator,
  `notFoundSig`, and the absence of `contentSig` are what the gate reads).
- `manifest.json` — machine-readable case → witnessing seq(s); import it in the test.
- `build.mjs` — the masker + a self-check that fails loudly on a leak or a missing case.

## Graph join semantics (for the test author)
Graph state "at step N" = the nearest snapshot whose seq ≤ N. Snapshots exist
only at `route`/`act` seqs. The two entry-route-mislabel cases below rely on this:
count `elements[*].instances` where `element.route === drain.route` in the nearest
snapshot ≤ the drain seq.

## The contract — every required case and its witness
(Seqs are the ORIGINAL run seqs, preserved in the fixture. See `manifest.json`.)

### 13 event kinds (≥1 each)
| kind | witness seq |
|---|---|
| route | 0 |
| drain-outcome | 1 |
| retire | 2 |
| route-choice | 3 |
| pick | 5 |
| policy-verdict | 6 |
| act | 7 |
| act.failed | 225 |
| pick-empty | 82 |
| reopen | 86 |
| reopen-delivered | 477 |
| retire-answered | 230 |
| reloc-census | 1091 |

### 5 failure codes (≥1 `act.failed` each)
| code | witness seq |
|---|---|
| ACT_FAILED | 225 |
| DISABLED | 328 |
| NO_INSTANCE | 675 |
| OUTWARD_REFUSED | 781 |
| ALIAS_COLLISION | 855 |

### The load-bearing cases
- **request `status >= 500`** — seq **694**: an `act` whose `requests[]` carries
  `POST /app/addfriendgroup 500` (real event; the 500, method, resourceType,
  durationMs and the `addfriendgroup` endpoint tail are kept byte-for-byte; only
  the host and the brand path-segment are masked to `app`). This is the
  «Находки»-declares-impossible defect (Stage 1 item 3).
- **`act.failed` with `target.attempts` (6 per-strategy records)** — seq **225**:
  the `attempts` array (`strategy/ran/raw/visible/sameTemplate`) is preserved
  byte-for-byte. This is the "список попыток не записан on 39/39" defect (Stage 1
  item 2). `hadRevealPath` on this record is `false`.
- **`act.failed` with `target.hadRevealPath: true`** — seq **448**.
- **`act` with `shots.before === null`** — seq **7** (the blank-stage case, Stage 1
  item 4; true on nearly every act because `BUGHUNTER_VIEW=1` was not set).
- **entry-route mislabel** — seqs **597** and **895**: a `drain-outcome` with
  `acts: 0` while the nearest graph snapshot already holds many instances of that
  page (587 → 63 instances of one listing route; 893 → 71 instances of a profile
  route whose real path embedded a base64 segment). "Looked barren, wasn't."
- **`notFoundSig` present, zero `contentSig`** — `graph.json`: the dead
  client-404-detector case (Stage 2 writer-reader parity). `notFoundSig` is kept
  byte-for-byte (`2110f3b4`); NO route carries `contentSig`, and none is added.

## Masking rules applied (build.mjs)
**Masked, consistently (same input → same placeholder, so joins survive):**
- host / origin → `app.example.test` (target) and `host-b/c/…​.example.test` (others).
- page-route paths → `/route-a`, `/route-b`, … (whole path; this also neutralises
  the base64 profile segments some real routes embedded).
- accessible names / labels → `Control 1`, `Control 2`, …
- non-structural instanceKeys (numeric ids, dates, text keys) → `key-1`, … (a
  `#N` structural index is kept).
- request `urlPattern` API paths keep their SHAPE (`:param`, endpoint verb tail);
  only the host and the brand path-segment are neutralised (`→ app`, as in
  `POST /app/addfriendgroup`).
- global safety scrub over EVERY string value (free text included — DOM
  placeholders, titles, aria-labels, probe text): the brand, the test-account
  names (→ `Test User`, …), any leaked host, any email (`→ user@example.test`),
  any base64 profile segment. The token lists live in `build.mjs`
  (`NAME_TOKENS` for masking, `LEAK_TOKENS` for the self-check).
- long CSS selectors (`templateSelector`, `instanceSelector`, `locator.value`) are
  truncated — they are NOT diagnostic for any truth claim (identity is
  `instanceKey`) and dominate snapshot size.

**Preserved byte-for-byte (the diagnostic signal the gate reads):**
every `kind`, every failure `code`, every HTTP `status`/`method`/`resourceType`/
`durationMs`, the STRUCTURE of `requests[]`, `target.attempts` shape and its
`ran/raw/visible/sameTemplate` values, `hadRevealPath`, `revealed`/`revealedTemplateIds`
counts, `acts`/`barren`/`visits` on `drain-outcome`, all timings, `notFoundSig`,
the ABSENCE of `contentSig`, `probeKind`, and all decision fields.

## Notes / limits (flag for the gate author)
- **63 events, not ~120, on purpose.** Every case has a witness (see above). More
  events would not add coverage — they would each pull another ~0.4 MB cumulative
  graph snapshot (an `act`/`route` writes one). 63 events + 6 snapshots + the final
  graph is ~1.8 MB; a ~120-event contiguous slice was ~10 MB. Widen the WINDOWS in
  `build.mjs` if a later assertion needs a case not present here.
- Nothing required by the contract was un-representable in `fix1`; no case is
  fabricated. If a future gate assertion needs a case the real run does not
  contain, it must be added to the run — not synthesised here.
- The self-check at the bottom of `build.mjs` re-asserts: zero leaks (brand /
  test-account names / host / email / credential fragments / base64 — checked
  case-insensitively across EVERY committed data file, graph snapshots included),
  all 13 kinds, all 5 codes, every case witnessed, and the byte-for-byte
  spot-checks (the 500, the attempts shape, `notFoundSig`, zero `contentSig`).
  It exits non-zero on any failure. Revert-proven: disabling the name scrub makes
  the build die with a `SELF-CHECK FAILED: leak(s): token "…"` message naming the
  leaked token.
