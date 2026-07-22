// Projects CASES -> the /__manifest__ JSON. Pure function, no HTTP. The manifest is the KNOWN
// DENOMINATOR the recall scorer joins the crawl's graph against; because it is a projection of
// the SAME table the site renders from, it cannot drift from the served site (the anti-drift
// guard in recall-manifest.test.mjs proves the rendered testid set equals manifest.testids).

function uniq(xs) {
  return [...new Set(xs)];
}

export function manifestOf(cases) {
  const endpointKey = (e) => `${e.method} ${e.pattern}`;
  const endpoints = [];
  const seenEndpoint = new Set();
  for (const c of cases) {
    if (!c.endpoint) continue;
    const k = endpointKey(c.endpoint);
    if (seenEndpoint.has(k)) continue;
    seenEndpoint.add(k);
    endpoints.push({ method: c.endpoint.method, pattern: c.endpoint.pattern });
  }

  return {
    testids: uniq(cases.filter((c) => c.identityClass === 'testid' && c.testid).map((c) => c.testid)),
    routes: uniq(cases.map((c) => c.route)),
    endpoints,
    cases: cases.map((c) => ({
      id: c.id,
      caseClass: c.caseClass,
      identityClass: c.identityClass,
      testid: c.testid,
      name: c.name,
      role: c.role,
      route: c.route,
      endpoint: c.endpoint,
      danger: c.danger,
      // Whether the CURRENT crawler is expected to reach this case. false = a documented known-miss
      // (e.g. hover-only): the fixture measures what the crawler cannot do, not only what it can.
      expectReach: c.expectReach !== false,
    })),
  };
}
