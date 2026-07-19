#!/usr/bin/env node
// Mint a bughunter session for the LOCAL hygge-crm stand — the same cookie its own e2e suite uses.
//
// WHY THIS EXISTS. The product authenticates with Google OAuth restricted to a corporate domain, which is
// unusable for a local crawl and would reach off the machine. The project already solved this for its own
// tests: `apps/e2e/src/setup/local-auth.ts` signs a JWT with the backend's own secret for a SEEDED user and
// sets it as the `access_token` cookie. The backend's JwtStrategy looks the user up by `payload.sub`, so the
// token must reference a real row — which is why the id is read from the database rather than invented.
//
// This is a REIMPLEMENTATION, not an import: it signs HS256 with node's crypto and reads the id through
// `docker exec psql`, so bughunter takes no dependency on the target's node_modules and the target tree is
// never touched. The output is a Playwright storageState, which `lib/browser/session.mjs contextOptions()`
// already loads from BUGHUNTER_STORAGE_STATE — so the crawler needs no new auth mechanism at all.
//
// SAFETY, mirroring the guards the project put on its own helper: refuses anything but a localhost target
// and refuses a database that is not the dedicated `_e2e` one. A crawl in explore-all mode genuinely
// creates, edits and deletes; pointing that at a dev database would be destructive.
//
// Usage: node scripts/hygge-session.mjs [--email=<seeded user>] [--out=state/hygge-storage-state.json]

import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const CRM = process.env.HYGGE_CRM_DIR || '/Users/anton/projects/personal/hygge-crm';
const DB = 'hr_crm_e2e';
const CONTAINER = 'hr-crm-postgres';
const ORIGIN = 'http://localhost:5274';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const email = arg('email', 'admin@acme-corp.example.com');
const out = arg('out', 'state/hygge-storage-state.json');

// The backend's own secret, read from the .env the stand runs with. Signing with anything else produces a
// token the backend will reject, which surfaces as a silently logged-out crawl — the failure mode the
// project's CLAUDE.md calls out as worse than failing loudly.
const env = readFileSync(path.join(CRM, 'apps/backend/.env'), 'utf8');
const secret = (env.match(/^JWT_SECRET=(.*)$/m) || [])[1]?.trim();
if (!secret || /your-super-secret/.test(secret)) {
  throw new Error('JWT_SECRET missing or still the placeholder in apps/backend/.env');
}
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(ORIGIN)) {
  throw new Error(`refusing to mint against a non-local origin: ${ORIGIN}`);
}
if (!/_e2e$/.test(DB)) {
  throw new Error(`refusing to mint against a database that is not the dedicated e2e one: ${DB}`);
}

// The user must EXIST and be active — the backend resolves `sub` to a row, so a made-up id authenticates
// as nobody and every page renders logged-out while the crawl reports success.
const sql = `SELECT u.id || '|' || u.email || '|' || r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = '${email.replace(/'/g, "''")}' AND u.is_active = true LIMIT 1`;
const row = execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-tAc', sql], { encoding: 'utf8' }).trim();
if (!row) throw new Error(`no active user '${email}' in ${DB} — seed it first`);
const [id, mail, role] = row.split('|');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
// 8h, matching the project's own E2E_JWT_TTL default: the product's 15m expiry would lapse mid-crawl and
// cascade auth failures through the back half of a long run, which reads as "the app broke" rather than
// "our token expired".
const payload = { sub: id, email: mail, role, iat: now, exp: now + 8 * 3600 };
const signingInput = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
const sig = createHmac('sha256', secret).update(signingInput).digest('base64url');
const token = `${signingInput}.${sig}`;

const state = {
  cookies: [{
    name: 'access_token', value: token, domain: 'localhost', path: '/',
    expires: payload.exp, httpOnly: true, secure: false, sameSite: 'Lax',
  }],
  origins: [],
};

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(state, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ok: true, out, user: { email: mail, role }, expiresInHours: 8 }));
