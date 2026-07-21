// Fixture for the ANTD WIDGET DURABLE LOCATOR (CLASS 2 — the biggest real-coverage NO_INSTANCE fix).
// An antd Select's inner <input> is BARE (no stable class/id/role/name), so its recorded locator is the
// POSITIONAL css path — and the moment antd re-mounts the widget's internals between reveal and act, that
// path goes stale and resolveHandle returns null → NO_INSTANCE. The durable handle is the widget's own
// CLICKABLE affordance `.ant-select-selector`, scoped by the form-item LABEL text ("Category"), both of
// which survive the re-mount.
//
//   .ant-form-item "Category" — a realistic antd Select (`.ant-select > .ant-select-selector >
//       .ant-select-selection-search > input`). Clicking `.ant-select-selector` fires GET /api/options
//       (lazy option load) and shows the dropdown; clicking an option fires GET /api/pick. Opening is what
//       the act attributes.
//   window.__reshuffle() — re-mounts the select's inner subtree with an extra wrapper + a placeholder before
//       the input, so the input's stored positional selector no longer resolves (proven page.$ === null in
//       the test) while `.ant-form-item:has("Category") .ant-select-selector` still does.
//   GET /api/poll — a 100ms background poll, so the causal window has an adversarial in-window tick to drop.
import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>antd select fixture</title></head>
<body>
  <form class="ant-form">
    <div class="ant-form-item">
      <div class="ant-form-item-label"><label>Category</label></div>
      <div class="ant-form-item-control">
        <div class="ant-select" id="sel">
          <div class="ant-select-selector">
            <span class="ant-select-selection-search"><input readonly autocomplete="off"></span>
            <span class="ant-select-selection-placeholder">Pick one</span>
          </div>
        </div>
      </div>
    </div>
  </form>
  <div class="ant-select-dropdown ant-select-dropdown-hidden" id="dd">
    <div class="ant-select-item ant-select-item-option" data-value="a">Alpha</div>
    <div class="ant-select-item ant-select-item-option" data-value="b">Beta</div>
  </div>
  <script>
    function wire() {
      var sel = document.getElementById('sel');
      sel.querySelector('.ant-select-selector').addEventListener('click', function () {
        fetch('/api/options').catch(function(){});                    // lazy option load — the attributed request
        document.getElementById('dd').classList.remove('ant-select-dropdown-hidden');
      });
    }
    document.querySelectorAll('#dd .ant-select-item-option').forEach(function (opt) {
      opt.addEventListener('click', function () {
        fetch('/api/pick?v=' + opt.getAttribute('data-value')).catch(function(){});
        document.getElementById('dd').classList.add('ant-select-dropdown-hidden');
      });
    });
    wire();
    // Re-mount the select's inner subtree: an extra wrapper + a placeholder node before the input, so the
    // input lands at a new depth/position and its stored positional selector goes stale. The .ant-select
    // ancestor + .ant-select-selector clickable + the "Category" label all survive.
    window.__reshuffle = function () {
      var sel = document.getElementById('sel');
      sel.innerHTML = '<div class="ant-select-inner"><div class="ant-select-selector">'
        + '<b class="pad"></b><span class="ant-select-selection-search"><input readonly autocomplete="off"></span>'
        + '<span class="ant-select-selection-placeholder">Pick one</span></div></div>';
      wire();
    };
    setInterval(function () { fetch('/api/poll').catch(function(){}); }, 100);
  </script>
</body></html>`;

export async function start(port = 0) {
  let polls = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/poll') { polls++; res.writeHead(200).end('{}'); return; }
    if (url.pathname === '/api/options') { res.writeHead(200, { 'content-type': 'application/json' }).end('["a","b"]'); return; }
    if (url.pathname === '/api/pick') { res.writeHead(200).end('{}'); return; }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE); return; }
    res.writeHead(404).end();
  });
  server.pollHits = () => polls;
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}
