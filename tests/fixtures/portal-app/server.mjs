// Zero-dep fixture for the PORTAL-DROPDOWN ownership fix (live target finding): a row's Edit/Delete lives
// in a dropdown rendered as a PORTAL appended to <body>, structurally DETACHED from the post card — so
// ownsTarget on the delete button finds no marker in its DOM ancestors and fails closed. The fix keys the
// portal control's ownership on its reveal-TRIGGER (the row's "…" more button, which IS inside the card).
//
// Two cards: self-1 (text CONTAINS the {marker} — our post) + other-1 (no marker). Each has a `.more`
// trigger inside its <article>. A single portal `#portal-menu` (a direct child of <body>, NOT inside any
// card) holds the Delete button — exactly the detached-portal shape ownsTarget alone cannot attribute.

import http from 'node:http';

export function start(port = 0, { marker = '' } = {}) {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Portal fixture</title></head>
<body>
  <div id="feed">
    <article data-id="self-1"><p class="body">My own hunt post ${marker}</p><button class="more" type="button">More</button></article>
    <article data-id="other-1"><p class="body">A post by someone else</p><button class="more" type="button">More</button></article>
  </div>
  <div id="portal-menu"><button class="pdel" type="button">Delete</button></div>
</body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
