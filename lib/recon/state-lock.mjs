// state-lock — one crawl per state dir, enforced.
//
// WHY THIS EXISTS. "One incremental graph is the source of truth" is a founding invariant of this project
// and until now NOTHING enforced it. `saveGraph` is a whole-file write with no lock (graph-store.mjs), and
// `recon-run` re-reads the graph at the start of every round — so two crawls sharing a state dir each adopt
// the other's graph and write their own back over it, once per round.
//
// MEASURED, on this project, by accident: three crawls were started against one target without
// `BUGHUNTER_STATE_DIR`. They destroyed each other's data for half an hour. The element count of a single
// run oscillated 265 → 73 → 302 → 263 → 349 between ADJACENT snapshots — not discovery, file clobbering.
// Every graph-derived comparison from those runs had to be retracted (decisions.md, 2026-07-19).
// Nothing warned. Each run printed rising coverage throughout.
//
// So: an exclusive owner file, taken before the first read and released in the caller's finally. A second
// crawl against a live owner EXITS, naming the holder — a loud refusal at second zero instead of a silent
// day of unusable measurements. This is the Prevent form; the retraction was the Catch form, and it cost
// the whole session's numbers.
//
// A stale owner (the process is gone — crash, kill -9) is reclaimed automatically: the lock is a fact
// about a LIVE process, not a file that outlives it. Liveness is `process.kill(pid, 0)`, which signals
// nothing and only asks whether the pid exists.

import fs from 'node:fs';
import path from 'node:path';
import { envelopeError } from '../core/envelope.mjs';

const OWNER = 'OWNER.json';

// Is that pid still running? `kill(pid, 0)` delivers NO signal — it is the standard liveness probe.
// EPERM means the process exists but belongs to another user, which still counts as alive.
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}

function readOwner(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch { return null; }
}

// Claim `stateDir` for this process. Returns a release function. Throws STATE_DIR_BUSY when a LIVE crawl
// already owns it — the message names the holder and the fix, because the operator's next question is
// always "which one, and what do I do".
export function acquireStateDir(stateDir, { runId = null, pid = process.pid, now = Date.now() } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, OWNER);
  const mine = JSON.stringify({ runId, pid, startedAt: new Date(now).toISOString() }, null, 2);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // O_EXCL: the create IS the claim. Two processes racing here cannot both succeed.
      fs.writeFileSync(file, mine, { flag: 'wx' });
      return () => releaseStateDir(stateDir, { pid });
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
      const held = readOwner(file);
      // A corrupt owner file is stale by definition — nobody can prove they hold it.
      if (held && processAlive(held.pid)) {
        throw envelopeError({
          code: 'STATE_DIR_BUSY',
          message: `state dir ${stateDir} is already owned by a running crawl (pid ${held.pid}`
            + `${held.runId ? `, run ${held.runId}` : ''}, since ${held.startedAt || 'unknown'}). `
            + 'Two crawls sharing one state dir overwrite each other\'s graph every round — '
            + 'set BUGHUNTER_STATE_DIR to a separate directory for this run, or stop the other crawl.',
          exit: 'VIOLATION',
        });
      }
      // Stale: the owner is gone. Reclaim and retry the exclusive create ONCE, so a third process racing
      // us for the same stale lock still loses to whoever wins the O_EXCL.
      try { fs.unlinkSync(file); } catch { /* another process reclaimed it first — retry decides */ }
    }
  }
  throw envelopeError({
    code: 'STATE_DIR_BUSY',
    message: `could not claim state dir ${stateDir} (lost the race for a stale lock twice)`,
    exit: 'VIOLATION',
  });
}

// Release, idempotent, and ONLY our own claim — a crawl must never delete another crawl's lock, which is
// what would happen if a stale-reclaim raced a slow release.
export function releaseStateDir(stateDir, { pid = process.pid } = {}) {
  const file = path.join(stateDir, OWNER);
  const held = readOwner(file);
  if (!held || held.pid !== pid) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

// Who owns it right now (null when free)? Read-only — for a status CLI or a test.
export function stateDirOwner(stateDir) {
  const held = readOwner(path.join(stateDir, OWNER));
  if (!held) return null;
  return processAlive(held.pid) ? held : null;
}
