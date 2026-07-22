// Projection (b): one BASELINE-VISIBLE control's markup, keyed by identityClass.
// A data-testid is emitted ONLY for identityClass==='testid'. That is what makes the
// identity-difficulty slice real: a positional / role-name case must be reached by the
// crawler with NO testid to lean on, exactly as on a component-library target.

// The endpoint a control fires, as click-wired data attributes (the page JS in render-page
// reads them). A :param pattern is fired against a concrete id so the server sees a real hit.
function fireAttrs(c) {
  if (!c.endpoint) return '';
  const url = c.endpoint.pattern.replace(/:[^/]+/g, '1');
  return ` data-fire-method="${c.endpoint.method}" data-fire-url="${url}"`;
}

export function controlHtml(c) {
  const tid = c.identityClass === 'testid' && c.testid ? ` data-testid="${c.testid}"` : '';
  const cid = ` data-caseid="${c.id}"`;
  const fire = fireAttrs(c);

  if (c.role === 'link') {
    return `<a href="${c.href || '#'}"${tid}${cid}${fire}>${c.name}</a>`;
  }
  if (c.role === 'row') {
    // A roleless clickable row that fires its detail GET and swaps content in place (an SPA
    // route-transition). Deliberately NO full navigation: location.href in the same click races
    // the fetch and closes the causal window before the GET is captured — the transition is
    // represented by the attributed detail request, which is the hrefless-row defect's real signal.
    return `<tr${tid}${cid}${fire} style="cursor:pointer"><td>${c.name || '—'}</td></tr>`;
  }
  // button (default). An empty name models the icon-only control (the logout-by-icon defect):
  // no accessible name, a glyph the crawler cannot read as text.
  const label = c.name ? ` aria-label="${c.name}"` : '';
  const glyph = c.name || '⏻';
  return `<button type="button"${tid}${cid}${fire}${label}>${glyph}</button>`;
}
