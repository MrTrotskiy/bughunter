// Zero-dep fixture for the STATE-vs-DECLARATION split: a field that is DISABLED until a precondition is
// met, which is the shape the crawler kept recording as a permanent property.
//
// The real cases this models (measured on runs raw3/hunt1): a wizard field disabled until the previous
// step completes, a Save disabled until the form is dirty, a Next disabled until a selection is made.
// `#agree` is the precondition; ticking it enables `#groupName` — nothing else about the field changes,
// so a snapshot before and after differs in `disabled` alone.
//
// `#groupName` also carries a real DECLARATION (`maxlength=50`) present in BOTH states, so one page
// exercises both sides of the merge: the state must be re-read, the declaration must not churn.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Disabled fixture</title></head>
<body>
  <h1>Create group</h1>
  <form id="f">
    <label for="groupName">Group Name</label>
    <input id="groupName" name="groupName" type="text" maxlength="50" placeholder="Group Name" disabled>
    <label for="agree"><input id="agree" type="checkbox"> I accept the terms</label>
    <button id="save" type="button">Save</button>
  </form>
  <script>
    // The precondition: the field is operable only once the box is ticked.
    document.getElementById('agree').addEventListener('change', function (e) {
      document.getElementById('groupName').disabled = !e.target.checked;
    });
  </script>
</body></html>`;

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
