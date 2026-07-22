// RECALL FIXTURE — the ONE declarative source of truth for a known-ground-truth site.
// The served site (render-*.mjs), the API (handlers.mjs) and the /__manifest__ projection
// (manifest.mjs) are ALL pure projections of this table, so the manifest can never drift
// from what the site actually renders (decisions.md 2026-07-22).
//
// A recall row models one PLANTED case the crawler must discover. Cases are seeded ONLY from
// failures measured on a real target (memory crawler-self-sabotage, hygge-crm-recon) — never
// from imagination, or the fixture measures our imagination instead of the crawler.
//
// Row schema (every field declarative — the projections read them, nothing computes identity):
//   id            stable human key; also the manifest key and the DOM data-caseid
//   caseClass     home | route-transition | hidden-function | request-endpoint  (WHAT is tested)
//   identityClass testid | role-name | positional | portal  (HOW HARD the crawler must work to
//                 identify it — recall is sliced by this so easy-mode never hides a hard-mode gap)
//   route         routeKey where the control lives (joins via lib/recon/scope.routeKey)
//   testid        the join key when identityClass==='testid'; null otherwise (rendered as
//                 data-testid ONLY for the testid class — a positional/role-name/portal case is
//                 reached WITHOUT a testid to lean on, which is the point of the difficulty slice)
//   name          accessible name; '' models the icon-only control (the logout-by-icon defect)
//   role          button | link | row | menuitem
//   href          navigation target for a link/row route-transition (optional)
//   revealPath    ids of DOM controls to activate before this one is in the DOM ([] = baseline-visible)
//   endpoint      { method, pattern, effect } the control fires (joins via toUrlPattern); null = no request
//   danger        null | destructive | auth | payment | communication — a danger case scores "found"
//                 = control discovered AND its effect counter stayed 0 (correctly declined, not missed)

export const CASES = [
  // home — the entry page's primary nav into the app; the EASIEST class (a plain <a href> + testid).
  {
    id: 'home-enter', caseClass: 'home', identityClass: 'testid', route: '/',
    testid: 'nav-contacts', name: 'Contacts', role: 'link', href: '/contacts',
    revealPath: [], endpoint: null, danger: null,
  },

  // request-endpoint (happy path) — a plain testid'd button firing a create. The recall FLOOR.
  {
    id: 'create-contact', caseClass: 'request-endpoint', identityClass: 'testid', route: '/contacts',
    testid: 'contact-create', name: 'New contact', role: 'button',
    revealPath: [], endpoint: { method: 'POST', pattern: '/api/contacts', effect: 'createHits' }, danger: null,
  },

  // request-endpoint + danger:auth — the SELF-SABOTAGE seed: an icon-only logout with an EMPTY
  // accessible name but an authored testid ('logout'). This is the exact shape of the live defect
  // (memory crawler-self-sabotage): the name+route haystack is blank, so the gate returned "safe" and
  // FIRED it — the fix reads the AUTHORED id (danger-floor.authoredIdOf). The crawler must DISCOVER it
  // and DECLINE to fire it (danger-floor); firing it counts as a rail failure, not recall.
  {
    id: 'logout-icon', caseClass: 'request-endpoint', identityClass: 'testid', route: '/contacts',
    testid: 'logout', name: '', role: 'button',
    revealPath: [], endpoint: { method: 'POST', pattern: '/api/logout', effect: 'logoutHits' }, danger: 'auth',
  },

  // route-transition — the HREFLESS clickable row (hygge-crm: an onClick row with no <a href>, the
  // class that had NEVER opened a detail page). Reached by role+name, fires the detail GET.
  {
    id: 'contact-row-open', caseClass: 'route-transition', identityClass: 'role-name', route: '/contacts',
    testid: null, name: 'Ada Lovelace', role: 'row', href: '/contacts/1',
    revealPath: [], endpoint: { method: 'GET', pattern: '/api/contacts/:id', effect: 'detailHits' }, danger: null,
  },

  // hidden-function + PORTAL — the biggest hygge-crm reach defect: a Delete that AntD renders as a
  // body-portal dropdown item (detached from the row), reachable only by first clicking the "…" opener.
  // The crawler must reveal it (click contact-more-btn), then DECLINE it (destructive). Tests portal REACH
  // (ownsViaReveal / reveal-backfill) AND the destructive decline; the trigger is NOT a case (rendered
  // by render-revealed, no testid, so it is not a scored extra).
  {
    id: 'row-delete-portal', caseClass: 'hidden-function', identityClass: 'portal', route: '/contacts',
    testid: null, name: 'Delete', role: 'menuitem', revealPath: ['contact-more-btn'],
    endpoint: { method: 'DELETE', pattern: '/api/contacts/:id', effect: 'deleteHits' }, danger: 'destructive',
  },

  // hidden-function + HOVER — the hygge-crm KNOWN-STALL: a control shown only on hover, never on click
  // or focus. The click-driven crawl does not hover, so this is EXPECTED to be missed (expectReach:false).
  // It is the fixture's whole point — measuring what the crawler genuinely CANNOT reach, not only what it
  // can. If a future crawler DOES reach it, the test's expected-miss assertion flips and we promote it.
  {
    id: 'hover-quickview', caseClass: 'hidden-function', identityClass: 'role-name', route: '/contacts',
    testid: null, name: 'Quick view', role: 'button', revealPath: ['contact-info-icon'], revealKind: 'hover',
    endpoint: { method: 'GET', pattern: '/api/contacts/:id/quickview', effect: 'quickviewHits' },
    danger: null, expectReach: false,
  },
];
