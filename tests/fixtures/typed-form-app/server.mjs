// Zero-dep fixture for TYPED FIELD ACTUATION (INC.6). Reproduces the live rawcaster failure that made six
// crawls create nothing: a create form whose REQUIRED fields are not text inputs.
//
// The shapes are antd's, because antd is what the live target uses and its shapes are what defeated
// `fill()`:
//   - Select     `.ant-select > .ant-select-selection-search > input[readonly]`. The value is chosen by
//                clicking the field (opening a PORTAL dropdown at <body>) and clicking an option. A
//                readonly input is unfillable, so form-fill used to skip it entirely.
//   - DatePicker `.ant-picker` with the same readonly-input shape; the value comes from clicking a cell.
//   - Checkbox   `input[type=checkbox]` — needs checked state, not a string.
//   - Text       an ordinary input, the ONE kind the old code could handle.
//
//   - #create "Create Event"  the submit. It POSTs /api/create ONLY when all four fields are set; otherwise
//                             it does what the live app did — refuses silently, firing NOTHING. That
//                             silence is the whole point: a crawl that cannot fill the form scores the
//                             button "covered" while the server never hears about it.
//   - createHits()            server-side ground truth that a create actually happened.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Typed form fixture</title></head>
<body>
  <main>
    <form id="event-form">
      <input id="title" name="title" type="text" placeholder="Meeting Title">

      <div class="ant-select" id="type-select">
        <span class="ant-select-selection-search"><input readonly autocomplete="off"></span>
        <span class="ant-select-selection-placeholder">Event Type</span>
      </div>

      <div class="ant-picker" id="date-picker">
        <div class="ant-picker-input"><input readonly placeholder="Date"></div>
      </div>

      <label><input id="agree" type="checkbox" name="agree"> I agree</label>

      <button id="create" type="button">Create Event</button>
    </form>
  </main>

  <div class="ant-select-dropdown ant-select-dropdown-hidden" id="type-dropdown">
    <div class="ant-select-item ant-select-item-option" data-value="public">Public</div>
    <div class="ant-select-item ant-select-item-option" data-value="private">Private</div>
  </div>

  <div class="ant-picker-dropdown ant-picker-dropdown-hidden" id="date-dropdown">
    <table><tbody><tr>
      <td class="ant-picker-cell ant-picker-cell-in-view" data-day="14">14</td>
      <td class="ant-picker-cell ant-picker-cell-in-view" data-day="15">15</td>
    </tr></tbody></table>
  </div>

  <script>
    var chosen = { type: '', date: '' };

    // Open the portal dropdown when the readonly input is clicked — antd's actual behaviour.
    document.querySelector('#type-select input').addEventListener('click', function () {
      document.getElementById('type-dropdown').classList.remove('ant-select-dropdown-hidden');
    });
    document.querySelectorAll('#type-dropdown .ant-select-item-option').forEach(function (opt) {
      opt.addEventListener('click', function () {
        chosen.type = opt.getAttribute('data-value');
        var sel = document.getElementById('type-select');
        var tag = document.createElement('span');
        tag.className = 'ant-select-selection-item';
        tag.textContent = opt.textContent;
        sel.appendChild(tag);
        document.getElementById('type-dropdown').classList.add('ant-select-dropdown-hidden');
      });
    });

    document.querySelector('#date-picker input').addEventListener('click', function () {
      document.getElementById('date-dropdown').classList.remove('ant-picker-dropdown-hidden');
    });
    document.querySelectorAll('#date-dropdown .ant-picker-cell-in-view').forEach(function (cell) {
      cell.addEventListener('click', function () {
        chosen.date = cell.getAttribute('data-day');
        document.querySelector('#date-picker input').value = '2026-07-' + chosen.date;
        document.getElementById('date-dropdown').classList.add('ant-picker-dropdown-hidden');
      });
    });

    // The silent-refusal submit. Every required field must be set, exactly like the live target.
    document.getElementById('create').addEventListener('click', function () {
      var title = document.getElementById('title').value.trim();
      var agreed = document.getElementById('agree').checked;
      if (!title || !chosen.type || !chosen.date || !agreed) return;   // fires NOTHING — the measured bug
      fetch('/api/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title, type: chosen.type, date: chosen.date }),
      }).catch(function () {});
    });
  </script>
</body></html>`;

export async function start(port = 0) {
  let creates = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/create' && req.method === 'POST') {
      creates++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    res.writeHead(404).end();
  });
  server.createHits = () => creates;
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}
