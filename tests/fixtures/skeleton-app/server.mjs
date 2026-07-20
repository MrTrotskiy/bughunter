// Zero-dep fixture for the DOM-skeleton capture (lib/graph/dom-skeleton.mjs).
//
// It exists to exercise the two properties that can silently rot:
//
// (1) VISIBILITY PARITY. The skeleton restates dom-snapshot's isVisible predicate (it cannot
//     import it — that copy is a closure inside another page.evaluate payload), so the fixture
//     must cover EVERY branch where the two could drift, not just the happy one:
//       #vis        plainly visible
//       #dnone      display:none                         -> hidden
//       #vhidden    visibility:hidden                    -> hidden
//       #opacity0   opacity:0                            -> VISIBLE (it has a box; Playwright parity)
//       #zeroarea   width:0;height:0                     -> hidden (zero-AREA box)
//       #inherited  child of a visibility:hidden parent  -> hidden (visibility inherits)
//     Every one of these is a real control (dom-snapshot collects it), so the two predicates can
//     be compared element-for-element rather than by construction.
//
// (2) THE CAP AND ITS COUNTER. `/big?n=<N>` renders N plain <div>s so the node count is driven
//     well past the cap on demand — proving the skeleton emits exactly `cap` nodes AND reports
//     the remainder in `truncated` rather than dropping it silently.
//
// The page also carries ordinary structure (nav / main / a table with rows / headings) so the
// score-ranked cap has genuinely-informative nodes to prefer over the filler.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Skeleton fixture</title>
<style>
  .box { width: 60px; height: 20px; }
  #vhidden { visibility: hidden; }
  #opacity0 { opacity: 0; }
  #zeroarea { width: 0; height: 0; padding: 0; border: 0; }
  .hiddenparent { visibility: hidden; }
</style></head>
<body>
  <nav aria-label="Main"><a href="/">Home</a><a href="/big">Big</a></nav>
  <main>
    <h1>Skeleton demo</h1>
    <section data-testid="controls">
      <button id="vis" class="box" type="button">Visible</button>
      <button id="dnone" class="box" type="button" style="display:none">Display none</button>
      <button id="vhidden" class="box" type="button">Visibility hidden</button>
      <button id="opacity0" class="box" type="button">Opacity zero</button>
      <button id="zeroarea" type="button">Zero area</button>
      <div class="hiddenparent"><button id="inherited" class="box" type="button">Inherited</button></div>
    </section>
    <table><tbody>
      <tr><td>Ada</td><td><button id="edit-1" type="button">Edit</button></td></tr>
      <tr><td>Grace</td><td><button id="edit-2" type="button">Edit</button></td></tr>
    </tbody></table>
  </main>
</body></html>`;

// N filler divs: enough plain, low-score nodes to push any realistic cap over.
function big(n) {
  const filler = Array.from({ length: n }, (_, i) => `<div class="filler">row ${i}</div>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Big fixture</title></head>
<body><main><h1>Big</h1><button id="only-control" type="button">Act</button>${filler}</main></body></html>`;
}

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === '/big') {
      const n = Math.min(5000, Number(url.searchParams.get('n')) || 1200);
      res.end(big(n));
      return;
    }
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
