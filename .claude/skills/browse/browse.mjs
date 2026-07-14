#!/usr/bin/env node
// Single-file browse skill. Two modes:
//   1) One-shot:    node browse.mjs --url=<URL> --mode=<text|aria|a11y|html|screenshot|api> [--wait=<sel>] [--timeout=<ms>] [--viewport=WxH] [--full]
//   2) CLI action:  node browse.mjs <action> [args...]   (e.g. open URL, snapshot, click <ref>, fill <ref> <text>, close)
// Artifacts land in /tmp/browse/. One-shot stdout = JSON envelope {ok, payload?, error?} — read artifact via Read if needed.
// Exit codes: 0 ok | 1 runtime error | 2 usage error | 3 env (playwright missing).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync,
  readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isPublicHttpUrl } from '../../../lib/browser/host-policy.mjs';
import { redactSecrets } from '../../../lib/bug/bug-add.mjs';

const OUT_DIR = '/tmp/browse';
const SESSION_FILE = `${OUT_DIR}/session.json`;
const SESSION_TTL_MS = 10 * 60 * 1000;
const LARGE_OUTPUT = 200_000;
const API_COMPACT_THRESHOLD = 10;
const CLI_INLINE_THRESHOLD = 4000;

// Whitelist of @playwright/cli actions accepted by browse. Mirrors `pw.mjs`
// to keep the two skills compatible; anything else (especially `--`-prefixed
// flags) is rejected to prevent argument injection via LLM-extracted URLs
// like `<a href="--remote-debugging-port=9222">`.
const CLI_ACTIONS = new Set([
  'open', 'attach', 'close', 'goto', 'type', 'click', 'dblclick', 'fill',
  'drag', 'hover', 'select', 'upload', 'check', 'uncheck', 'snapshot',
  'eval', 'dialog-accept', 'dialog-dismiss', 'resize', 'delete-data',
  'go-back', 'go-forward', 'reload', 'press', 'keydown', 'keyup',
  'mousemove', 'mousedown', 'mouseup', 'mousewheel',
  // 'network' removed 2026-05-21 — `@playwright/cli` does not implement a
  // `network` command, so the whitelist's accepting it was a silent lie
  // (passthrough returned CLI_ERROR with no fix hint). For per-action
  // network observability use `lib/trajectory-probe.mjs` (long-running
  // Node process with persistent page.on('request') listeners) instead.
  'screenshot', 'pdf', 'console',
  'tab-list', 'tab-new', 'tab-select', 'tab-close',
  'state-save', 'state-load',
  'tracing-start', 'tracing-stop', 'video-start', 'video-stop', 'video-chapter',
]);

mkdirSync(OUT_DIR, { recursive: true });

const argv = process.argv.slice(2);
if (argv.length === 0) {
  emitError({
    code: 'USAGE',
    message: 'no arguments provided',
    fix: [
      'one-shot: browse.mjs --url=<URL> --mode=<text|aria|a11y|html|screenshot|api>',
      'CLI:     browse.mjs <action> [args...]   (see: npx -y @playwright/cli@latest --help)',
    ],
  });
  process.exit(2);
}

const ONE_SHOT_FLAGS = ['--mode', '--wait', '--timeout', '--viewport', '--full'];
const hasOneShotFlag = argv.some((a) => ONE_SHOT_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
const hasUrl = argv.some((a) => a.startsWith('--url='));

if (hasOneShotFlag && !hasUrl) {
  emitError({
    code: 'USAGE',
    message: 'one-shot flag provided without --url',
    fix: ['add --url=<URL>', 'or drop one-shot flags to use CLI mode'],
  });
  process.exit(2);
}

if (hasUrl) await runOneShot(argv);
else runCli(argv);

function emitError({ code, message, where, fix }) {
  // Redact the (potentially externally-sourced) message field before
  // emission so cookie / Authorization / JWT shapes from page errors do
  // not leak into the transcript. Code / where / fix[] are always our own
  // static text, no redaction needed.
  const error = { code, message: redactSecrets(String(message ?? '')) };
  if (where) error.where = where;
  if (fix) error.fix = fix;
  console.log(JSON.stringify({ ok: false, error }, null, 2));
}

// ---------------------------------------------------------------------------
// CLI backend: thin wrapper around @playwright/cli with persistent session +
// auto-close after SESSION_TTL_MS of inactivity.
// Captures CLI stdout (with --json) and re-emits as our envelope so main + CLI
// modes share one contract. Large payloads (snapshots, dumps) land on disk.
// ---------------------------------------------------------------------------
function runCli(args) {
  const session = process.env.PW_SESSION || 'default';
  const action = args[0];

  if (!CLI_ACTIONS.has(action)) {
    emitError({
      code: 'USAGE',
      message: `unknown action "${action}"`,
      fix: [`allowed: ${[...CLI_ACTIONS].join(', ')}`],
    });
    process.exit(2);
  }
  for (const a of args.slice(1)) {
    if (typeof a === 'string' && a.startsWith('--')) {
      emitError({
        code: 'USAGE',
        message: `flag-like positional argument "${a}" is not allowed`,
        fix: ['pass values as bare positionals, not `--flag=value`'],
      });
      process.exit(2);
    }
  }
  if ((action === 'open' || action === 'goto') && args[1] && !process.env.PW_ALLOW_PRIVATE) {
    if (!isPublicHttpUrl(args[1])) {
      emitError({
        code: 'PRIVATE_HOST_REFUSED',
        message: `URL "${args[1]}" is not a public http(s) address`,
        fix: ['set PW_ALLOW_PRIVATE=1 if the operator authorised the target'],
      });
      process.exit(2);
    }
  }

  reapStaleDaemons();

  if (action === 'close') {
    if (existsSync(SESSION_FILE)) try { unlinkSync(SESSION_FILE); } catch {}
  } else {
    if (existsSync(SESSION_FILE)) {
      try {
        const { lastUsed } = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
        if (Date.now() - lastUsed > SESSION_TTL_MS) {
          spawnSync('npx', ['-y', '@playwright/cli@latest', `-s=${session}`, 'close'],
            { cwd: OUT_DIR, stdio: 'ignore' });
        }
      } catch {}
    }
    writeFileSync(SESSION_FILE, JSON.stringify({ lastUsed: Date.now(), session }));
  }

  const cliArgs = ['-y', '@playwright/cli@latest', `-s=${session}`, '--json', ...args];
  const result = spawnSync('npx', cliArgs, { cwd: OUT_DIR, encoding: 'utf8' });
  // Redact cookie / Authorization / JWT / API-key shapes from CLI output
  // BEFORE parsing — `@playwright/cli` echoes set-cookie / auth headers from
  // live pages and those would otherwise land verbatim in the agent
  // transcript or on disk (cli-snapshot.yml, cli-out.json). Same guard
  // `pw.mjs` adopted Phase 3 M3 (2026-04-23).
  const stdout = redactSecrets((result.stdout ?? '').trim());
  const stderr = redactSecrets((result.stderr ?? '').trim());

  const cliResult = tryParseJson(stdout);

  if (cliResult && cliResult.isError) {
    emitError({
      code: 'CLI_ERROR',
      message: cliResult.error || 'unknown CLI error',
      where: `cli:${action}`,
      fix: classifyCliFix(cliResult.error),
    });
    process.exit(1);
  }

  if (cliResult) {
    const env = { ok: true, mode: 'cli', action };

    if (typeof cliResult.snapshot === 'string') {
      const outPath = `${OUT_DIR}/cli-snapshot.yml`;
      writeFileSync(outPath, cliResult.snapshot);
      env.outPath = outPath;
      env.size = cliResult.snapshot.length;
    } else if (cliResult.result?.snapshot?.file) {
      const filePath = resolve(OUT_DIR, cliResult.result.snapshot.file);
      env.outPath = filePath;
      try { env.size = statSync(filePath).size; } catch {}
      env.payload = cliResult.result;
    } else {
      const payloadJson = JSON.stringify(cliResult, null, 2);
      if (payloadJson.length > CLI_INLINE_THRESHOLD) {
        const outPath = `${OUT_DIR}/cli-out.json`;
        writeFileSync(outPath, payloadJson);
        env.outPath = outPath;
        env.size = payloadJson.length;
      } else {
        env.payload = cliResult;
      }
    }

    if (env.size && env.size > LARGE_OUTPUT) {
      env.warning = `output is ${Math.round(env.size / 1024)}KB — use Read with offset/limit`;
    }

    console.log(JSON.stringify(env, null, 2));
    process.exit(0);
  }

  // Non-JSON output: human-text actions (close, help) or CLI runtime fault.
  if (result.status === 0) {
    const env = { ok: true, mode: 'cli', action };
    if (stdout) env.raw = stdout;
    console.log(JSON.stringify(env, null, 2));
    process.exit(0);
  }

  emitError({
    code: 'CLI_RUNTIME',
    message: stderr || stdout || `@playwright/cli exited ${result.status}`,
    where: `cli:${action}`,
    fix: [
      'rerun raw to inspect (redact secrets before sharing): @playwright/cli with --json',
      'if the session is stuck, run: browse.mjs close',
    ],
  });
  process.exit(result.status ?? 1);
}

function tryParseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function classifyCliFix(errMsg) {
  if (!errMsg) return [];
  if (/does not match any elements/i.test(errMsg)) {
    return [
      'rerun `snapshot` to refresh refs — refs are invalidated by re-navigation or DOM mutation',
      'verify the ref still exists in current ARIA tree',
    ];
  }
  if (/no browser|not running|no session|no page/i.test(errMsg)) {
    return ['run: browse.mjs open <url>', 'sessions auto-close after 10min idle'];
  }
  if (/timeout/i.test(errMsg)) {
    return ['raise timeout via action-specific flag', 'check element visibility / network state'];
  }
  return [];
}

// ---------------------------------------------------------------------------
// One-shot backend: direct Playwright API. Writes one artifact per call.
// Stdout = compact JSON metadata only (no content) to stay token-cheap.
// ---------------------------------------------------------------------------
async function runOneShot(argv) {
  const opts = Object.fromEntries(argv.map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }));

  const url = opts.url;
  const mode = opts.mode || 'text';
  const waitSel = opts.wait;
  const timeout = Number(opts.timeout || 30000);
  const viewport = parseViewport(opts.viewport);
  const fullApiLog = Boolean(opts.full);

  if (!url) {
    emitError({ code: 'USAGE', message: 'missing --url', fix: ['pass --url=<URL>'] });
    process.exit(2);
  }

  if (!process.env.PW_ALLOW_PRIVATE && !isPublicHttpUrl(url)) {
    emitError({
      code: 'PRIVATE_HOST_REFUSED',
      message: `--url "${url}" is not a public http(s) address`,
      fix: ['set PW_ALLOW_PRIVATE=1 if the operator authorised the target'],
    });
    process.exit(2);
  }

  let chromium;
  try {
    chromium = await loadChromium();
  } catch (err) {
    emitError({
      code: 'PLAYWRIGHT_NOT_FOUND',
      message: String(err?.message ?? err),
      where: 'loadChromium',
      fix: ['npm install playwright', 'or: npm install @playwright/test'],
    });
    process.exit(3);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
  const page = await ctx.newPage();

  const apiLog = [];
  if (mode === 'api') {
    page.on('response', (r) => apiLog.push({
      status: r.status(),
      type: r.headers()['content-type'] || '',
      url: r.url(),
    }));
  }

  try {
    let where = 'page.goto';
    const resp = await page.goto(url, { timeout, waitUntil: 'domcontentloaded' });
    if (!process.env.PW_ALLOW_PRIVATE && !isPublicHttpUrl(page.url())) {
      throw new Error(`redirected to non-public URL ${page.url()}`);
    }
    if (waitSel) {
      where = 'page.waitForSelector';
      await page.waitForSelector(waitSel, { timeout });
    }
    where = `capture(${mode})`;

    const title = await page.title();
    const finalUrl = page.url();
    const httpStatus = resp?.status() ?? 'n/a';

    const cap = await capture(page, mode, apiLog, { fullApiLog });

    const result = {
      ok: true,
      outPath: cap.outPath,
      title,
      finalUrl,
      httpStatus,
      size: cap.size,
      mode,
    };
    if (cap.fullPath) result.fullPath = cap.fullPath;
    if (cap.truncated) result.truncated = true;
    if (cap.size && cap.size > LARGE_OUTPUT) {
      result.warning = `output is ${Math.round(cap.size / 1024)}KB — use Read with offset/limit`;
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    emitError(classifyOneShotError(err, { mode, url, waitSel }));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

function classifyOneShotError(err, { mode, url, waitSel }) {
  const message = String(err?.message ?? err);
  const name = err?.name ?? '';
  const isTimeout = name === 'TimeoutError' || /Timeout .* exceeded/i.test(message);

  if (isTimeout && waitSel) {
    return {
      code: 'SELECTOR_NOT_FOUND',
      message,
      where: 'page.waitForSelector',
      fix: [
        `selector "${waitSel}" did not appear in time`,
        'inspect actual DOM: rerun with --mode=html or --mode=aria (drop --wait)',
        'raise --timeout=<ms> if the page is slow',
      ],
    };
  }
  if (isTimeout) {
    return {
      code: 'TIMEOUT',
      message,
      where: 'page.goto',
      fix: [
        'raise --timeout=<ms> (default 30000)',
        'for SPA: add --wait=<selector> matching post-hydration content',
        'verify URL is reachable from this host',
      ],
    };
  }
  if (/ERR_NAME_NOT_RESOLVED|getaddrinfo/.test(message)) {
    return {
      code: 'DNS_FAILED',
      message,
      where: 'page.goto',
      fix: ['check spelling of host', 'check VPN / network reachability'],
    };
  }
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_UNSAFE_PORT/.test(message)) {
    return {
      code: 'CONN_REFUSED',
      message,
      where: 'page.goto',
      fix: ['service not listening on that port', 'confirm port / scheme in URL', 'ports 0-1023 may be blocked as unsafe'],
    };
  }
  if (/Invalid URL|ERR_INVALID_URL|Cannot navigate to invalid URL/.test(message)) {
    return {
      code: 'BAD_URL',
      message,
      where: 'page.goto',
      fix: ['URL must include scheme (https://…)', `received: ${url}`],
    };
  }
  return {
    code: 'RUNTIME',
    message,
    where: `mode=${mode}`,
    fix: ['rerun with a simpler --mode=text to isolate', 'check stderr for stack trace'],
  };
}

async function capture(page, mode, apiLog, { fullApiLog = false } = {}) {
  if (mode === 'screenshot') {
    const outPath = `${OUT_DIR}/out.png`;
    await page.screenshot({ path: outPath, fullPage: true, animations: 'disabled', caret: 'hide' });
    return { outPath };
  }
  if (mode === 'html') {
    const outPath = `${OUT_DIR}/out.html`;
    const html = await page.content();
    writeFileSync(outPath, html);
    return { outPath, size: html.length };
  }
  if (mode === 'a11y') {
    const outPath = `${OUT_DIR}/out.json`;
    const client = await page.context().newCDPSession(page);
    await client.send('Accessibility.enable');
    const { nodes } = await client.send('Accessibility.getFullAXTree');
    await client.detach();
    const json = JSON.stringify(nodes, null, 2);
    writeFileSync(outPath, json);
    return { outPath, size: json.length };
  }
  if (mode === 'aria') {
    const outPath = `${OUT_DIR}/out.yml`;
    // Prefer snapshotForAI (compact, LLM-optimized). Fallback to ariaSnapshot.
    let snap;
    if (typeof page.snapshotForAI === 'function') {
      try { snap = await page.snapshotForAI(); } catch {}
    }
    if (!snap) snap = await page.locator('body').ariaSnapshot();
    writeFileSync(outPath, snap);
    return { outPath, size: snap.length };
  }
  if (mode === 'api') {
    const outPath = `${OUT_DIR}/out.json`;
    const truncate = apiLog.length > API_COMPACT_THRESHOLD && !fullApiLog;
    const payload = truncate ? compactApiLog(apiLog) : apiLog;
    const json = JSON.stringify(payload, null, 2);
    writeFileSync(outPath, json);
    const result = { outPath, size: json.length };
    if (truncate) {
      const fullPath = `${OUT_DIR}/out.full.json`;
      writeFileSync(fullPath, JSON.stringify(apiLog, null, 2));
      result.fullPath = fullPath;
      result.truncated = true;
    }
    return result;
  }
  const outPath = `${OUT_DIR}/out.txt`;
  const text = await page.locator('body').innerText().catch(() => '');
  writeFileSync(outPath, text);
  return { outPath, size: text.length };
}

function compactApiLog(log) {
  const byStatus = {};
  const byType = {};
  for (const r of log) {
    const s = String(r.status);
    byStatus[s] = (byStatus[s] || 0) + 1;
    const t = (r.type || 'unknown').split(';')[0].trim() || 'unknown';
    byType[t] = (byType[t] || 0) + 1;
  }
  const errors = log.filter((r) => r.status >= 400);
  return {
    _count: log.length,
    _byStatus: byStatus,
    _byType: byType,
    _errors: errors.slice(0, 20),
    _first10: log.slice(0, 10),
    _last10: log.slice(-10),
    _truncated: true,
    _hint: 'Full log written alongside as out.full.json. Rerun with --full to inline.',
  };
}

function parseViewport(s) {
  if (!s || s === true) return { width: 1440, height: 900 };
  const m = String(s).match(/^(\d+)x(\d+)$/i);
  return m ? { width: +m[1], height: +m[2] } : { width: 1440, height: 900 };
}

async function loadChromium() {
  const require = createRequire(import.meta.url);
  const roots = [process.cwd(), dirname(new URL(import.meta.url).pathname)];
  for (let d = process.cwd(); d !== '/'; d = dirname(d)) roots.push(d);
  try {
    for (const sub of ['pods', 'apps', 'packages']) {
      const base = resolve(process.cwd(), sub);
      if (!existsSync(base)) continue;
      for (const name of readdirSync(base)) {
        const p = resolve(base, name);
        if (statSync(p).isDirectory()) roots.push(p);
      }
    }
  } catch {}
  for (const pkg of ['playwright', '@playwright/test']) {
    for (const root of roots) {
      try {
        const resolved = require.resolve(pkg, { paths: [root] });
        const mod = await import(pathToFileURL(resolved).href);
        const chromium = mod.chromium ?? mod.default?.chromium;
        if (chromium) return chromium;
      } catch {}
    }
  }
  throw new Error('playwright not found — install `playwright` or `@playwright/test` in the project');
}

// Kill orphaned @playwright/cli daemons (>30min old) when no fresh session
// exists. Safety net for crashed Claude sessions that never called `close`.
function reapStaleDaemons() {
  try {
    if (existsSync(SESSION_FILE)) {
      const { lastUsed } = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
      if (Date.now() - lastUsed < SESSION_TTL_MS) return;
    }
    const { stdout } = spawnSync('pgrep', ['-f', 'playwright-core/lib/entry/cliDaemon'], { encoding: 'utf8' });
    if (!stdout) return;
    for (const pid of stdout.trim().split('\n').filter(Boolean)) {
      const ps = spawnSync('ps', ['-p', pid, '-o', 'etimes='], { encoding: 'utf8' });
      const etimes = parseInt(ps.stdout?.trim(), 10);
      if (Number.isFinite(etimes) && etimes > 1800) {
        spawnSync('kill', ['-9', pid], { stdio: 'ignore' });
      }
    }
    spawnSync('pkill', ['-f', 'ms-playwright/ffmpeg'], { stdio: 'ignore' });
  } catch {}
}
