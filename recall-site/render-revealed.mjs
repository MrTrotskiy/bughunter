// Projection (c): interaction-revealed controls (the hidden-function class). A portal case's item is
// NOT in the initial DOM at runtime — it MOUNTS into a body-detached container on the trigger click,
// which is the exact AntD dropdown defect the crawler's ownsViaReveal / reveal-backfill exist for.
//
// To keep the anti-drift guard a PURE STRING test (no browser), the item markup lives in a <template>:
// its data-testid is present in the served source, so the manifest projection and the rendered-testid
// regex agree, while the browser does NOT render template content. The reveal script clones the template
// into a body-child #portal-root on the trigger click — a true mount-on-click, trigger-detached portal
// at runtime, so the crawler must click the "…" opener (revealPath) before the item is reachable.

// One dropdown menu item (an AntD .ant-dropdown-menu-item the crawler folds by name). The endpoint is
// wired as fire attributes; the delegated listener in render-page fires it (unless the danger-floor
// declines the click first).
function itemHtml(c) {
  // A data-testid is emitted ONLY for the testid identity class — a portal/role-name reveal case is
  // identified by role+name WITHOUT a stable testid (that is what made portal identity hard).
  const tid = c.identityClass === 'testid' && c.testid ? ` data-testid="${c.testid}"` : '';
  const url = c.endpoint ? c.endpoint.pattern.replace(/:[^/]+/g, '1') : '';
  const fire = c.endpoint ? ` data-fire-method="${c.endpoint.method}" data-fire-url="${url}"` : '';
  const attrs = `${tid} data-caseid="${c.id}"${fire}`;
  if (c.role === 'menuitem') {
    // An AntD .ant-dropdown-menu-item the crawler folds by name.
    return `<div role="menuitem" class="ant-dropdown-menu-item"${attrs} style="cursor:pointer">${c.name}</div>`;
  }
  return `<button type="button"${attrs}>${c.name}</button>`;
}

const REVEAL_JS = `
  (function () {
    var root = document.createElement('div');
    root.id = 'portal-root';
    document.body.appendChild(root);
    document.addEventListener('click', function (e) {
      var trig = e.target.closest('button[data-portal-trigger]');
      if (!trig) return;
      var tpl = document.querySelector('template[data-portal-for="' + trig.id + '"]');
      if (!tpl) return;
      // Mount DETACHED from the trigger (a body-portal dropdown), wrapped in .ant-dropdown.
      var dd = document.createElement('div');
      dd.className = 'ant-dropdown';
      dd.appendChild(tpl.content.cloneNode(true));
      root.innerHTML = '';
      root.appendChild(dd);
    });
  })();
`;

// HOVER reveal: a control shown only while a trigger is hovered (no click, no focus). This is the
// hygge-crm known-stall class — the click-driven crawl never hovers, so a hover-only control is
// EXPECTED to be missed (the case carries expectReach:false). Kept in the DOM but display:none, shown
// on mouseenter — its markup (and any name) is in the served source, so the manifest still declares it.
const HOVER_JS = `
  document.addEventListener('mouseenter', function (e) {
    var t = e.target && e.target.closest && e.target.closest('[data-hover-trigger]');
    if (!t) return;
    var tip = document.querySelector('[data-tip-for="' + t.id + '"]');
    if (tip) tip.style.display = 'block';
  }, true);
`;

export function revealedHtml(cases) {
  const reveal = cases.filter((c) => c.revealPath && c.revealPath.length);
  if (!reveal.length) return '';

  const portal = reveal.filter((c) => c.revealKind !== 'hover');
  const hover = reveal.filter((c) => c.revealKind === 'hover');

  const portalTriggers = [...new Set(portal.flatMap((c) => c.revealPath))]
    .map((id) => `<button id="${id}" data-portal-trigger type="button" aria-label="More" style="cursor:pointer">⋯</button>`)
    .join('\n  ');
  const templates = portal
    .map((c) => `<template data-portal-for="${c.revealPath[c.revealPath.length - 1]}">${itemHtml(c)}</template>`)
    .join('\n  ');

  // A hover control lives next to its trigger in a display:none tooltip revealed on mouseenter.
  const hoverHtml = hover.map((c) => {
    const trig = c.revealPath[c.revealPath.length - 1];
    return `<span id="${trig}" data-hover-trigger tabindex="-1">ⓘ</span>`
      + `<div class="tooltip" data-tip-for="${trig}" style="display:none">${itemHtml(c)}</div>`;
  }).join('\n  ');

  const scripts = `<script>${REVEAL_JS}</script>` + (hover.length ? `<script>${HOVER_JS}</script>` : '');
  return `${portalTriggers}\n  ${templates}\n  ${hoverHtml}\n  ${scripts}`;
}
