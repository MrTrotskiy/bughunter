// Zero-dep fixture for the WRITE-HUNT QA mode (safe mutation testing on OWN, HUNT-marked content).
// A tiny social feed with SERVER-SIDE ownership enforcement as the ground truth: a post owned by "self"
// (our test account) can be edited/deleted; the SEEDED "other"-owned post 403s server-side on PUT/DELETE.
// The client RENDERS each post's text (including the HUNT-<runId> marker on OUR post) into the card, so
// hunt-gate.ownsTarget's DOM marker read has a real target; the "other" post carries NO marker. The two
// cards render ADJACENT, so a test proves ownsTarget's item-boundary does not leak ownership from the
// marked card to the unmarked one.
//
// start(port, { marker }) seeds `self-1` (owner self, text CONTAINS the marker — as if THIS run created it)
// next to `other-1` (owner other, NO marker). Action buttons carry NO own data-id: each button's onclick
// and its instanceKey derive from the nearest `<article data-id>`, so `self-1`'s Delete and `other-1`'s
// Delete are distinct addressable instances of ONE template — exactly how a real feed's row controls look.
//
// Hit counters (the FAIL-ON-REVERT levers): createHits, editHits, deleteHits{id}, commentHits, likeHits,
// forbiddenHits (server-side 403s — 0 when the CLIENT gate refuses BEFORE the server has to).

import http from 'node:http';

function pageHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hunt social fixture</title></head>
<body>
  <h1>Feed</h1>
  <section id="composer">
    <textarea id="new-post" aria-label="New post"></textarea>
    <button id="post-submit" type="button">Post</button>
    <button id="delete-account" type="button">Delete account</button>
    <button id="logout" type="button">Logout</button>
  </section>
  <div id="feed"></div>
  <script>
    function api(method, url, body) {
      return fetch(url, { method: method, headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined }).then(function (r) { return r.json().catch(function () { return {}; }); });
    }
    function idOf(btn) { var a = btn.closest('article'); return a ? a.getAttribute('data-id') : ''; }
    function render(posts) {
      var feed = document.getElementById('feed');
      feed.innerHTML = posts.map(function (p) {
        return '<article data-id="' + p.id + '">'
          + '<p class="body">' + p.text + '</p>'
          + '<span class="likes">' + p.likes + ' likes</span>'
          + '<button class="edit" type="button">Edit</button>'
          + '<button class="del" type="button">Delete</button>'
          + '<button class="idel" type="button"></button>'  // ICON-only delete: NO accessible name (H1)
          + '<button class="rpcdel" type="button"></button>' // NAMELESS delete via a BENIGN method+path (POST /api/rpc) — slips the name gate AND the firewall method/path gate (security H1, node-loop)
          + '<button class="like" type="button">Like</button>'
          + '<button class="comment" type="button">Comment</button>'
          + '</article>';
      }).join('');
      feed.querySelectorAll('.edit').forEach(function (b) { b.onclick = function () {
        api('PUT', '/api/posts/' + idOf(b), { text: 'edited content' }).then(load); }; });
      feed.querySelectorAll('.del').forEach(function (b) { b.onclick = function () {
        api('DELETE', '/api/posts/' + idOf(b)).then(load); }; });
      feed.querySelectorAll('.idel').forEach(function (b) { b.onclick = function () {  // icon delete → same DELETE
        api('DELETE', '/api/posts/' + idOf(b)).then(load); }; });
      feed.querySelectorAll('.rpcdel').forEach(function (b) { b.onclick = function () {  // BENIGN-path RPC delete
        api('POST', '/api/rpc', { action: 'delete', id: idOf(b) }).then(load); }; });
      feed.querySelectorAll('.like').forEach(function (b) { b.onclick = function () {
        api('POST', '/api/posts/' + idOf(b) + '/like').then(load); }; });
      feed.querySelectorAll('.comment').forEach(function (b) { b.onclick = function () {
        api('POST', '/api/posts/' + idOf(b) + '/comments', { text: 'nice' }).then(load); }; });
    }
    function load() { return api('GET', '/api/feed').then(function (d) { render(d.posts || []); }); }
    document.getElementById('post-submit').onclick = function () {
      api('POST', '/api/posts', { text: document.getElementById('new-post').value || '' }).then(function () {
        document.getElementById('new-post').value = ''; load(); });
    };
    document.getElementById('delete-account').onclick = function () { api('DELETE', '/api/account'); };
    document.getElementById('logout').onclick = function () { api('POST', '/api/logout'); };
    load();
  </script>
</body></html>`;
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

export function start(port = 0, { marker = '', otherFirst = false } = {}) {
  let seq = 0;
  // self-1: OUR post — text CONTAINS the marker (as if this run created it) → ownsTarget proves ownership.
  // other-1: another user's post — NO marker → ownsTarget fails → edit/delete refused (the safety rail).
  // otherFirst renders other-1 FIRST so it is the node-loop's DRILL_PER_LIST representative row — the case
  // where the judge-free loop acts on ANOTHER user's controls, which is exactly what the ownership rail must
  // survive (a same-order feed would let self-1 be the representative and never exercise the rail).
  const self = { id: 'self-1', owner: 'self', text: `My own hunt post ${marker}`.trim(), likes: 0 };
  const other = { id: 'other-1', owner: 'other', text: 'A post by someone else', likes: 0 };
  const posts = otherFirst ? [other, self] : [self, other];
  const counters = { createHits: 0, editHits: 0, deleteHits: {}, rpcDeleteHits: {}, commentHits: 0, likeHits: 0, forbiddenHits: 0, accountDeleted: 0, loggedOut: 0 };
  const findById = (id) => posts.find((p) => p.id === id);

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const parts = u.pathname.split('/').filter(Boolean); // ['api','posts',':id',...]

    if (u.pathname === '/' || u.pathname === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageHtml());
    }
    if (u.pathname === '/api/feed' && req.method === 'GET') return json(res, 200, { posts });
    if (u.pathname === '/api/account' && req.method === 'DELETE') { counters.accountDeleted++; return json(res, 200, { ok: true }); }
    if (u.pathname === '/api/logout' && req.method === 'POST') { counters.loggedOut++; return json(res, 200, { ok: true }); }
    if (u.pathname === '/api/rpc' && req.method === 'POST') {           // BENIGN method+path — the H1 shape
      const body = await readBody(req);
      if (body.action === 'delete') {
        const post = findById(body.id);
        if (!post) return json(res, 404, { error: 'not found' });
        if (post.owner !== 'self') { counters.forbiddenHits++; return json(res, 403, { error: 'not owner' }); }
        posts.splice(posts.indexOf(post), 1);
        counters.rpcDeleteHits[body.id] = (counters.rpcDeleteHits[body.id] || 0) + 1;
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/posts' && req.method === 'POST') {         // CREATE — always owned by self
      const body = await readBody(req);
      const id = 'self-new-' + (++seq);
      posts.push({ id, owner: 'self', text: String(body.text || ''), likes: 0 });
      counters.createHits++;
      return json(res, 201, { id });
    }
    if (parts[0] === 'api' && parts[1] === 'posts' && parts[2]) {
      const id = parts[2];
      const post = findById(id);
      if (!post) return json(res, 404, { error: 'not found' });
      if (parts[3] === 'like' && req.method === 'POST') { post.likes++; counters.likeHits++; return json(res, 200, { likes: post.likes }); }
      if (parts[3] === 'comments' && req.method === 'POST') { await readBody(req); counters.commentHits++; return json(res, 201, { ok: true }); }
      if (req.method === 'PUT') {                                       // EDIT — self only (ground truth)
        if (post.owner !== 'self') { counters.forbiddenHits++; return json(res, 403, { error: 'not owner' }); }
        const body = await readBody(req); post.text = String(body.text || post.text); counters.editHits++; return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {                                    // DELETE — self only (ground truth)
        if (post.owner !== 'self') { counters.forbiddenHits++; return json(res, 403, { error: 'not owner' }); }
        posts.splice(posts.indexOf(post), 1);
        counters.deleteHits[id] = (counters.deleteHits[id] || 0) + 1; return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.counters = () => counters;
    server.posts = () => posts;
    resolve(server);
  }));
}
