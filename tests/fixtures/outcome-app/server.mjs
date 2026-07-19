// Fixture for OUTCOME OBSERVABLES — the three refusal tiers plus the success channel, each in isolation
// so a test can prove the reader sees that tier and not merely "something happened".
//
//   #native   — a required input; submitting empty raises WHATWG constraint validation (tier 1)
//   #aria     — a control marked aria-invalid with an aria-errormessage (tier 2)
//   #antd     — an AntD-shaped `.ant-form-item-explain-error` (tier 3)
//   #ok       — fires a request and renders a success toast in a live region (the success channel)
//
// The live target answers on NONE of the refusal tiers and only on the toast, which is exactly why all
// four must be readable independently: a target that is silent on 1-3 is normal, not broken.
import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Outcome fixture</title></head>
<body>
  <form id="f" onsubmit="return false">
    <input id="native" required placeholder="Name">
    <button id="submit-native" type="submit">Save</button>
  </form>
  <div><input id="aria" placeholder="Email"><span id="aria-msg"></span></div>
  <div class="ant-form-item" id="antd-wrap"><input id="antd" placeholder="Phone"></div>
  <!-- Boundary probing. #capped enforces its declared limit natively (the browser truncates); #uncapped
       declares nothing; #leaky DECLARES a limit and does not enforce it — the real defect shape. -->
  <input id="capped" maxlength="10" placeholder="Capped">
  <input id="uncapped" placeholder="Uncapped">
  <input id="leaky" data-maxlength="10" placeholder="Leaky">
  <button id="commit" type="button">Commit</button>
  <button id="ok" type="button">Post</button>
  <div id="toasts"></div>
  <script>
    document.getElementById('aria').addEventListener('click', function () {
      this.setAttribute('aria-invalid','true');
      this.setAttribute('aria-errormessage','aria-msg');
      document.getElementById('aria-msg').textContent = 'That email is not valid';
    });
    document.getElementById('antd').addEventListener('click', function () {
      var d = document.createElement('div');
      d.className = 'ant-form-item-explain-error';
      d.textContent = 'Phone is required';
      document.getElementById('antd-wrap').appendChild(d);
    });
    // Commits unconditionally, like the live target: no validation at all, only a success toast.
    document.getElementById('commit').addEventListener('click', function () {
      fetch('/api/commit', { method: 'POST' }).catch(function(){});
      var t = document.createElement('div');
      t.className = 'ant-message-notice ant-message-success';
      t.setAttribute('role','alert');
      t.textContent = 'Saved successfully';
      document.getElementById('toasts').appendChild(t);
    });
    document.getElementById('ok').addEventListener('click', function () {
      fetch('/api/post', { method: 'POST' }).catch(function(){});
      var t = document.createElement('div');
      t.className = 'ant-message-notice ant-message-success';
      t.setAttribute('role','alert');
      t.textContent = 'Post was successfully created';
      document.getElementById('toasts').appendChild(t);
    });
  </script>
</body></html>`;

export async function start(port = 0) {
  let posts = 0;
  let commits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/post') { posts++; res.writeHead(200).end('{}'); return; }
    if (url.pathname === '/api/commit') { commits++; res.writeHead(200).end('{}'); return; }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE); return; }
    res.writeHead(404).end();
  });
  server.postHits = () => posts;
  server.commitHits = () => commits;
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}
