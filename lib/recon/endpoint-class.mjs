// ENDPOINT CLASS — is this endpoint a READ or a WRITE?
//
// This exists because the answer "non-GET means write" is wrong on real APIs, and being wrong about it
// cost this project a whole round of misprioritized work. The live target speaks POST-for-read: a crawl
// reported 18 "write endpoints" and the truthful count was ONE. Every one of `listnuggets`,
// `getothersprofile`, `searchusers`, `getfaq`, `listevents` is a READ that happens to travel by
// POST — the app puts its query in a JSON body instead of a query string. Fixes were then ranked by a
// number that was 18× too high, and a run with zero mutations read as a run with a healthy write surface.
//
// The honest classifier would compare state before and after (a write is an endpoint after which the same
// read returns something different). That needs a second request per endpoint and is a separate capability.
// What this module does instead is name the heuristic OUT LOUD and keep it in one place, so a caller can
// see the basis of the verdict rather than inheriting a hidden assumption about HTTP methods.

// Read VERBS in the endpoint path. Deliberately anchored to a path SEGMENT boundary (`/`, `_`, `-`, or the
// start) so `list`/`get`/`search` match `listnuggets` and `get_status_detail` but not, say, `budget`.
const READ_VERB = /(?:^|[/_-])(list|get|search|fetch|read|view|load|query|check|count|detail|feed|find|lookup|suggest|autocomplete|filter|browse|export|download|poll|status|info)/i;

// Endpoints that are telemetry, not application writes. A crawl that "exercised" only these has exercised
// nothing the operator cares about, so they must never inflate the write count.
const TELEMETRY = /(?:google-analytics|googletagmanager|\/g\/collect|\/collect\b|segment\.io|sentry|datadog|mixpanel|amplitude|hotjar|doubleclick|facebook\.com\/tr)/i;

// Write VERBS — an explicit mutation word in the path. Checked BEFORE the read verbs so an endpoint like
// `updateusersettings` is a write even though it is not a GET and carries no read verb, and so
// `createlist` reads as a write rather than matching `list`.
const WRITE_VERB = /(?:^|[/_-])(create|add|new|insert|update|edit|modify|set|save|store|put|post(?!er)|send|submit|upload|delete|remove|destroy|cancel|clear|reset|follow|unfollow|like|unlike|block|unblock|report|join|leave|invite|accept|reject|approve|deny|subscribe|unsubscribe|pay|purchase|checkout|order|register|signup|login|logout)/i;

// Classify one endpoint. Returns 'read' | 'write' | 'write-unnamed' | 'telemetry'.
//
// `write-unnamed` is the FALLBACK verdict — a non-GET carrying neither a mutation verb nor a read verb — and
// it is kept SEPARATE from `write` because on a target that reads over POST it is where most reads land.
// Measured after wiring the classifier into probe rows: 28 acts recorded `write`, of which two or three were
// real. `nuggetcontentaudio` (text-to-speech), `influencerlist`, `texttoaudio` all arrived here, and so did
// `contactus`, which genuinely does write. That is the point: from the name alone these are INDISTINGUISHABLE,
// so the honest answer is a separate class rather than a guess in either direction. A caller that needs
// certainty must confirm by reading state back; a caller that just needs a headline must not count these as
// writes. This repeats a failure already on record — "18 write endpoints, the truthful count was ONE" — and
// the fix is the same one: surface the guess as a guess.
//
// Precedence is deliberate: telemetry first (it is never an application write however it is named), then an
// explicit write verb, then GET (a GET that somehow carries a write verb — `/deletePost?id=1` — is already
// caught above, which is the safe direction), then a read verb, and finally the method as a last resort.
export function classifyEndpoint({ method = 'GET', url = '', urlPattern = '' } = {}) {
  const hay = `${urlPattern || url || ''}`;
  if (TELEMETRY.test(hay)) return 'telemetry';
  if (WRITE_VERB.test(hay)) return 'write';
  if (String(method).toUpperCase() === 'GET') return 'read';
  if (READ_VERB.test(hay)) return 'read';                 // the POST-for-read case this module exists for
  return 'write-unnamed';                                  // a non-GET we cannot name: say so rather than guess
}

// Split a set of captured requests into the three buckets, de-duplicated per endpoint (not per call — 40
// calls to one list endpoint is one endpoint exercised). `unnamedWrites` is surfaced separately because
// those are the ones classified by the fallback rather than by evidence: an operator reading "3 writes"
// deserves to know how many of them were a guess.
export function classifyEndpoints(requests = []) {
  const reads = new Set();
  const writes = new Set();
  const telemetry = new Set();
  const unnamedWrites = new Set();
  for (const r of requests || []) {
    if (!r) continue;
    const key = `${r.method || 'GET'} ${r.urlPattern || r.url || ''}`;
    const cls = classifyEndpoint(r);
    if (cls === 'telemetry') { telemetry.add(key); continue; }
    if (cls === 'read') { reads.add(key); continue; }
    writes.add(key);
    if (!WRITE_VERB.test(`${r.urlPattern || r.url || ''}`)) unnamedWrites.add(key);
  }
  return {
    reads: [...reads],
    writes: [...writes],
    telemetry: [...telemetry],
    unnamedWrites: [...unnamedWrites],
  };
}
