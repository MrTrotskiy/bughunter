// claims — THE CLAIM REGISTRY. The mechanical anti-lie gate that would have caught the viewer's
// false sentences before the operator did (ADMIN-TRUTH-PLAN.md, Stage 2). TEST-TIME ONLY: this
// module is imported by tests/unit/viewer-truth.test.mjs, never by admin.html, so it needs no
// admin-server allowlist branch and touches no security fence.
//
// Two code reviews passed a screen that asserted false things about our own crawler, because each
// defect was an inconsistency BETWEEN three individually-correct layers (writer wrote the field →
// projection dropped it → renderer printed its "field absent" branch) and nothing executed the
// three together against real data. This registry makes each operator-visible sentence a RECORD
// with two predicates so a node:test can execute them over a real trail:
//   { id, text, where,               // the Russian sentence + where it renders
//     on: 'step'|'row'|'run',        // which projection its licence reads
//     licensedBy: (view) => bool,    // the view-model condition under which the sentence is shown
//     contradictedBy: (event) => bool } // a trail event whose existence PROVES the sentence false
//
// The three checks the test runs over the golden trail:
//   Contradiction — no event may satisfy contradictedBy AND licensedBy(project(event)). Catches
//     the "lost field" class (a fixed projection carries the field, so licensedBy is false; a
//     reverted one drops it, so licensedBy fires on the event that carries the field → red).
//   Conditionality — a claim licensed on 100% of its views has no data behind it (the unconditional
//     class). Applies to step/row claims; a claim WITHOUT contradictedBy must also render at least
//     once (0% would mean it can never fire). Lost-field claims (with contradictedBy) are correct
//     at 0% now — that is the fix — so they are exempt from the render-at-least-once side.
//   Completeness — every operator sentence longer than WORD_FLOOR words must be a registered CLAIM
//     text or a LABEL (claims-labels.mjs). A NEW sentence declares its licence or the gate reds.

import { classify } from './failure-hints.mjs';
import { LABELS } from './claims-labels.mjs';

export { LABELS };

// Sentences with MORE than this many Cyrillic words must be registered. Short fragments split out
// of a template by an interpolation (`Недостижимых за весь прогон: ${un}`) fall under the floor and
// need no entry; the substantive sentences do.
export const WORD_FLOOR = 6;

// Collapse to the comparable form the LABELS/CLAIM texts are stored in: one-line, trimmed, lower.
export const normalize = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const countWords = (s) => String(s).split(/\s+/).filter((w) => /[А-Яа-яЁё]/.test(w)).length;

// A `/` in code position starts a REGEX literal (not division) after these tokens. Needed so the
// escape/quote chars inside `/[&<>"']/g` (which every view module's `esc` carries) do not corrupt
// string tracking and leak comment text into the scan.
const REGEX_PREV = new Set(['(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '~', '^', '<', '>', '\n', '']);

// Extract STRING-LITERAL bodies from JS source, skipping comments and regex literals. Template
// interpolations `${...}` re-enter code, so a template's static Russian text is captured while the
// expressions between are not. Comments are English here (project rule), so scanning literals only
// keeps a Russian phrase QUOTED in a comment (an old-lie string) out of the operator set.
export function stringLiterals(src) {
  const out = []; const n = src.length; let i = 0; let cur = ''; let last = '';
  const stack = [{ type: 'code', depth: 0 }];
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const m = top(); const c = src[i]; const d = src[i + 1];
    if (m.type === 'code') {
      if (c === '/' && d === '/') { i += 2; while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
      if (c === '/' && REGEX_PREV.has(last)) {          // regex literal — skip body (class-aware) + flags
        i++; let inClass = false;
        while (i < n) { const r = src[i]; if (r === '\\') { i += 2; continue; } if (r === '[') inClass = true; else if (r === ']') inClass = false; else if (r === '/' && !inClass) { i++; break; } else if (r === '\n') break; i++; }
        while (i < n && /[a-z]/i.test(src[i])) i++; last = '/'; continue;
      }
      if (c === "'") { stack.push({ type: 'sq' }); cur = ''; i++; continue; }
      if (c === '"') { stack.push({ type: 'dq' }); cur = ''; i++; continue; }
      if (c === '`') { stack.push({ type: 'tpl' }); cur = ''; i++; continue; }
      if (c === '{') { m.depth++; last = c; i++; continue; }
      if (c === '}') { if (m.depth === 0 && stack.length > 1) { stack.pop(); last = '}'; i++; continue; } m.depth--; last = '}'; i++; continue; }
      if (/\S/.test(c)) last = c;
      i++; continue;
    }
    if (m.type === 'sq' || m.type === 'dq') {
      if (c === '\\') { cur += src.slice(i, i + 2); i += 2; continue; }
      if ((m.type === 'sq' && c === "'") || (m.type === 'dq' && c === '"')) { out.push(cur); stack.pop(); last = c; i++; continue; }
      cur += c; i++; continue;
    }
    // template literal
    if (c === '\\') { cur += src.slice(i, i + 2); i += 2; continue; }
    if (c === '`') { out.push(cur); stack.pop(); last = '`'; i++; continue; }
    if (c === '$' && d === '{') { out.push(cur); cur = ''; stack.push({ type: 'code', depth: 0 }); last = '{'; i += 2; continue; }
    cur += c; i++;
  }
  return out;
}

// The operator sentences a source file can print: Cyrillic runs inside its string literals,
// one-line-normalized, with a word count. Same extraction the completeness check and this registry
// were built from, so a registered text matches its scanned run byte-for-byte.
const CYR = /[А-Яа-яЁё][А-Яа-яЁё0-9 \t.,:;!?%×…«»()\/+\-—’']*[А-Яа-яЁё.!?»)]/g;
export function scanSentences(src) {
  const out = [];
  for (const lit of stringLiterals(src)) {
    for (const run of (lit.match(CYR) || [])) {
      const text = run.replace(/\s+/g, ' ').trim();
      out.push({ text, words: countWords(text) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ view-model predicates */

const isFail = (s) => !!(s && s.error);
const hasAttempts = (s) => !!(s && s.target && Array.isArray(s.target.attempts) && s.target.attempts.length);
const revealHad = (s) => (s && s.target && typeof s.target.hadRevealPath === 'boolean') ? s.target.hadRevealPath : null;
// A step's failure tone from the ONE taxonomy (failure-hints); 'passed' for a successful act.
const toneOf = (s) => { if (!isFail(s)) return 'passed'; const c = classify(s); return c ? c.tone.key : null; };
const finiteStatuses = (p) => (Array.isArray(p && p.requests) ? p.requests : []).map((r) => Number(r && r.status)).filter(Number.isFinite);
export function instanceCount(graph) {
  let n = 0;
  for (const el of Object.values((graph && graph.elements) || {})) n += ((el && el.instances) || []).length;
  return n;
}

/* ------------------------------------------------------------------ the registry */

// The data-CLAIMS: operator sentences that assert something FALSIFIABLE about the run. Each carries
// the exact rendered text (so completeness matches it), the projection its licence reads, and the
// predicates. Pure UI labels / stub self-descriptions live in LABELS (claims-labels.mjs) instead.
export const CLAIMS = [
  // LOST-FIELD (class A). deriveSteps used to drop `target`, so the failure card printed this on 39
  // of 39 failures of fix1 while the payload carried a 6-record attempts list. Fixed → 0 firings.
  { id: 'attempts-not-recorded', where: 'walk-view.attemptsHtml', on: 'step',
    text: 'резолвер не оставил списка попыток: этот прогон писался до того, как он стал записываться',
    licensedBy: (s) => isFail(s) && !hasAttempts(s),
    contradictedBy: (ev) => hasAttempts(ev && ev.payload) },

  // The reveal-path note — the sibling field the walk once dropped, contradicting the pipeline about
  // the same act. Both branches are conditional on the payload's own hadRevealPath flag.
  { id: 'reveal-recorded', where: 'walk-view.failurePanel', on: 'step',
    text: 'путь к контролу был записан — до него надо было раскрывать',
    licensedBy: (s) => revealHad(s) === true },
  { id: 'reveal-not-recorded', where: 'walk-view.failurePanel', on: 'step',
    text: 'пути к контролу записано не было — он ожидался прямо на странице',
    licensedBy: (s) => revealHad(s) === false },

  // REVEAL-REPLAY OUTCOME (L1). Rendered only for the informative case — the recovery pass reopened the
  // container (the target resolved) and the act STILL failed. Licensed by the step's own revealReplay flag,
  // so it never fires on a main-pass live-state miss (`{replayed:false}` / absent).
  { id: 'reveal-replay-reopened-failed', where: 'walk-view.failurePanel', on: 'step',
    text: 'контрол нашёлся при переоткрытии, но акт всё равно не прошёл',
    licensedBy: (s) => !!(s && s.revealReplay && s.revealReplay.replayed === true) },

  // verdictOf, BY TONE. The old line printed «Отмечен недостижимым. Недостижимых: N» UNCONDITIONALLY
  // on every failure class with the wrong N. Each tone now licenses a different sentence.
  { id: 'verdict-planned', where: 'walk-view.verdictOf', on: 'step',
    text: 'Скрипт отказался жать сам — это решение политики, а не недостижимость: контрол остался неизученным по нашему выбору, а не потому, что мы до него не добрались.',
    licensedBy: (s) => toneOf(s) === 'planned' },
  { id: 'verdict-finding', where: 'walk-view.verdictOf', on: 'step',
    text: 'Записано как НАХОДКА, а не как сбой: контрол объявляет себя и не даёт себя нажать. Недостижимым он не отмечен.',
    licensedBy: (s) => toneOf(s) === 'finding' },
  { id: 'verdict-broken', where: 'walk-view.verdictOf', on: 'step',
    text: 'Шаг сорвался: до контрола дошли, оборвалось само действие. Недостижимым он не отмечен — неизученным остался.',
    licensedBy: (s) => toneOf(s) === 'broken' },
  { id: 'verdict-unreached', where: 'walk-view.verdictOf', on: 'step',   // THE unreachable line
    text: 'Отмечен недостижимым: контрол есть, но мы до него не добрались.',
    licensedBy: (s) => toneOf(s) === 'unreached' },
  { id: 'verdict-passed', where: 'walk-view.verdictOf', on: 'step',
    text: 'Шаг прошёл: контрол отработан, отметки о недостижимости нет.',
    licensedBy: (s) => toneOf(s) === 'passed' },

  // The request-status "not captured" chip. Statuses ARE captured (a per-requestId CDP ledger), so a
  // step whose requests all lack a status is the degraded case a dropped-status projection produces.
  { id: 'request-status-absence', where: 'walk-view.requestRowsHtml', on: 'step',
    text: 'ответ по этому запросу не зафиксирован',
    licensedBy: (s) => { const rq = (s && s.requests) || []; return rq.length > 0 && rq.every((r) => !Number.isFinite(Number(r && r.status))); },
    contradictedBy: (ev) => finiteStatuses(ev && ev.payload).length > 0 },

  // «Модель здесь ничего не решает» — the unexplained-time-is-not-model-thinking claim, which
  // applies to a row that HAS unexplained time. Unconditional (()=>true) would fire on every row.
  { id: 'model-decides-nothing', where: 'pipeline-view.inspector', on: 'row',
    text: 'Это не навигация и не работа модели: это время внутри шага, которое никто не замерил. Так во всех сохранившихся прогонах — события переходов писались без замеров стадий.',
    licensedBy: (r) => Number.isFinite(r && r.idleMs) && r.idleMs > 0 },

  // THE HEADLINE. The strip printed template counts under «изучено контролов»; the instance split is
  // shown when instanceStats exist, and the template-fallback caption ONLY when they do not.
  { id: 'coverage-template-fallback', where: 'walk-view.kpiHtml', on: 'run',
    text: 'изучено ШАБЛОНОВ (поэкземплярный счёт для этого прогона недоступен)',
    licensedBy: (view) => !(view && view.instanceStats),
    contradictedBy: (ctx) => instanceCount(ctx && ctx.graph) > 0 },
];

// The full set the completeness check treats as declared: every CLAIM text plus every LABEL.
export function registeredTexts() {
  return [...CLAIMS.map((c) => c.text), ...LABELS].map(normalize);
}

// Classifiers whose firing rate the liveness check measures, and the honest note that a Set of
// decision kinds fires ZERO times on every trail on disk — no writer stamps agent.think/llm/judge.
// Declared unmeasurable (not silently empty): the day a trail carries one it becomes measurable and
// this entry is removed. See ADMIN-TRUTH-PLAN Stage 6 (driver.open / decision capture).
export const UNMEASURABLE_ON_FIXTURE = new Set(['DECISION_KINDS']);
