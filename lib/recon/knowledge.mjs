// THE KNOWLEDGE LADDER — what we actually know about an element, as opposed to whether we touched it.
//
// THE PROBLEM THIS REPLACES. `explored` was set immediately after one act returned, before anything about
// the outcome was inspected, and the frontier's drain predicate read that flag. So "explored" meant "we
// clicked it once and the click did not throw" — and coverage counted those. Measured over one run: 279
// acts, 27% caused any request, 43% completely inert, 21 of 32 submit-like controls clicked with no fields
// filled at all, and 0 of 6 user flows completed. The percentage rose while nothing worked, because the
// percentage was measuring effort rather than understanding.
//
// Phase 1 exists to turn a black box into a white one: for every control what it is and what it does, for
// every field what it accepts and what it refuses. That is a claim about KNOWLEDGE, so the metric has to be
// one. Hence a ladder, where each rung is earned by recorded evidence and cannot be reached by clicking
// faster.
//
//   L-1 BLOCKED       — cannot be probed, with a NAMED code. Counted, listed, never in the numerator.
//   L0  UNKNOWN       — discovered, never touched.
//   L1  REACHED       — resolved live at least once. (This is what `explored` really meant.)
//   L2  EXERCISED     — at least one probe with a recorded outcome.
//   L3  CHARACTERIZED — the role-appropriate battery is complete: every owed probe is done or blocked.
//   L4  CONFIRMED     — the outcome was reproduced, or a write was verified by reading it back.
//
// "90% coverage" means 90% of obligations at L3 or above. It cannot silently collapse: the denominator is
// the existing non-collapsing one, every rung above L1 requires probe rows that each point at a trail seq,
// and BLOCKED is a listed bucket with reasons rather than a quiet subtraction.
//
import { satisfies, isShapedType } from './probe-kinds.mjs';
import { formBattery } from './form-battery.mjs';
// The disabled→enabled predicate. graph-store is a pure data module here (no browser, no page); this reads
// evidence and never writes — the retirement decision stays in this file, which is where it belongs.
import { fieldStateCleared } from '../graph/graph-store.mjs';

// PURE — no browser, no graph mutation. The caller appends probe rows and asks this module what they mean.

// What a control of this shape owes before we can claim to understand it. Deliberately small: the point is
// to answer "what is this and what does it do", not to fuzz every element. A field owes more than a button
// because a field's whole meaning is what it accepts, and that is the operator's explicit requirement.
export function batteryFor({ role = '', fieldFacts = null, formFacts = null } = {}, probes = []) {
  const r = String(role).toLowerCase();
  // A SUBMIT BUTTON OWES THE FORM'S LADDER, not one click. docs/GOAL.md: each submit is a different
  // question — empty, then one required field at a time — and a single full-form submit answers only the
  // happy path. The ladder is derived from what the form DECLARES required and truncates itself the moment
  // an incomplete submit is accepted (form-battery.mjs), so it is bounded by evidence, not by a guess.
  if (formFacts) {
    const owed = formBattery(formFacts, probes);
    return owed.length ? owed : ['click'];
  }
  if (fieldFacts) {
    const kinds = ['fill-valid'];
    // Only probe a boundary the field DECLARES. A blind overflow probe on a field with no declared limit
    // tells us nothing we can check an answer against; a declared limit gives us a prediction to falsify,
    // and a disagreement between declared and observed is itself a defect worth reporting.
    if (fieldFacts.maxLength) kinds.push('fill-overflow');
    if (fieldFacts.required) kinds.push('fill-empty');
    // THE WRONG-SHAPE probe (docs/GOAL.md rung 4), wherever the field DECLARES a shape to violate: a
    // constrained input TYPE (letters into number, prose into date/email — isShapedType), a regex `pattern`,
    // or a numeric range. Each is a PREDICTION we can falsify; a plain text field declares no shape, so there
    // is nothing to check an answer against and no probe is owed. Valid-value first, then boundary/empty,
    // then wrong-shape — so a field is never probed at its edges before we know it accepts anything at all.
    // `!= null` (not truthiness) so a field declaring `min=0` alone still owes the wrong-shape probe —
    // `valueForProbe`/`findings` already read the bound with `!= null`, and a mint predicate that read it
    // as truthy would silently never generate the value those consumers are ready to judge.
    if (fieldFacts.pattern || fieldFacts.min != null || fieldFacts.max != null || isShapedType(fieldFacts.kind || fieldFacts.type))
      kinds.push('fill-invalid');
    return kinds;
  }
  if (r === 'link') return ['click'];
  return ['click'];
}

// One probe's verdict, from evidence alone. The ordering matters: a navigation and a write can both happen
// in one act, and the more specific fact wins. `rejected` is the rung that never existed before — an act
// that fired nothing because the PAGE SAID NO is a working control we failed to satisfy, which is a
// completely different fact from a control that does nothing, and they used to score identically.
export function verdictOf({ requests = [], revealed = 0, navigated = false, refused = false, succeeded = false, error = null, domChanged = false } = {}) {
  if (error) return 'error';
  const writes = requests.filter((q) => q.class === 'write');
  // A fallback-classified non-GET is a GUESS, and it gets its own verdict rather than being promoted to
  // `write` or demoted to `read`. On a target that reads over POST most reads land in that bucket — and so
  // does the occasional real mutation — so claiming either direction would be inventing certainty we do not
  // have. Only reading state back can settle it, and until something does, the row says so.
  const unnamed = requests.filter((q) => q.class === 'write-unnamed');
  // WRITE BEATS NAVIGATE. A submit that succeeds normally redirects, so post-redirect-get is the ordinary
  // shape of the very thing this tool exists to find. Ranking navigation first discarded the mutation from
  // the verdict — measured: 2 of 4 navigate rows on the live graph carried a write. The navigation is kept
  // as an attribute for the reader; it is not the headline.
  if (succeeded || writes.length) return navigated ? 'write+navigate' : 'write';
  if (navigated) return 'navigate';
  if (unnamed.length) return 'write-unconfirmed';
  if (refused) return 'rejected';
  if (requests.length) return 'read';
  if (revealed > 0) return 'reveal';
  // A CLIENT-SIDE CHANGE. No request, no new template — and the page still rearranged itself: a tab
  // switching panels, an accordion opening, a filter narrowing a list. On a target where 83-99% of controls
  // have no accessible name, this is often the only thing a control will ever tell us about itself, and it
  // was previously scored identically to dead surface. Measured: 32 of 99 inert rows were this class.
  if (domChanged) return 'client-change';
  // UNMEASURED IS NOT INERT. `domChanged === null` means the structural fingerprint could not be read at
  // all (navigation mid-measure, detached document) — we did not observe "nothing happened", we failed to
  // observe. Calling that `inert` writes a dead-control verdict on evidence that does not exist, and an
  // inert-only element is exactly what the ladder refuses to call understood. `unmeasured` keeps the
  // obligation open so the element is asked again, instead of being written off on a missed reading.
  if (domChanged === null) return 'unmeasured';
  return 'inert';
}

// Which owed probes are still outstanding, and which are blocked with a reason. `probes` are the recorded
// rows for ONE element.
// A verdict that carries EVIDENCE — the page did something we could observe. `inert` is the absence of
// evidence and `error` is the absence of an act, so neither can complete a battery or confirm anything.
export const EVIDENCE_VERDICTS = new Set(['read', 'write', 'write+navigate', 'write-unconfirmed', 'reveal', 'navigate', 'rejected', 'client-change']);

// Blocked codes that mean "we failed to ASK", not "the element answered". These leave the obligation
// standing, so the element keeps owing the probe and stays visibly incomplete. Everything NOT listed here
// is a terminal fact — a readonly field really is unfillable, a policy refusal really is permanent — and
// those legitimately discharge the obligation while staying named in the blocked list.
export const TRANSIENT_BLOCKS = new Set(['NO_INSTANCE', 'NOT_VISIBLE', 'ACT_FAILED', 'CONTAINER_CLOSED', 'ALIAS_COLLISION']);

// ═══ A BLOCK ABOUT THE ELEMENT, NOT ABOUT THE ATTEMPT ═══════════════════════════════════════════════
//
// A blocked row is filed under the kind the act HAPPENED to be (`recordProbe` → `kindOf`, which returns
// `click` whenever the script did not name a rung). A field's battery, meanwhile, owes `fill-valid` /
// `fill-overflow`. So `blocked.set('click', 'DISABLED')` never intersected `owed`, `outstanding` never
// emptied, and `batteryOwing` re-emitted the element until MAX_BATTERY_ROWS.
//
// MEASURED, runs raw3 + hunt1: "Enter your email id" (template 1141) was acted EIGHT times in each run and
// answered DISABLED all eight; "Group Name" (1020) the same in hunt1. Sixteen acts spent re-asking a
// question that was answered on the first one — a disabled input does not become enabled on the eighth
// click, and nothing in the loop was ever going to fill it.
//
// The codes below are refusals of THE ELEMENT: each is decided from the element's own live state or from a
// policy over its identity, never from whether we managed to reach it. So one such row blocks EVERY
// obligation the element carries, not merely the kind the act was labelled with.
//   DISABLED         — step.mjs:379, thrown after a LIVE `enabled` read off an already-resolved, already-
//                      visible handle. Reachability is not in question; the element refuses operation.
//   DANGER_FLOOR     — step.mjs:197/275/305, a policy verdict over the control's name / route / authored
//                      id (danger-floor.mjs). A pure function of identity — re-asking cannot change it.
//   OUTWARD_REFUSED  — reaches a person or a third party outside the app; "refused on every tier".
//   FOREIGN_DESTROY  — explore-policy's irreversible-on-another-user's-content rail.
//   ACCOUNT_PROTECTED— an account this run did not create. An ownership fact, settled before the act.
//
// DELIBERATELY NOT HERE, and this is the whole of the caution: these do not make the element permanently
// unusable, they make it unusable NOW. A Save button disabled until a required field is filled is exactly
// the control the incremental form ladder exists to reach, and a code list that wrote it off would delete
// that. `DISABLED` is listed for what it discharges (the obligation, honestly, with a reason) — the
// RETIREMENT decision is left to `answeredTerminally` below, which retires on repeated identical answers
// and therefore keeps the slot of any control whose answer ever changes.
// NOT_FILLABLE IS DELIBERATELY ABSENT, and it is the classification I got wrong first. It looks
// element-scoped ("the field cannot take a value") but tests/unit/knowledge.test.mjs holds the
// counter-example: a field whose `fill-valid` probe WROTE and whose `fill-overflow` came back
// NOT_FILLABLE — the field plainly does take a value, so the code was about that one probe, not the
// element. It also never appears in the measured trails. Classified from the code, not from the name.
export const ELEMENT_TERMINAL_BLOCKS = new Set([
  'DISABLED', 'DANGER_FLOOR', 'OUTWARD_REFUSED', 'FOREIGN_DESTROY', 'ACCOUNT_PROTECTED',
]);

// ═══ A STATE THE ELEMENT HAS SINCE LEFT IS NOT EVIDENCE ABOUT IT ════════════════════════════════════
//
// `DISABLED` sits in ELEMENT_TERMINAL_BLOCKS on the reasoning that it is read from the element's own live
// state, so re-asking cannot change it. That is true of a POLICY refusal and false of a STATE: `el.disabled`
// is a live IDL property the application flips as the user works — a wizard field disabled until the
// previous step, a Save disabled until the form is dirty. `mergeSnapshot` used to latch the first sighting
// forever; it now RE-READS both state keys and keeps the replaced reading, so `fieldStateCleared(node)`
// answers "was it observed disabled, and is it enabled NOW".
//
// Once that is true, every pre-flip `DISABLED` row describes a state the element has LEFT, and it must stop
// answering for it — on BOTH arms of the retirement, because either alone leaves the control retired:
//   (1) HERE, so `probeStatus` stops discharging the whole battery with a code the element no longer
//       returns, and the outstanding obligations refill;
//   (2) the no-progress tail in `answeredTerminally`, which retires on 3 identical `click:DISABLED`
//       signatures — and the measured graphs (raw3, hunt1) already hold EIGHT of them per control.
//
// SELF-LIMITING, which is what makes it safe: the control goes back into the frontier, and if it answers
// DISABLED again the current reading is `true` once more, `fieldStateCleared` goes false, every row counts
// again, and the no-progress rule retires it on the NEW tail. Nothing here can loop — it can only postpone
// a retirement by exactly one more round of evidence.
//
// SCOPED TO `DISABLED` ALONE. DANGER_FLOOR / OUTWARD_REFUSED / FOREIGN_DESTROY / ACCOUNT_PROTECTED are
// verdicts over the element's IDENTITY, not readings of its state, and no snapshot can clear them.
export function liveRows(node, probes = []) {
  const rows = (probes || []).filter(Boolean);
  if (!fieldStateCleared(node)) return rows;
  return rows.filter((p) => p.blocked !== 'DISABLED');
}

// The first element-scoped block among these rows, or null. `node` is OPTIONAL and additive: pass it and a
// pre-flip DISABLED row stops counting (see liveRows); omit it and the behaviour is exactly what it was.
export function elementBlockedBy(probes = [], node = null) {
  for (const p of liveRows(node, probes)) {
    if (p.blocked && ELEMENT_TERMINAL_BLOCKS.has(p.blocked)) return p.blocked;
  }
  return null;
}

// ═══ NOTHING FURTHER TO TELL US ═════════════════════════════════════════════════════════════════════
//
// WHY A CAP AND NOT ONLY A CODE LIST. Measured across raw3 + hunt1, the repeats came from THREE generators
// and a code list addresses only the first:
//   1. a terminal code            — DISABLED ×8, ×8            (a code list catches these)
//   2. a TRANSIENT code that proved terminal in practice — NO_INSTANCE ×8, ACT_FAILED ×5, ALIAS_COLLISION
//      ×3 on four templates. Every one of these is transient BY PRINCIPLE (a panel may open, an overlay may
//      clear) and every one of them returned the identical answer every single time.
//   3. no block at all — template 27 acted 8× with verdict `navigate` all eight, template 1083 acted 8×
//      (one `reveal`, then seven `inert`). Neither is blocked, so no code list could ever see them.
// A code list would therefore have removed 16 of 45 repeats in raw3 and left the rest.
//
// THE DISCRIMINATOR IS PROGRESS, NOT THE CODE. docs/GOAL.md mandates that a form be studied INCREMENTALLY
// and insists each submit asks a DIFFERENT question — and a different question is exactly what a different
// probe KIND is (probe-kinds.mjs: `submit-empty`, `submit-req-1`, `submit-req-2`, … each its own
// obligation). A repeat that teaches nothing re-asks the SAME kind and gets the SAME outcome. So the
// signature of an answer is (kind asked, outcome received), and a control is retired only once it has
// returned one signature twice running.
//
// TWO IS NOT ARBITRARY: `levelOf` already calls an outcome REPRODUCED at exactly two identical
// observations (`v.length >= 2 && v[0] === v[v.length - 1]`) and awards L4 CONFIRMED for it. The second
// identical answer is the last one that carries information by this module's own definition; the third is
// the beginning of waste. Retiring there means a control leaves the frontier at the moment it tops the
// ladder, never before.
//
// VERIFIED AGAINST THE MEASURED LADDERS: the eleven real ladders in these runs are `fill-valid` then
// `fill-overflow` — two DIFFERENT kinds, so two different signatures, so untouched. Every repeat listed
// above collapses to one signature and retires after two.
export const NO_PROGRESS_LIMIT = 2;

// A TRANSIENT BLOCK KEEPS THE RETRY BUDGET IT ALREADY HAD. `frontier.retryable` has bounded these at
// MAX_RETRY_ROWS = 3 since run probe8, where 15 elements sat permanently at L1 REACHED because ONE failed
// attempt retired them — a measured decision this must not quietly tighten to 2. The two rules are about
// different things and both are needed: the retry bound governs how many times we RE-ASK a question we
// never managed to put, and it is deliberately the more generous of the two.
//
// So the eight NO_INSTANCE rows on template 1290 were never `retryable`'s doing — that stops at 3. They
// came from `batteryOwing`, which overrode the retry bound and re-emitted the element to MAX_BATTERY_ROWS.
// Capping the no-progress tail at the SAME 3 restores the bound that was already agreed rather than
// inventing a stricter one, and still removes five of those eight acts.
export const NO_PROGRESS_BLOCKED_LIMIT = 3;

// What was asked, and what came back. `blocked` and `verdict` are mutually exclusive on a row.
const answerSig = (p) => `${p.kind || '?'}:${p.blocked || p.verdict || '?'}`;

// Has this control given a terminal answer — and by which rule? Returns null while it still owes work.
// `probes` MUST already be narrowed to the instance in question by the caller: a disabled row on one
// instance says nothing about a sibling, and writing one off for the other would delete real coverage.
export function answeredTerminally(node, probes = []) {
  const rows = (probes || []).filter(Boolean);
  // ARM 1: the element-scoped refusal, with the node in hand so a cleared DISABLED no longer answers.
  if (elementBlockedBy(rows, node)) return 'element-blocked';
  if (!rows.length) return null;
  // An element we never managed to ASK keeps the wider retry budget; one that ANSWERED is judged at the
  // rung its own ladder calls reproduced.
  const limit = rows[rows.length - 1].blocked ? NO_PROGRESS_BLOCKED_LIMIT : NO_PROGRESS_LIMIT;
  if (rows.length < limit) return null;
  const tail = rows.slice(-limit);
  const sig = answerSig(tail[0]);
  if (!tail.every((p) => answerSig(p) === sig)) return null;
  // ARM 2: the tail is identical — but if the answer it keeps repeating is DISABLED and the state has since
  // cleared, that tail is pre-flip evidence and retiring on it writes the control off for a state it has
  // left. Checked HERE rather than by filtering the rows up front, deliberately: dropping rows would change
  // which rows the tail is taken FROM, and a tail like [answer, DISABLED, answer] would collapse into a
  // repeat that never happened — a rule meant to STOP a retirement must not be able to cause one.
  if (fieldStateCleared(node) && tail[0].blocked === 'DISABLED') return null;
  return 'no-progress';
}

// THE FINDING, not the failure. docs/GOAL.md lists "a control that silently does nothing" among the
// anomalies the crawl exists to find, and a control that ANNOUNCES itself and then refuses to be operated
// is the same class: the application rendered an affordance it will not honour. Recording it is the point
// of retiring it — the act budget is freed AND the observation is kept, rather than the control simply
// ceasing to appear. Pure over the graph, like findings.mjs: reads probe rows, mutates nothing.
export function notOperableFindings(graph) {
  const out = [];
  for (const [id, node] of Object.entries(graph?.elements || {})) {
    // A control that was disabled and has since been ENABLED is not a control the app refuses to operate —
    // it was disabled because a precondition was unmet, which is precisely the distinction that makes the
    // remaining cases a finding at all. Reporting the flipped ones would bury the real ones.
    const code = elementBlockedBy(node.probes || [], node);
    if (!code) continue;
    // A POLICY refusal is our own choice, not the application's defect — it is honest coverage accounting,
    // and reporting it as a bug would bury the real ones. Only the application's own refusals are findings.
    if (code !== 'DISABLED' && code !== 'NOT_FILLABLE') continue;
    out.push({
      kind: 'control-not-operable',
      severity: 'low',
      where: { id, name: node.name || '', route: node.route || '', role: node.role || '' },
      code,
      tries: (node.probes || []).filter((p) => p && p.blocked === code).length,
      note: code === 'DISABLED'
        ? 'the control is rendered and visible but disabled — it announces itself and refuses to be operated'
        : 'the control is rendered but its shape cannot be actuated at all',
    });
  }
  return out;
}

export function probeStatus(node, probes = []) {
  // Pre-flip DISABLED rows are dropped for EVERY consumer below — the battery derivation included, since
  // `formBattery` parks a rung on a blocked row and a rung parked by a state the element has left is a rung
  // silently never asked. Strictly non-retiring: removing blocked rows can only ADD to `outstanding`.
  const rows = liveRows(node, probes);
  const owed = batteryFor(node || {}, rows);
  const done = new Set();
  const blocked = new Map();
  for (const p of rows) {
    if (!p.kind) continue;
    // A TRANSIENT failure discharges nothing. Splitting these two is the difference between "the field
    // told us something" and "we did not manage to ask". Measured shape: a field owes three probes, the
    // first commit closes the modal, probes two and three come back NO_INSTANCE — and with one blocked
    // bucket `outstanding` empties, `terminal` reads CHARACTERIZED and the element silently scores L3 on
    // one answered probe out of three. That is the honest-denominator invariant inverted: a failure to
    // measure was being counted as a measurement.
    if (p.blocked) {
      if (!TRANSIENT_BLOCKS.has(p.blocked) && !blocked.has(p.kind)) blocked.set(p.kind, p.blocked);
      continue;
    }
    // A row with no verdict, or one recording that the act THREW, is not a completed probe. Without this a
    // future writer appending `{kind:'click'}` would credit the battery with no evidence whatsoever.
    // `unmeasured` joins `error` here: both mean the probe did not produce an answer. A row that records
    // "we could not read the page" must never discharge the obligation it was sent to satisfy.
    if (!p.verdict || p.verdict === 'error' || p.verdict === 'unmeasured') continue;
    done.add(p.kind);
  }
  // A kind that eventually succeeded is not blocked, however many times it failed first.
  for (const k of done) blocked.delete(k);
  // AN ELEMENT-SCOPED BLOCK BLOCKS EVERY OBLIGATION THE ELEMENT HAS. The row was filed under whatever kind
  // the act happened to be (usually `click`); the fact it records is about the element, so it answers the
  // whole battery. Without this the obligation stood forever against a control that can never discharge it:
  // measured, two fields sat owing `fill-valid`/`fill-overflow` through EIGHT consecutive DISABLED acts.
  // This is the honest half of the retirement — docs/GOAL.md accepts an obligation "honestly recorded as
  // unanswerable with a reason", and the reason is now attached to each owed kind by name.
  // Anything already ANSWERED keeps its answer: a field that filled once and was disabled later is not
  // retroactively unmeasured.
  // Match through the shared vocabulary, not by string equality. A `fill-submit` row IS the transaction a
  // `fill-valid` obligation asks for, and it is also a click — refusing to see that is what stranded 49
  // elements at L2 with nothing missing but a name.
  const satisfied = (k) => [...done].some((d) => satisfies(k, d));
  const elemBlock = elementBlockedBy(rows, node);
  if (elemBlock) {
    for (const k of owed) {
      if (!satisfied(k) && !blocked.has(k)) blocked.set(k, elemBlock);
    }
  }
  const outstanding = owed.filter((k) => !satisfied(k) && !blocked.has(k));
  // An EMPTY battery must never read as complete — that would make an unforeseen element shape instantly
  // CHARACTERIZED on zero rows.
  if (!owed.length) return { owed, done: [...done], blocked: [], outstanding: [], terminal: null };
  return {
    owed,
    done: [...done],
    blocked: [...blocked.entries()].map(([kind, code]) => ({ kind, code })),
    outstanding,
    terminal: outstanding.length === 0 ? (blocked.size && !done.size ? 'EXHAUSTED' : 'CHARACTERIZED') : null,
  };
}

// The rung this element currently sits on.
export function levelOf(node, probes = []) {
  if (!node) return 'L0';
  // A control whose ONLY rows are pre-flip DISABLED reads L-1 BLOCKED — "cannot be probed" — about a
  // control we are on our way back to probe. Dropping that evidence lands it at L1 REACHED: we got to it
  // and know nothing yet, which is the honest rung. Strictly upward; `real` (the non-blocked rows every
  // rung above L1 is earned with) is untouched, because a DISABLED row was never in it.
  const rows = liveRows(node, probes);
  const real = rows.filter((p) => !p.blocked);
  // BLOCKED is only the verdict when NOTHING could ever be probed — a partially blocked element still owes
  // whatever remains, so it is not written off.
  //
  // And BLOCKED means UNPROBEABLE, not "we failed". An element whose every row is a TRANSIENT failure —
  // the act threw, the instance stopped resolving, the node aliased onto another instance's — was reached
  // and never measured, which is L1. Calling it L-1 presents a fixable gap as a permanent ceiling: measured
  // here, 14 elements whose acts simply threw were being listed to the operator as controls that cannot be
  // probed at all. The denominator is identical either way; what changes is whether the run is honest about
  // owing another attempt.
  if (rows.length && !real.length) {
    return rows.every((p) => TRANSIENT_BLOCKS.has(p.blocked)) ? 'L1' : 'L-1';
  }
  if (!rows.length) return node.reachedAt || node.explored ? 'L1' : 'L0';
  const st = probeStatus(node, rows);
  if (st.terminal !== 'CHARACTERIZED') return 'L2';
  // THE EVIDENCE GATE. A battery completed only by `inert` rows means we clicked and the page did nothing
  // observable — no request, no reveal, no navigation, and it said nothing. Calling that CHARACTERIZED
  // re-imports "clicked once and did not throw" one rung higher, and it is indistinguishable from the
  // INC.6b failure where the act was recorded against a control that was never actually clicked. Measured:
  // 17 of 41 elements at L3 had only inert rows.
  const withEvidence = real.filter((p) => EVIDENCE_VERDICTS.has(p.verdict));
  if (!withEvidence.length) return 'L2';
  // L4 needs the outcome to have been seen twice the same way, or a write confirmed by read-back — one
  // observation of a flaky control is not knowledge.
  const byKind = new Map();
  for (const p of withEvidence) {
    const seen = byKind.get(p.kind) || [];
    seen.push(p.verdict);
    byKind.set(p.kind, seen);
  }
  const reproduced = [...byKind.values()].some((v) => v.length >= 2 && v[0] === v[v.length - 1]);
  const readBack = real.some((p) => p.confirmedByReadBack === true);
  return (reproduced || readBack) ? 'L4' : 'L3';
}

const LEVELS = ['L-1', 'L0', 'L1', 'L2', 'L3', 'L4'];

// The honest headline. THREE numbers, never blended into one — that blending is what let coverage climb
// from 45% to 67% while completed user flows stayed at zero. `knowledge` answers "how much do we
// understand", `blocked` answers "what could we not touch and why", and flows are counted by the caller
// because they are a different question entirely (input quality versus action order).
// The declaratively-interactive subset: elements the HTML/ARIA vocabulary itself marks as controls, as
// opposed to a div the application taught to be clickable. Reported ALONGSIDE the honest denominator, never
// instead of it.
const DECLARATIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'searchbox',
]);

function declarativeStats(nodes) {
  let total = 0; let understood = 0;
  for (const [, node] of nodes) {
    if (node.widgetInternal) continue;
    if (!DECLARATIVE_ROLES.has(String(node.role || '').toLowerCase()) && !node.fieldFacts) continue;
    total++;
    const lvl = levelOf(node, node.probes || []);
    if (lvl === 'L3' || lvl === 'L4') understood++;
  }
  return { obligations: total, understood, pct: total ? Math.round((understood / total) * 1000) / 10 : 0 };
}

export function knowledgeStats(graph, probesFor) {
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  const blocked = [];
  const nodes = Object.entries(graph?.elements || {});
  for (const [tid, node] of nodes) {
    if (node.widgetInternal) continue;                      // chrome is not an obligation (INC.6f)
    const probes = (probesFor ? probesFor(tid, node) : node.probes) || [];
    const lvl = levelOf(node, probes);
    counts[lvl]++;
    if (lvl === 'L-1') {
      const first = probes.find((p) => p && p.blocked);
      blocked.push({ templateId: Number(tid), name: node.name || null, code: first ? first.blocked : 'unknown' });
    }
  }
  const obligations = nodes.length ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const understood = counts.L3 + counts.L4;
  return {
    obligations,
    // THE SAME NUMBER OVER A NARROWER DENOMINATOR, disclosed rather than substituted. Published web-crawl
    // coverage figures are reported over DECLARATIVELY interactive elements — links, buttons, fields. Ours
    // includes every `role=generic` div carrying a click handler, which on this target is roughly a third of
    // all templates, so the two numbers are not comparable and the wider one always reads lower.
    // Both are emitted, and the wide one stays the headline. Quietly narrowing the denominator to reach a
    // target is precisely how a 50% became a 22% earlier in this project: the metric stops measuring the
    // system and starts measuring itself.
    declarative: declarativeStats(nodes),
    understood,
    knowledgePct: obligations ? Math.round((understood / obligations) * 1000) / 10 : 0,
    byLevel: counts,
    blocked: blocked.sort((a, b) => a.templateId - b.templateId),
  };
}
