// Zero-dep fixture for the MENU-EVENT SWEEP (event-driven in-app-nav, Phase-1 close increment). A
// CONSTANT-URL SPA (the URL never changes) whose SECTIONS are reached ONLY by clicking href-less onClick
// controls inside a <nav> landmark — the first-target class (Groups/Events swap content in place, never a
// distinct URL). It exists to prove: (1) a nav-landmark control is IDENTIFIED (node.navControl) and
// FRONT-LOADED by the frontier over an equally-eligible NON-nav control; (2) acting a nav opener reveals
// its section child and causally attributes the section-load read-over-POST; (3) the child is reachable
// from a COLD re-nav via reveal-replay; (4) the in-window background poll is NEVER credited.
//
//   - GET  /api/init              one fetch on load                 → LOAD BURST (under __idle__, token-excluded).
//   - GET  /api/poll              150ms setInterval, whole run      → BACKGROUND (must stay uncredited).
//   - #nav-groups (in <nav>)      href-less onClick section opener. Fires read-over-POST /api/section/groups
//                                 (NON-GET so allGet=false → the reveal stamp needs --opener-replayable, the
//                                 real target case) and reveals #groups-item in the section slot.
//   - #groups-item (revealed)     the section CHILD (absent at load). Fires GET /api/groupsinfo — the terminal
//                                 read whose causal edge is asserted (wire-before-DOM), reachable only after
//                                 the nav opener, i.e. via reveal-replay from a cold reset.
//   - #plain-btn (in <main>)      a NON-nav baseline control, equally eligible. Fires GET /api/plain. It must
//                                 be emitted AFTER the nav controls — the priority the sweep guards.
//
// Names are benign reads ("Groups"/"Events"/"Open group"): the sweep needs NO MUTATION_FLOOR relax, so a
// write-verb name would be refused at click time and confound the mechanism. Two nav sections (Groups,
// Events) so the sweep front-loads BOTH before the plain control.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Menu-nav fixture</title></head>
<body>
  <nav aria-label="sections">
    <button id="nav-groups" type="button">Groups</button>
  </nav>
  <!-- Events uses the ARIA TAB pattern (role=tablist/tab) with NO <nav> element — the real target
       shape (div[role=tab] in div[role=tablist]). It must ALSO be identified as a nav control. -->
  <div role="tablist" aria-label="more sections">
    <div id="nav-events" role="tab" tabindex="0">Events</div>
  </div>
  <main>
    <button id="plain-btn" type="button">Refresh feed</button>
    <div id="section"></div>
  </main>
  <script>
    // LOAD BURST + BACKGROUND poll — the honest traffic classes (excluded / uncredited).
    fetch('/api/init').catch(function () {});
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 150);

    // A non-nav baseline control (equally eligible, must be swept AFTER the nav controls).
    document.getElementById('plain-btn').addEventListener('click', function () {
      fetch('/api/plain').catch(function () {});
    });

    // Section openers: href-less onClick controls in <nav>. Each fires a read-over-POST section load
    // (allGet=false on purpose) and swaps a section child into #section — constant URL throughout.
    function wireSection(navId, slug) {
      document.getElementById(navId).addEventListener('click', function () {
        fetch('/api/section/' + slug, { method: 'POST' }).catch(function () {});
        var slot = document.getElementById('section');
        slot.innerHTML = '<div class="panel"><button id="' + slug + '-item" type="button">Open ' + slug + '</button></div>';
        // the section CHILD: a terminal read, reachable only after its nav opener (→ reveal-replay).
        document.getElementById(slug + '-item').addEventListener('click', function () {
          fetch('/api/' + slug + 'info').catch(function () {});
        });
      });
    }
    wireSection('nav-groups', 'groups');
    wireSection('nav-events', 'events');
  </script>
</body></html>`;

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/dashboard') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    // Every /api/* is a benign read/section-load: 200 with a tiny JSON body. The section-load POST and the
    // child GET are what the test attributes; init/poll are the excluded/uncredited classes.
    if (url.pathname.startsWith('/api/')) { sendJson(res, 200, { ok: true, path: url.pathname }); return; }
    sendJson(res, 404, { ok: false });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start(3400).then((s) => process.stdout.write(JSON.stringify({ ok: true, port: s.address().port }) + '\n'));
}
