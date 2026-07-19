// Zero-dep fixture for INC.1 framework-id de-fragmentation (decisions.md 2026-07-15 "whole-site
// reach"). Models the first target's identity failure: an Ant Design Tabs bar whose interactive
// controls carry FRAMEWORK-GENERATED ids (`rc-tabs-0-tab-*`) that SHIFT across reloads and,
// under the pre-INC.1 identity, anchor each tab on its OWN id — so three tabs that are one
// logical control fragment into THREE templates, and the replay chain that depends on a stable
// selector across reloads breaks.
//   - Three `role=tab` controls, IDENTICAL class structure, differ ONLY by a framework id +
//     text + aria-selected. INC.1 rejects the framework id → all three collapse to ONE
//     structural template with three addressable instances (the de-fragmentation), and their
//     durable locator falls to role+name (stable across reloads) instead of the shifting id.
//   - Active state is modeled via `aria-selected` (an ATTRIBUTE — our template path ignores it,
//     so it is non-fragmenting). A CLASS-based active marker (`ant-tabs-tab-active`) is a
//     SEPARATE fragmentation source (nav-active-marker normalization, a later increment) and is
//     deliberately NOT modeled here, so this fixture isolates the ID fragmentation INC.1 targets.
//   - A hashed-id control (`#btn-<hex>` — CSS-in-JS style) proves the hashed-id branch: rejected
//     as an anchor, structural path instead.
//   - A plain SEMANTIC id (`#save`) is the NEGATIVE control: it must STILL anchor + stay the
//     durable locator, proving the rejection is scoped to framework noise, not all ids.
// Static page (no traffic): this fixture exercises the DOM-IDENTITY class, not causal
// attribution (that is covered by the traffic-bearing fixtures).

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Framework-id fixture</title></head>
<body>
  <div class="ant-tabs ant-tabs-top">
    <div class="ant-tabs-nav">
      <div class="ant-tabs-nav-list">
        <div role="tab" id="rc-tabs-0-tab-overview" class="ant-tabs-tab-btn" aria-selected="true" tabindex="0">Overview</div>
        <div role="tab" id="rc-tabs-0-tab-settings" class="ant-tabs-tab-btn" aria-selected="false" tabindex="-1">Settings</div>
        <div role="tab" id="rc-tabs-0-tab-members" class="ant-tabs-tab-btn" aria-selected="false" tabindex="-1">Members</div>
      </div>
    </div>
  </div>
  <button id="btn-a1b2c3d4e5" class="submit" type="button">Go</button>
  <button id="save" class="primary" type="button">Save</button>
</body></html>`;

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
