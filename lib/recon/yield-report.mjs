// YIELD REPORT — "did the crawl actually DO anything?", answered from the run trail.
//
// This exists because of a real failure: three consecutive runs were reported as progress when the trail
// showed ZERO acts, and a full crawl scored "Post Nugget" as covered while it fired no request at all.
// Both facts were sitting in events.ndjson the whole time. The graph could not show them — it records
// what was reached, not whether reaching it did anything — and reading the trail by hand depended on
// remembering to look. So the check becomes a command instead of a habit.
//
// Two questions, both answered per run:
//   1. Did we ACT, or only navigate? (route events vs act events — a walk that only navigates is broken)
//   2. Did our acts CAUSE anything? (acts with zero captured requests are inert clicks)
//
// Reads only the trail. No browser, no graph mutation.

import fs from 'node:fs';
import path from 'node:path';
import { runDir } from '../debug/trace.mjs';
import { classifyEndpoints } from './endpoint-class.mjs';

function readEvents(runId) {
  const file = path.join(runDir(runId), 'events.ndjson');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn final line must not hide the rest */ }
  }
  return out;
}

export function yieldOf(runId) {
  const events = readEvents(runId);
  if (!events) return null;

  const routes = events.filter((e) => e.kind === 'route');
  const acts = events.filter((e) => e.kind === 'act');
  const failedInline = acts.filter((e) => e.payload && e.payload.error);
  const failedEvents = events.filter((e) => e.kind === 'act.failed');
  const ok = acts.filter((e) => e.payload && !e.payload.error);
  const fired = ok.filter((e) => (e.payload.requests || []).length > 0);
  const inert = ok.filter((e) => (e.payload.requests || []).length === 0);

  // The write surface is what a QA run is ultimately for: a crawl that never changed anything has
  // exercised nothing the user can break. Counted per distinct endpoint, not per call.
  //
  // This used to classify by HTTP method — write := non-GET — and that was a LIE on the live target,
  // which speaks POST-for-read. It reported 18 write endpoints when exactly one was a mutation, and
  // fixes were prioritized off that number for several rounds. Classification now lives in
  // endpoint-class.mjs, which reads the endpoint's own verb and says so.
  const all = [];
  for (const e of fired) for (const r of e.payload.requests || []) all.push(r);
  const cls = classifyEndpoints(all);
  const reads = new Set(cls.reads);
  const writes = new Set(cls.writes);

  // Named controls that were acted successfully and caused NOTHING — the "scored covered, did nothing"
  // class. Submit-like names are called out separately: a silent Submit is almost always a real defect
  // in the crawl (an unfilled form), not a genuinely inert control.
  const SUBMITISH = /\b(submit|send|post|save|create|add|update|continue|next|apply|confirm|publish|share|comment|reply|invite|request)\b/i;
  const silent = [];
  const silentSubmits = [];
  for (const e of inert) {
    const name = (e.payload.name || '').trim();
    if (!name) continue;
    const entry = { templateId: e.payload.templateId, name, route: e.payload.route };
    silent.push(entry);
    if (SUBMITISH.test(name)) silentSubmits.push(entry);
  }

  return {
    runId,
    navigations: routes.length,
    acts: acts.length,
    failed: failedInline.length + failedEvents.length,
    fired: fired.length,
    inert: inert.length,
    actsPerNavigation: routes.length ? +(acts.length / routes.length).toFixed(2) : 0,
    endpoints: { reads: reads.size, writes: writes.size, writeList: [...writes].slice(0, 20), telemetry: cls.telemetry.length, unnamedWrites: cls.unnamedWrites.length },
    silentSubmits: silentSubmits.slice(0, 20),
    silentCount: silent.length,
  };
}

// The verdict line. Deliberately blunt: these are the two ways a run can look busy and be worthless.
export function verdictFor(y) {
  const out = [];
  if (y.acts === 0) {
    out.push(`BROKEN: ${y.navigations} navigations and ZERO acts — the walk never clicked anything.`);
  } else if (y.actsPerNavigation < 0.2) {
    out.push(`WASTEFUL: ${y.acts} acts across ${y.navigations} navigations (${y.actsPerNavigation}/nav) — mostly walking, barely acting.`);
  }
  if (y.acts > 0 && y.fired === 0) {
    out.push('BROKEN: every act fired ZERO requests — nothing reached the server.');
  } else if (y.acts > 0 && y.fired / y.acts < 0.3) {
    out.push(`LOW YIELD: only ${y.fired}/${y.acts} acts caused a request — most clicks did nothing.`);
  }
  if (y.silentSubmits.length) {
    out.push(`${y.silentSubmits.length} SUBMIT-like control(s) fired nothing (an unfilled form submits nothing): `
      + y.silentSubmits.slice(0, 5).map((s) => `"${s.name}"`).join(', '));
  }
  if (y.endpoints.writes === 0) {
    out.push('NO WRITES: not one mutating endpoint was exercised — nothing was created, changed or deleted.');
  } else if (y.endpoints.unnamedWrites) {
    // Say how much of the write count is a GUESS. `unnamedWrites` are non-GET endpoints with no mutation
    // verb in the path — classified as writes by the fallback, not by evidence. Reporting them silently
    // is how "18 write endpoints" once stood in for one real mutation.
    out.push(`${y.endpoints.writes} write endpoint(s), of which ${y.endpoints.unnamedWrites} classified by fallback (non-GET, no mutation verb) — treat those as unconfirmed.`);
  }
  if (!out.length) out.push(`healthy: ${y.fired}/${y.acts} acts caused requests, ${y.endpoints.writes} write endpoint(s) exercised.`);
  return out;
}
