// The run trail is MANDATORY (operator rule 2026-07-18: "logs are always mandatory"), while
// SCREENSHOTS stay opt-in ("screens are rational when the run is started in view mode").
//
// Guards: (1) no crawl can run unlogged — activeRunId mints an id when the operator supplied none and
//   PUBLISHES it into the environment so the sibling agent-path CLIs (whats-new / observe / route-cli,
//   separate processes) join the SAME run instead of fragmenting the trail; (2) a failed append THROWS
//   rather than silently dropping the record of an act that really happened — which now includes real
//   creates, edits and deletes; (3) openRun fails FAST on an unwritable trail, before any act; (4) view
//   mode is off by default, so frames cost nothing on an ordinary run.
//
// FAIL-ON-REVERT: restore `try { fs.appendFileSync(...) } catch {}` in traceEvent → "a failed append
//   throws" reds. Make activeRunId return null when the env is unset → "mints and publishes" reds.
//   Drop the `if (!viewMode()) return null` guard in makeCapture → the frames-off assertion in
//   tests/live/capture-causal.test.mjs (which sets BUGHUNTER_VIEW=1 deliberately) loses its meaning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeRunId, viewMode, traceEvent, openRun, runDir } from '../../lib/debug/trace.mjs';

test('activeRunId mints a run id when none is set, and publishes it for the sibling CLIs', () => {
  const env = {};
  const id = activeRunId(env);
  assert.match(id, /^r-\d{14}-[a-z0-9]{4}$/, 'a sortable, collision-resistant run id');
  assert.equal(env.BUGHUNTER_RUN_ID, id,
    'it must be published into the env — otherwise each agent-path CLI mints its own and the trail fragments');

  // An operator-supplied id always wins (a /recon run brackets its own id).
  assert.equal(activeRunId({ BUGHUNTER_RUN_ID: 'r-operator' }), 'r-operator');
});

test('view mode is OFF by default — frames are opt-in, events are not', () => {
  assert.equal(viewMode({}), false, 'an ordinary run pays nothing for screenshots');
  assert.equal(viewMode({ BUGHUNTER_VIEW: '1' }), true);
});

test('a failed append THROWS — an act that happened is never silently unrecorded', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-trace-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
    try { fs.chmodSync(path.join(dir, 'runs'), 0o700); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A healthy trail appends and returns a monotone seq.
  assert.equal(traceEvent('r-1', 'act', { templateId: 1 }), 0, 'first event is seq 0');
  assert.equal(traceEvent('r-1', 'act', { templateId: 2 }), 1, 'second event is seq 1');
  const lines = fs.readFileSync(path.join(runDir('r-1'), 'events.ndjson'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'both acts are on disk');
  assert.equal(JSON.parse(lines[1]).payload.templateId, 2, 'the payload round-trips');

  // Make the EVENT FILE itself unwritable → the append must FAIL LOUD, not swallow. (The file, not the
  // directory: appending to an existing file is governed by the file's own mode, so chmod-ing the dir
  // would leave the append succeeding and the assertion vacuous.) Skipped as root, which ignores mode
  // bits entirely — there the test would prove nothing rather than prove something false.
  if (process.getuid && process.getuid() === 0) return;
  const eventsFile = path.join(runDir('r-1'), 'events.ndjson');
  fs.chmodSync(eventsFile, 0o400);
  assert.throws(() => traceEvent('r-1', 'act', { templateId: 3 }),
    'an unwritable trail must throw — a silently dropped act is worse than a stopped crawl');
  fs.chmodSync(eventsFile, 0o600);
});

test('openRun fails FAST on an unwritable trail — before the crawl acts', (t) => {
  if (process.getuid && process.getuid() === 0) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-trace-ro-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
    try { fs.chmodSync(dir, 0o700); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.chmodSync(dir, 0o500);   // read-only state dir → runs/ cannot be created
  assert.throws(() => openRun({ runId: 'r-x', target: 'http://example.test/' }),
    'the run must refuse to start rather than crawl unlogged');
});
