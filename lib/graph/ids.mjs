// Append-only numeric-ID ledger. A stable small integer per string key (template
// key or instance key), minted once and never reassigned. Keeping ids small and
// stable makes the graph readable and diffs meaningful across runs.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function makeLedger() {
  return { next: 1, ids: {} };
}

// Return the id for `key`, minting a new one only for an unseen key. Pure over the
// in-memory ledger object { next, ids } — mutates it in place, returns the id.
export function assignId(ledger, key) {
  const k = String(key);
  if (Object.prototype.hasOwnProperty.call(ledger.ids, k)) return ledger.ids[k];
  const id = ledger.next;
  ledger.ids[k] = id;
  ledger.next = id + 1;
  return id;
}

export function loadLedger(path) {
  try {
    if (!existsSync(path)) return makeLedger();
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || typeof raw.next !== 'number' || !raw.ids) return makeLedger();
    return { next: raw.next, ids: { ...raw.ids } };
  } catch {
    // A corrupt ledger must not wedge the run — start fresh rather than throw.
    return makeLedger();
  }
}

export function saveLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2));
}
