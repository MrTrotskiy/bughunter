#!/usr/bin/env node
// hunt-cleanup — the DELETE half of the WRITE-HUNT CRUD self-test loop. A hunt crawl CREATES marked own
// content (HUNT-<runId>) to exercise write endpoints; this removes it afterwards so a run leaves no litter
// on the test account. FAIL-CLOSED ownership: it ONLY deletes an item whose OWN card text carries the exact
// HUNT-<runId> marker (nested-item text stripped, exactly like hunt-gate.ownsTarget) — it never touches
// content this run did not create. The confirm-modal affirmative is OPERATOR-SUPPLIED (--confirm-text, like
// --prefill) — NOT a heuristic primary/danger picker (rawcaster styles "No" as the danger button, so a naive
// picker deletes the wrong thing; decisions.md 2026-07-18 "NODE-LOOP HUNT"). Authed via BUGHUNTER_STORAGE_STATE.
//
// Usage: BUGHUNTER_STORAGE_STATE=… node lib/recon/hunt-cleanup.mjs --url=<url> --run-id=<id> \
//          [--confirm-text=Yes] [--dry-run] [--max=20]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attach, gotoGated } from '../browser/session.mjs';
import { waitSettled } from '../browser/causal.mjs';
import { huntMarker, ITEM_BOUNDARY } from './hunt-gate.mjs';
import { makeEnvelope, envelopeError, exitCode } from '../core/envelope.mjs';

// Count marker occurrences in the OWN text of item cards (nested-item text removed — the ownsTarget scope),
// so a marked comment nested in someone else's post never counts as an ownable item. Reporting-only.
function ownMarkedCount(page, marker) {
  return page.evaluate(([m, sel]) => {
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      if (typeof el.textContent !== 'string' || !el.textContent.includes(m)) continue;
      let own = el.textContent;
      for (const nested of el.querySelectorAll(sel)) if (typeof nested.textContent === 'string') own = own.split(nested.textContent).join('');
      if (own.includes(m)) n++;
    }
    return n;
  }, [marker, ITEM_BOUNDARY]);
}

// Tag the FIRST not-yet-handled item card that OWNS the marker, plus its in-card delete affordance (a "…"/more
// dropdown trigger, else a named delete/remove control). Returns { tagged, hasTrigger, text } or { tagged:false }.
// `handled` is a WeakSet-in-page via a data attribute so a failed delete is skipped next iteration (no infinite loop).
function tagNextOwned(page, marker) {
  return page.evaluate(([m, sel]) => {
    const owns = (el) => {
      if (typeof el.textContent !== 'string' || !el.textContent.includes(m)) return false;
      let own = el.textContent;
      for (const nested of el.querySelectorAll(sel)) if (typeof nested.textContent === 'string') own = own.split(nested.textContent).join('');
      return own.includes(m);
    };
    for (const card of document.querySelectorAll(sel)) {
      if (card.hasAttribute('data-hunt-handled') || !owns(card)) continue;
      // Prefer a portal "…"/more dropdown trigger; else a direct delete/remove control in THIS card. The
      // trigger set is PRECISE (L3): a broad `[class*=more]` would match read-more/load-more/show-more and
      // open the wrong menu; keep the AntD trigger class, a dropMenu-scoped class, and the ARIA menu-trigger.
      const trig = card.querySelector('.ant-dropdown-trigger, [class*=dropMenu], [aria-haspopup="menu"], [aria-haspopup="true"]');
      let del = null;
      if (!trig) {
        del = [...card.querySelectorAll('button,[role=button],[role=menuitem],a')]
          .find((b) => /\b(delete|remove|trash)\b/i.test((b.getAttribute('aria-label') || b.textContent || '')));
      }
      const target = trig || del;
      if (!target) continue;                       // marked but no delete affordance found → skip (never blind-delete)
      target.setAttribute('data-hunt-target', '1');
      card.setAttribute('data-hunt-handled', '1'); // don't re-pick this card even if the delete fails
      target.scrollIntoView({ block: 'center' });
      return { tagged: true, viaTrigger: !!trig, text: (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) };
    }
    return { tagged: false };
  }, [marker, ITEM_BOUNDARY]);
}

async function deleteOne(page, viaTrigger, confirmText) {
  // M1: close any STALE dropdown first, so after the trigger click EXACTLY ONE dropdown is open — the one
  // belonging to the owned trigger. Then the page-global menuitem locator can only reach THAT dropdown; if
  // more than one is somehow open, refuse (fail-closed) rather than guess which row's Delete to click.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(150);
  // Real pointer click (AntD dropdowns/menuitems need it; an in-page .click() does not fire the handler).
  await page.click('[data-hunt-target="1"]', { timeout: 5000 });
  await waitSettled(page); await page.waitForTimeout(400);
  if (viaTrigger) {
    const open = await page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').count().catch(() => 0);
    if (open !== 1) throw envelopeError({ code: 'CLEANUP_AMBIGUOUS', message: `expected exactly one open dropdown after the owned trigger, found ${open} — refusing to guess the delete target` });
    const del = page.locator('.ant-dropdown:not(.ant-dropdown-hidden) [role=menuitem]', { hasText: /delete|remove/i }).first();
    await del.waitFor({ state: 'visible', timeout: 5000 });
    await del.click({ timeout: 5000 });
    await waitSettled(page); await page.waitForTimeout(500);
  }
  // Optional confirm modal: click the OPERATOR-SUPPLIED affirmative (exact match — never a primary/danger guess).
  // If confirmText is absent/mismatched the delete does NOT commit; the honest `remaining` re-count (not the
  // click count) is what the caller reports as `deleted`, so an unaffirmed delete never over-reports (L1).
  if (confirmText) {
    const yes = page.getByRole('button', { name: confirmText, exact: true }).first();
    if (await yes.count().catch(() => 0)) { await yes.click({ timeout: 4000 }).catch(() => {}); await waitSettled(page); await page.waitForTimeout(600); }
  }
  // Clear the tag so the next scan can tag a fresh target.
  await page.evaluate(() => document.querySelectorAll('[data-hunt-target]').forEach((e) => e.removeAttribute('data-hunt-target')));
}

export async function huntCleanup({ url, runId, confirmText, dryRun = false, max = 20 }) {
  const marker = huntMarker(runId);
  const { page, release } = await attach();
  const result = { marker, found: 0, attempted: 0, deleted: 0, failed: 0, remaining: 0, dryRun, items: [] };
  try {
    await gotoGated(page, url);
    await waitSettled(page); await page.waitForTimeout(1000);
    result.found = await ownMarkedCount(page, marker);
    for (let i = 0; i < max; i++) {
      const t = await tagNextOwned(page, marker);
      if (!t.tagged) break;
      result.items.push(t.text);
      if (dryRun) continue;                        // dry-run: tagged data-hunt-handled marks it seen; report only
      result.attempted++;
      try {
        await deleteOne(page, t.viaTrigger, confirmText);
      } catch (err) {
        result.failed++;
        process.stderr.write(JSON.stringify({ cleanupFailed: t.text, error: err?.message?.slice(0, 120) }) + '\n');
      }
    }
    // Re-navigate for an HONEST post-count (a deleted item is gone; data-hunt-handled tags are wiped by nav).
    if (!dryRun) { await gotoGated(page, url); await waitSettled(page); await page.waitForTimeout(1000); }
    result.remaining = await ownMarkedCount(page, marker);
    // `deleted` is the OBSERVED removal delta, not the click count (L1): an unaffirmed confirm / a blocked
    // delete leaves the marked item present, so it is never counted as deleted. dry-run deletes nothing.
    result.deleted = dryRun ? 0 : Math.max(0, result.found - result.remaining);
    return result;
  } finally {
    await release();
  }
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) { const m = a.match(/^--([^=]+)=?(.*)$/); if (m) out[m[1]] = m[2] === '' ? true : m[2]; }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args['run-id']) {
    process.stderr.write(JSON.stringify({ ok: false, error: { code: 'USAGE', message: 'usage: hunt-cleanup --url=<url> --run-id=<id> [--confirm-text=Yes] [--dry-run] [--max=20]' } }) + '\n');
    process.exit(64);
  }
  try {
    const res = await huntCleanup({
      url: args.url, runId: args['run-id'],
      confirmText: typeof args['confirm-text'] === 'string' ? args['confirm-text'] : undefined,
      dryRun: args['dry-run'] === true, max: args.max != null ? Number(args.max) : 20,
    });
    process.stdout.write(JSON.stringify({ ok: true, ...res }) + '\n');
    process.exit(0);
  } catch (err) {
    const env = err?.envelope || makeEnvelope({ code: 'INTERNAL', message: err?.message || 'unknown error', exit: 'VIOLATION' });
    process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
    process.exit(exitCode(env));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
