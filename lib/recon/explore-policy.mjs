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
// This module is PURE (name/route/ownership in, a verdict out). It performs no DOM reads and holds no
// browser state; the live ownership proof is hunt-gate.ownsTarget, computed by the caller and passed in.

import { dangerFloor, isAccountDeletion, destroysContent, editsContent } from './danger-floor.mjs';

// Ownership of the acted item, as determined LIVE by the caller (hunt-gate):
//   'own'     — carries our HUNT marker (this run or a prior one of ours) → full rights.
//   'foreign' — an item that exists and carries no marker of ours → edit-with-restore, never delete.
//   'none'    — the control is not inside any content item at all (a nav button, a create composer)
//               → nothing to own; additive by nature, so full rights.
export const OWNERSHIP = Object.freeze({ OWN: 'own', FOREIGN: 'foreign', NONE: 'none' });

// decide({name, route, ownership, runCreatedAccount}) → verdict
//   { allow, code, reason, needsRestore, needsRelogin }
// `needsRestore` marks an act the caller must bracket with the restore journal (capture → act → write
// back). `needsRelogin` marks an act that ends the session, so the caller re-authenticates after it.
export function decide({ name = '', route = '', ownership = OWNERSHIP.NONE, runCreatedAccount = false } = {}) {
  const floor = dangerFloor({ name, route });

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
