// Projection (a): a route -> full page HTML from the rows that live on it.
// Baseline-visible controls only in this increment (revealPath === []); interaction-revealed
// controls (modal/dropdown/overflow/portal) are added by render-revealed in a later increment.

import { controlHtml } from './render-visible.mjs';
import { revealedHtml } from './render-revealed.mjs';

// One delegated click handler wires every control's endpoint fire + optional route nav, so the
// crawler's click produces a real request the causal machinery can attribute. Mirrors the
// hunt-social-app api() helper shape.
const PAGE_JS = `
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-fire-url],[data-nav-to]');
    if (!el) return;
    var m = el.getAttribute('data-fire-method') || 'GET';
    var u = el.getAttribute('data-fire-url');
    var fired = u
      ? fetch(u, { method: m, headers: { 'content-type': 'application/json' },
          body: m === 'GET' ? undefined : '{}' }).catch(function () {})
      : Promise.resolve();
    var nav = el.getAttribute('data-nav-to');
    if (nav) { e.preventDefault(); fired.then(function () { location.href = nav; }); }
  });
`;

export function pageHtml(route, cases) {
  const here = cases.filter((c) => c.route === route && (!c.revealPath || c.revealPath.length === 0));
  const rows = here.filter((c) => c.role === 'row');
  const flat = here.filter((c) => c.role !== 'row');

  const flatHtml = flat.map(controlHtml).join('\n  ');
  const rowHtml = rows.length
    ? `<table><tbody>\n  ${rows.map(controlHtml).join('\n  ')}\n</tbody></table>`
    : '';
  // Interaction-revealed controls that live on this route (modal/dropdown/portal openers + items).
  const revealHtml = revealedHtml(cases.filter((c) => c.route === route));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Recall fixture ${route}</title></head>
<body>
  <h1>${route}</h1>
  ${flatHtml}
  ${rowHtml}
  ${revealHtml}
  <script>${PAGE_JS}</script>
</body></html>`;
}
