// Zero-dep fixture reproducing Ant Design's REQUIRED-FIELD MARKUP, the exact shape that made
// `fieldFacts.required` read 0/70 on the live target.
//
// AntD does NOT put `required` on the <input>. A `<Form.Item rules={[{ required: true }]}>` renders the
// requiredness as a CLASS on the field's <label> — `ant-form-item-required` — inside `.ant-form-item-label`,
// with NO native attribute on the control at all. The `.ant-form-item` CONTAINER never carries that class.
// So a reader that checks `el.required` or `container.classList.contains('ant-form-item-required')` reports
// false on a genuinely required field. This fixture holds three shapes so one page exercises every path:
//
//   #antd-name   REQUIRED VIA THE ANTD WRAPPER — label.ant-form-item-required, no native attribute. This is
//                the live-target case and the one that was silently reading false.
//   #native-mail NATIVE required attribute (a plain HTML form), maxlength 120 — guards the el.required path.
//   #optional    NOT required — its label has NO required class — guards against a false positive.
//   #antd-bio    an AntD required TEXTAREA with maxlength 200 and a disabled state — carries maxLength/label
//                through the same projection alongside the wrapper-required read.
//
// The markup mirrors the real AntD DOM (ant-row / ant-form-item-label / ant-form-item-control-input) so the
// `el.closest('.ant-form-item')` ascent and the label lookup resolve exactly as they do on the live app.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>AntD form fixture</title></head>
<body>
  <form class="ant-form ant-form-vertical" id="event-form">

    <div class="ant-form-item">
      <div class="ant-row ant-form-item-row">
        <div class="ant-col ant-form-item-label">
          <label for="antd-name" class="ant-form-item-required" title="Full Name">Full Name</label>
        </div>
        <div class="ant-col ant-form-item-control">
          <div class="ant-form-item-control-input">
            <div class="ant-form-item-control-input-content">
              <input id="antd-name" class="ant-input" type="text" maxlength="50" placeholder="Full Name">
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="ant-form-item">
      <div class="ant-row ant-form-item-row">
        <div class="ant-col ant-form-item-label">
          <label for="native-mail" title="Email">Email</label>
        </div>
        <div class="ant-col ant-form-item-control">
          <div class="ant-form-item-control-input">
            <div class="ant-form-item-control-input-content">
              <input id="native-mail" class="ant-input" type="email" maxlength="120" placeholder="Email" required>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="ant-form-item">
      <div class="ant-row ant-form-item-row">
        <div class="ant-col ant-form-item-label">
          <label for="optional" title="Nickname">Nickname</label>
        </div>
        <div class="ant-col ant-form-item-control">
          <div class="ant-form-item-control-input">
            <div class="ant-form-item-control-input-content">
              <input id="optional" class="ant-input" type="text" placeholder="Nickname">
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="ant-form-item">
      <div class="ant-row ant-form-item-row">
        <div class="ant-col ant-form-item-label">
          <label for="antd-bio" class="ant-form-item-required" title="Bio">Bio</label>
        </div>
        <div class="ant-col ant-form-item-control">
          <div class="ant-form-item-control-input">
            <div class="ant-form-item-control-input-content">
              <textarea id="antd-bio" class="ant-input" maxlength="200" placeholder="Bio" disabled></textarea>
            </div>
          </div>
        </div>
      </div>
    </div>

    <button id="submit" class="ant-btn" type="button">Submit</button>
  </form>
</body></html>`;

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
