// Fixture for locator preference. Controls exercising every rung of the ladder so the
// classifier's KIND + the two-level uniqueness gate can be asserted:
//   #save     — a UNIQUE authored data-testid → instance discriminator (unique=true).
//   .row btn  — TWO DOM buttons of one template sharing a data-testid → template MARKER
//               (unique=false: the value is not a per-instance discriminator). NOTE: because
//               data-testid is in the identity DATA_ATTRS, both share one instanceKey and
//               mergeSnapshot dedups them to ONE stored instance — the uniqueness gate still
//               sees BOTH pre-merge, so the marker is correctly flagged non-unique.
//   #stable   — a strictly-stable id, no test-id → locator type 'id'.
//   the link  — no test-id, no stable id, but role+name → locator type 'role-name'.
//   the div   — [tabindex] with no name → nothing durable → locator type 'css'.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Locator</title></head>
<body>
  <h1>Locator demo</h1>
  <button data-testid="save-btn" id="save" type="button">Save</button>
  <ul>
    <li><button data-testid="row-action" type="button">Act</button></li>
    <li><button data-testid="row-action" type="button">Act</button></li>
  </ul>
  <button id="stable" type="button">Stable</button>
  <a href="/next">Next page</a>
  <div tabindex="0" class="widget"></div>
</body></html>`;

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
