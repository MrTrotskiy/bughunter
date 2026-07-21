// EXPLORE-ALL — the operator's full-exploration policy (decisions.md 2026-07-18). This is the SINGLE
// place that says what a crawl in this mode may do, so the answer never gets re-litigated across the
// click gate, the network firewall, the observer, and the agent prompt.
//
// The standing rule set, as given by the operator — NOT widened, NOT narrowed here:
//   - create / edit / delete of ANY kind: ALLOWED. Payments: ALLOWED. Calls / livestreams: ALLOWED.
//   - Accounts: creating one is ALLOWED. Deleting one is ALLOWED **only if THIS run created it** — a
//     persistent test-file account is never deleted (the operator's own carve-out).
//   - Content THIS run created (the HUNT-<runId> marker) or that a prior run of ours created: full
//     rights, up to and including delete.
//   - ANOTHER user's content: may be EDITED provided the original is captured first and written back
//     (restore-journal.mjs). It may NEVER be deleted — the one irreversible act, and the only hard
//     refusal left in this mode.
//   - UNKNOWN controls are CLICKED, not skipped. Not knowing what a control does is the reason to fire
//     it, not a reason to refuse: a real app guards its destructive paths behind a confirm modal, and
//     that modal is itself the thing worth mapping. An unfired control is an unmapped control.
//   - LOGOUT is fired like anything else. It is not refused — it is BRACKETED: the caller re-logins
//     afterwards (login.mjs) so the crawl studies the control without ending its own session.
//
// The DECISION is pure (name/route/ownership in, a verdict out). It performs no DOM reads and holds no
// browser state; the live ownership proof is hunt-gate.ownsTarget, computed by the caller and passed in.
// A trace rider sits alongside it (see `tracePolicy` below) — an append-only record of the verdict, which
// changes nothing about what is returned.

import { dangerFloor, isAccountDeletion, destroysContent, editsContent, isOutwardFacing } from './danger-floor.mjs';
import { traceEvent } from '../debug/trace.mjs';

// Ownership of the acted item, as determined LIVE by the caller (hunt-gate):
//   'own'     — carries our HUNT marker (this run or a prior one of ours) → full rights.
//   'foreign' — an item that exists and carries no marker of ours → edit-with-restore, never delete.
//   'none'    — the control is not inside any content item at all (a nav button, a create composer)
//               → nothing to own; additive by nature, so full rights.
export const OWNERSHIP = Object.freeze({ OWN: 'own', FOREIGN: 'foreign', NONE: 'none' });

// ═══ THE PERMIT IS A DECISION TOO ═══════════════════════════════════════════════════════════════
//
// Until now only a REFUSAL was ever visible, and only because it throws: the caller turns `allow:false`
// into an envelope error, which lands in the trail as a failed act. A PERMIT produced nothing at all.
// Measured on run `raw1`: 8 refusals recorded against roughly 279 permits that left no trace — so for the
// overwhelming majority of acts the trail could not show that a decision had been taken, let alone which
// rule took it. "Why was this allowed to fire?" was unanswerable for ~97% of the run.
//
// This is a SCRIPT decision, start to finish. `decide()` is a table of rules over a name, a route and a
// live ownership proof; there is no model in the live driver's path. The event records which rule fired
// and on what inputs — nothing about intent.
//
// VOLUME. `decide()` is called up to three times per act (the pre-handle gate, the live-representative
// re-check, and the ownership rail) plus once per reopen hop. Identical CONSECUTIVE verdicts are folded
// into the first emission — the common case, where the pre-gate and the ownership rail agree because the
// control sits in no ownable item. The fold is LOSSLESS, not a sample: every event carries `calls`, the
// monotone count of decisions this process has taken, so the number folded between two events is exactly
// `calls[i+1] - calls[i] - 1`. A denominator that silently collapsed would be the defect this record
// exists to remove, one level up.
//
// NEVER THROWS. Everywhere else in this project a failed trail write is fatal on purpose (a mutating act
// that went unrecorded is worse than a stopped crawl). Here it must not be: this rides a decision
// function whose contract is to RETURN a verdict, and a disk error that turned a permit into a throw
// would change what the crawler does — the one thing an observation may not do. The act path's own
// events (act / act.failed, written by the callers) remain the mandatory record of what happened.
const TRACE_KIND = 'policy-verdict';
let decideCalls = 0;   // every decide() this process took — the denominator, never collapsed
let lastSig = null;    // signature of the last EMITTED verdict; consecutive repeats fold into it

function tracePolicy(input, floor, verdict) {
  decideCalls++;
  const runId = process.env.BUGHUNTER_RUN_ID;
  if (!runId) return;   // no run, no trail — and unit callers stay side-effect-free
  const name = String(input.name ?? '').slice(0, 80);
  const sig = `${verdict.code}|${input.ownership}|${floor}|${name}|${input.route}`;
  if (sig === lastSig) return;
  lastSig = sig;
  try {
    traceEvent(runId, TRACE_KIND, {
      code: verdict.code,
      allow: verdict.allow,
      rule: verdict.reason,            // the rule in words — constant per code, not a judgement
      floor,                           // what danger-floor CLASSIFIED it as, before policy chose
      ownership: input.ownership,      // the live proof the rail was applied to
      name,                            // accessible name only — never a url, so no query rides along
      route: input.route || null,
      needsRestore: verdict.needsRestore,
      needsRelogin: verdict.needsRelogin,
      calls: decideCalls,              // see VOLUME above: makes the fold exactly reversible
    });
  } catch { /* observation only — a trail failure must never change the verdict */ }
}

// decide({name, route, ownership, runCreatedAccount}) → verdict
//   { allow, code, reason, needsRestore, needsRelogin }
// `needsRestore` marks an act the caller must bracket with the restore journal (capture → act → write
// back). `needsRelogin` marks an act that ends the session, so the caller re-authenticates after it.
export function decide(input = {}) {
  const { name = '', route = '', ownership = OWNERSHIP.NONE, runCreatedAccount = false } = input;
  const floor = dangerFloor({ name, route });
  const verdict = verdictFor({ name, route, ownership, runCreatedAccount }, floor);
  tracePolicy({ name, route, ownership }, floor, verdict);
  return verdict;
}

// The rule table itself, unchanged and still pure. Split out only so the trace rider above can sit
// between the decision and its return without threading an emit through six return statements.
function verdictFor({ name, route, ownership, runCreatedAccount }, floor) {

  // ═══ UNCONDITIONAL REFUSALS — checked FIRST, before ownership, and never lifted by any mode. ═══
  //
  // These are ordered ahead of everything else on purpose: an act that LEAVES THE SYSTEM is not made safe
  // by whose content it was launched from, nor by which environment fired it. A dev stand is routinely
  // wired to a real SMTP and a real payment provider; the mail arrives at a real inbox regardless. An
  // environment vouches for the app's OWN DATA being fixtures — it cannot vouch that the outgoing
  // integrations are sandboxed, and the crawler has no way to check.
  //
  // This closes a measured gap. On another user's content `decide()` returned allow=true for "Report content"
  // and "Block account", classified FOREIGN_ADDITIVE — "creates nothing of theirs to lose". True of a like,
  // false of a complaint: a report reaches a moderator, nothing downstream undoes it, and unblocking is a
  // separate act this crawler will never perform. The category conflated ADDITIVE-TO-THE-DATA-MODEL with
  // HARMLESS-TO-A-PERSON, and on a live social app the second is the one that matters.
  //
  // Nothing reached a real person, and the reason is uncomfortable: the confirmation modals were never
  // completed. That accidental protection is exactly what the probe/episode work removes.
  //
  // SCOPE, decided by the operator: this covers acts aimed at a PERSON (report / block / flag) and channel
  // egress (email / SMS invites). It deliberately does NOT extend to `payment` or `communication` on the
  // operator's OWN content — explore-all exists to classify every control by actually firing it, and on a
  // disposable test account a checkout and a call are exactly the controls that mode is for. That call is
  // his to make and it is recorded in tests/unit/explore-policy.test.mjs; do not quietly widen this.
  if (isOutwardFacing({ name, route })) {
    return { allow: false, code: 'OUTWARD_REFUSED', reason: 'reaches a person or a third party outside the app — refused on every tier', needsRestore: false, needsRelogin: false };
  }

  // LOGOUT — allowed, but flagged so the caller re-logins. Refusing it would leave an element the crawl
  // can never classify; firing it blind would end the session and dump the rest of the crawl onto /login.
  if (floor === 'auth') {
    return { allow: true, code: 'AUTH_RELOGIN', reason: 'auth control — fire, then re-login', needsRestore: false, needsRelogin: true };
  }

  // ACCOUNT DELETION — the operator's explicit carve-out: only an account THIS run created. Name-scoped
  // (a content delete sitting on an /account route must not be misread as account deletion).
  if (isAccountDeletion({ name })) {
    return runCreatedAccount
      ? { allow: true, code: 'ACCOUNT_OWN', reason: 'deleting an account this run created', needsRestore: false, needsRelogin: true }
      : { allow: false, code: 'ACCOUNT_PROTECTED', reason: 'refusing to delete an account this run did not create', needsRestore: false, needsRelogin: false };
  }

  // FOREIGN CONTENT — the one place a refusal survives.
  if (ownership === OWNERSHIP.FOREIGN) {
    if (destroysContent({ name, route })) {
      return { allow: false, code: 'FOREIGN_DESTROY', reason: "refusing to destroy another user's content (irreversible)", needsRestore: false, needsRelogin: false };
    }
    if (editsContent({ name, route })) {
      return { allow: true, code: 'FOREIGN_EDIT', reason: "editing another user's content — original is captured and restored", needsRestore: true, needsRelogin: false };
    }
    // Additive on someone else's item (comment, like, follow) — creates nothing of theirs to lose.
    return { allow: true, code: 'FOREIGN_ADDITIVE', reason: 'additive act on another user\'s item', needsRestore: false, needsRelogin: false };
  }

  // OWN content, or no item context at all (a composer, a nav control): everything is permitted —
  // destructive, payment, communication included. This is the whole point of the mode.
  return { allow: true, code: 'ALLOWED', reason: `explore-all: ${floor} permitted on ${ownership} target`, needsRestore: false, needsRelogin: false };
}

// Is EXPLORE-ALL armed? Operator-set only — an agent can never turn this on for itself, exactly as the
// hunt flag works. Requires an explicit env opt-in AND a run id (the HUNT marker that makes ownership
// provable); without the marker there is no way to tell our content from a stranger's, and the foreign-
// content rail would silently degrade into "everything looks foreign".
export function exploreAllArmed(env = process.env, opts = {}) {
  const asked = opts.exploreAll === true || env.BUGHUNTER_EXPLORE_ALL === '1';
  if (!asked) return false;
  return !!(opts.runId || env.BUGHUNTER_RUN_ID);
}
