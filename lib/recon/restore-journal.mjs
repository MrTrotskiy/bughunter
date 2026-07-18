// RESTORE JOURNAL — the compensation log behind the operator's "another user's content may be edited,
// but must be put back" rule (decisions.md 2026-07-18). Every edit of a FOREIGN item is bracketed:
// capture the original → journal it → act → write the original back → close the entry.
//
// APPEND-ONLY on purpose. The journal is written BEFORE the act, so a crash, a killed browser, or a
// hung page can never lose the fact that we changed something: the entry simply stays OPEN, and the
// next run replays the outstanding rollbacks (`pendingEntries`). Closing an entry appends a status
// record rather than rewriting the file, so a torn write can only ever lose the CLOSE (leaving a
// harmless duplicate restore attempt), never the OPEN.
//
// HONESTY: a restore is an attempt, not a guarantee — a server-side edit may be unrepeatable (a
// moderation flag, a version bump, a one-way state machine). A failed restore is recorded as
// `failed` and surfaced loudly; it is never silently dropped or optimistically marked restored.
//
// Pure file I/O + a DOM capture helper. No policy decisions live here (explore-policy.mjs owns those).

import fs from 'node:fs';
import path from 'node:path';
import { ITEM_BOUNDARY } from './hunt-gate.mjs';

const FILE = 'restore-journal.ndjson';

const journalPath = (stateDir) => path.join(stateDir, FILE);

function appendRecord(stateDir, rec) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(journalPath(stateDir), JSON.stringify(rec) + '\n', { mode: 0o600 });
  return rec;
}

// Read every record, newest status wins per `seq`. A malformed line is SKIPPED, never fatal — a torn
// final write must not make the whole journal unreadable (that would strand every pending rollback).
export function readJournal(stateDir) {
  let raw;
  try { raw = fs.readFileSync(journalPath(stateDir), 'utf8'); } catch { return []; }
  const bySeq = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.seq == null) continue;
    const prev = bySeq.get(rec.seq);
    bySeq.set(rec.seq, prev ? { ...prev, ...rec } : rec);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// Entries still awaiting a successful rollback — what the next run must replay.
export function pendingEntries(stateDir) {
  return readJournal(stateDir).filter((e) => e.status === 'open' || e.status === 'failed');
}

// Journal an edit ABOUT to happen. Returns the entry (with its seq) so the caller can close it.
export function openEntry(stateDir, { runId, route, url, templateId, instanceKey, name, before }) {
  const seq = readJournal(stateDir).reduce((m, e) => Math.max(m, e.seq), 0) + 1;
  return appendRecord(stateDir, {
    seq, status: 'open', kind: 'foreign-edit',
    runId, route, url, templateId, instanceKey, name, before,
    openedAt: new Date().toISOString(),
  });
}

// Close an entry: 'restored' (the original is back) or 'failed' (it is NOT — surfaced, never hidden).
export function closeEntry(stateDir, seq, status, detail) {
  return appendRecord(stateDir, { seq, status, detail: detail || null, closedAt: new Date().toISOString() });
}

// Capture the restorable state of the item a control belongs to: the values of every editable field in
// its item boundary, each addressed by a selector we can re-resolve later, plus the boundary's visible
// text as a human-readable witness of what it looked like.
//
// Field selectors are built from the boundary down (`:nth-of-type` chain) rather than stored as element
// handles, because the restore may happen in a LATER PROCESS after a reload — a handle would be dead.
export async function captureBefore(handle) {
  if (!handle) return null;
  try {
    return await handle.evaluate((el, sel) => {
      const boundary = el.closest(sel) || el.parentElement;
      if (!boundary) return null;
      // A stable-ish path from the boundary to a descendant, for re-resolution after reload.
      const pathFrom = (root, node) => {
        const parts = [];
        for (let n = node; n && n !== root; n = n.parentElement) {
          const tag = n.tagName.toLowerCase();
          let i = 1;
          for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
          parts.unshift(`${tag}:nth-of-type(${i})`);
        }
        return parts.join(' > ');
      };
      const fields = [];
      for (const f of boundary.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, [contenteditable=""], [contenteditable="true"]')) {
        const isField = f.tagName === 'INPUT' || f.tagName === 'TEXTAREA';
        fields.push({
          path: pathFrom(boundary, f),
          kind: isField ? 'value' : 'html',
          value: isField ? f.value : f.innerHTML,
        });
      }
      return {
        boundaryPath: pathFrom(document.body, boundary),
        text: (boundary.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        fields,
      };
    }, ITEM_BOUNDARY);
  } catch {
    return null;
  }
}

// Write a captured `before` back onto the live page. Returns {ok, restored, detail}. Best-effort by
// nature: if the boundary or a field no longer resolves, that is reported — never papered over.
export async function applyRestore(page, before) {
  if (!before || !before.boundaryPath) return { ok: false, restored: 0, detail: 'no capture to restore' };
  try {
    const boundary = await page.$(before.boundaryPath);
    if (!boundary) return { ok: false, restored: 0, detail: 'item boundary no longer resolves' };
    let restored = 0;
    for (const f of before.fields || []) {
      const target = f.path ? await boundary.$(f.path) : boundary;
      if (!target) continue;
      if (f.kind === 'value') await target.fill(f.value, { timeout: 5000 });
      else await target.evaluate((el, html) => { el.innerHTML = html; }, f.value);
      restored++;
    }
    const total = (before.fields || []).length;
    return { ok: restored === total, restored, detail: restored === total ? null : `restored ${restored}/${total} field(s)` };
  } catch (err) {
    return { ok: false, restored: 0, detail: err?.message || 'restore threw' };
  }
}
