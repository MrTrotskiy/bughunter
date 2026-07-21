// coverage-view — the «Покрытие» screen: the answer to "почему он не нажал остальное?". PURE
// (instanceStats, instanceBuckets) → string, extracted here (never inline in admin.html) for the same
// reason walk-view exists: a node:test must be able to execute every CLAIM this screen makes against a
// real graph. No DOM, no fetch, no module state.
//
// THE SCREEN STATES ITS CONCLUSION — it does not hand the operator numbers to interpret. A lead
// sentence in his language, conclusion first; then a registry BY OWNER, one physically-separate table
// per owner. The load-bearing rule (docs/ADMIN-TRUTH-PLAN.md §5): "we declined on purpose" (the four
// policy buckets, under ONE subtotal) and "we could not" (the failure bucket) must be UNCONFUSABLE —
// kept apart by STRUCTURE (separate sections, separate subtotals), never by colour or caption alone.
//
// Every number comes from lib/recon/frontier.mjs (frontierInstanceStats + frontierInstanceBuckets,
// computed server-side and shipped by admin-server). This module re-derives NO cap or sampling rule —
// that module owns them, and re-deriving one here is the drift class that killed the contentSig
// detector. `coverageSplit` (the exact instance partition) is reused from walk-view, not duplicated.

import { esc, coverageSplit, shortRoute } from './walk-view.mjs';

// THE FOUR POLICY BUCKETS, in the OPERATOR'S words — verified against frontier.mjs, because the code's
// own bucket names lie (the plan caught `siteRemainder` mislabelled at its source as an authored-testid
// leftover when it is really the "one representative per template" fallback). Each carries a true-meaning
// gloss read off what the code actually counts, so the name and the explanation cannot drift apart.
//   site   → frontier.siteRemainder : instances of a plain (non-opener, non-listRow) template beyond the
//            ONE representative walkableIndexes hands out — the "one representative, no authored key" path.
//   rows   → frontier.drillSkipped  : list rows beyond the boundary sample (first/middle/last).
//   widget → frontier.widgetSkipped : a framework widget's popup panel — chrome, not application surface.
//   opener → frontier.cappedRemainder: opener instances past OPENER_INSTANCE_CAP (8).
const POLICY_BUCKETS = [
  { by: 'site', bucket: 'site', name: 'лимит представителей на страницу',
    gloss: 'по шаблону без авторских testid изучаем ОДНОГО представителя (или по одному на каждый authored testid); остальные экземпляры сюда — посчитаны, не пройдены' },
  { by: 'rows', bucket: 'rows', name: 'прорежённые строки списка',
    gloss: 'у списка проходим выборку строк (первая · середина · последняя), остальные строки сюда — посчитаны, не пройдены' },
  { by: 'widget', bucket: 'widget', name: 'внутренности виджета',
    gloss: 'попап фреймворкового виджета (список опций селекта, переключатели дейтпикера) — это хром, а не поверхность приложения' },
  { by: 'opener', bucket: 'opener', name: 'сверх лимита открывашки',
    gloss: 'у открывашки проходим до 8 экземпляров; всё сверх лимита сюда — посчитано, не пройдено' },
];

// The instance PARTITION the screen asserts on: the walked set plus every owner's subtotal, summing to
// the discovered total with ZERO residue. A non-zero residual is RENDERED, never swallowed — a number
// that does not add up must say so rather than look tidy. This is the ONE arithmetic the tests
// revert-prove: drop a bucket from `summed` and the residual goes non-zero and the screen warns.
export function coveragePartition(st) {
  const split = coverageSplit(st);
  if (!split) return null;
  const walked = split.walked, owed = split.remaining, declined = split.declined,
    churn = split.churnSkipped, unreachable = split.unreachable;
  const summed = walked + owed + declined + churn + unreachable;
  return {
    walked, owed, declined, churn, unreachable, total: split.total,
    residual: split.total - summed,
    // The policy-declined subtotal is site+rows+widget+opener ONLY — never the failure or churn bucket.
    // Keeping it a named value of its own is what makes "declined on purpose" unconfusable with "could
    // not": merge unreachable in and this number, and the section that renders it, change together.
    declinedSubtotal: declined, declinedBy: split.declinedBy, pct: split.pct,
  };
}

// The lead sentence — conclusion first, in the operator's language, filled with the run's real numbers.
export function coverageLead(p) {
  const notWalked = p.total - p.walked;
  return `Из ${notWalked} непройденных контролов ${p.declined} отклонила наша собственная выборка, `
    + `${p.churn} увела перерисовка, ${p.unreachable} сломались — по-настоящему должны только ${p.owed}.`;
}

const controlLabel = (r) => `${r && r.role ? esc(r.role) : 'элемент'}${r && r.name ? ` «${esc(String(r.name))}»` : ''}`;

// The drill-down: the CONTROLS in a bucket, most-populous template first. Each row is a template with
// how many of its instances landed here. A run with no graph snapshot ships no buckets — then the count
// still stands and the drill says so, rather than inventing a list.
function drillRows(controls) {
  const list = Array.isArray(controls) ? controls.slice().sort((a, b) => b.count - a.count) : null;
  if (!list) return '<div class="cov-drill-empty">поимённого списка для этого прогона нет — считается только количество</div>';
  if (!list.length) return '<div class="cov-drill-empty">пусто</div>';
  // NAME BOTH POPULATIONS. The bucket badge is the INSTANCE count (e.g. 273), but this list is one row
  // PER CONTROL (~62 rows, each tagged «N экз.»). Without this header "62 rows under a 273 badge" reads as
  // a discrepancy the operator has to reconcile by summing the column — the exact reader-side ambiguity
  // this admin exists to remove. The two counts are stated up front so the row count and the badge agree.
  const instances = list.reduce((a, r) => a + (r.count || 0), 0);
  const head = `<div class="cov-drill-hd">${list.length} контрол(ов) · ${instances} экземпляр(ов)</div>`;
  return head + list.map((r) => `<div class="cov-ctl"><span class="cov-ctl-n">${controlLabel(r)}</span>`
    + `<span class="cov-ctl-r">${esc(shortRoute(r.route))}</span>`
    + `<span class="cov-ctl-c">${r.count} экз.</span></div>`).join('');
}

// ONE bucket = one expandable row: the operator name + the count, opening to its gloss and its controls.
function bucketRow({ name, gloss, count, controls }) {
  return `<details class="cov-bucket"><summary class="cov-bkt-sum">`
    + `<span class="cov-bkt-name">${esc(name)}</span><span class="cov-bkt-cnt">${count}</span></summary>`
    + `<div class="cov-bkt-gloss">${esc(gloss)}</div>`
    + `<div class="cov-drill">${drillRows(controls)}</div></details>`;
}

// ONE owner = one physically-separate section, carrying its OWN subtotal. `data-owner`/`data-subtotal`
// are the structural seams the test reads to prove the owners are never merged (the "unconfusable" rule).
function ownerSection(owner, who, subtitle, subtotal, rowsHtml) {
  return `<section class="cov-owner" data-owner="${esc(owner)}">
    <div class="cov-owner-hd"><span class="cov-owner-who">${esc(who)}</span>
      <span class="cov-owner-sub">${esc(subtitle)}</span>
      <span class="cov-subtotal" data-subtotal="${subtotal}">${subtotal}</span></div>
    ${rowsHtml}</section>`;
}

// The whole screen. Owners top to bottom: what we studied (context), then WHY the rest was not pressed —
// our own policy (its own table + subtotal), then the two things that are NOT our choice, each apart:
// the app-side breakage we could not reach, the feed churn that erased rows, and finally what is still
// genuinely owed. Never one merged list.
export function coverageScreen(instanceStats, instanceBuckets) {
  const p = coveragePartition(instanceStats);
  if (!p) return '<div class="empty">Поэкземплярное покрытие для этого прогона недоступно — нет снимка графа.</div>';
  const b = instanceBuckets || {};
  const resid = p.residual !== 0
    ? `<div class="cov-resid">Разбиение не сходится: ${p.residual} экземпляров не попали ни в одну группу — считать долю по этим числам нельзя.</div>` : '';
  const head = `<div class="cov-head">
    <div class="cov-lead">${esc(coverageLead(p))}</div>
    <div class="cov-studied"><b>${p.walked}</b> из <b>${p.total}</b> изучено — ${p.pct}% (экземпляров, не шаблонов)</div>
    ${resid}</div>`;
  const policyRows = POLICY_BUCKETS.map((pb) => bucketRow({
    name: pb.name, gloss: pb.gloss, count: p.declinedBy[pb.by], controls: b[pb.bucket],
  })).join('');
  const policy = ownerSection('policy', 'наше правило', 'мы отказались нарочно', p.declinedSubtotal, policyRows);
  const failure = ownerSection('failure', 'поломка', 'мы не смогли дойти', p.unreachable,
    bucketRow({ name: 'не достучались', count: p.unreachable, controls: b.unreachable,
      gloss: 'до контрола не дошли — путь-раскрытие не воспроизвёлся или он остался невидим' }));
  const churn = ownerSection('churn', 'перерисовка страницы', 'увело перерисовкой', p.churn,
    bucketRow({ name: 'перерисовались до захода', count: p.churn, controls: b.churn,
      gloss: 'строка ленты перерисовалась и исчезла раньше, чем мы успели её нажать' }));
  const owed = ownerSection('owed', 'реально должны', 'работа ещё не сделана', p.owed,
    bucketRow({ name: 'осталось по-настоящему', count: p.owed, controls: b.remaining,
      gloss: 'контрол в поле зрения и не исчерпан — его ещё предстоит изучить' }));
  return `<div class="cov"><div class="cov-in">${head}${policy}${failure}${churn}${owed}</div></div>`;
}
