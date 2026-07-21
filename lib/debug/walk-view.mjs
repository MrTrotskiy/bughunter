// walk-view — every SENTENCE and NUMBER the Прогоны walk puts on screen, extracted out of
// admin.html so a node:test can execute it against a real trail. PURE: each function takes
// (step, graph, run)-shaped plain data and returns a string. No DOM, no fetch, no module state.
//
// WHY THIS FILE EXISTS. Two code reviews passed a screen that asserted false things about our own
// crawler. None of the defects were visible in a diff, because each was an inconsistency BETWEEN
// three individually-correct layers: the writer wrote the field, the projection dropped it, and the
// renderer printed its "field is absent" branch. Nothing ever executed the three together against
// real data — and nothing could, because every sentence lived inline in a 1277-line HTML file that
// no test can import. So the rule is now: anything that prints a CLAIM lives here.
// Precedent: pipeline-shell.mjs was split out of pipeline-view.mjs the same way, and admin-server.mjs
// serves it through a one-line fixed-basename allowlist branch (this module needs one too — the CSP
// is `script-src 'self'`, so a missing branch 404s the module and the page mounts nothing).

import { classify, explainFailure, displayName, anchorSource, controlPhrase, plural } from './failure-hints.mjs';

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ route naming */

// Human-readable page name from a route. Known routes get a curated label; unknown ones are prettified
// (separators / camelCase → words, title-cased). An opaque trailing id (a profile hash) is dropped, but a
// short 4-char tag is kept so two different profiles stay distinguishable rather than collapsing to one name.
export const ROUTE_NAMES = {
  '/': 'Home', '/dashboard': 'Dashboard', '/profile': 'Profile', '/editprofile': 'Edit profile',
  '/settings': 'Settings', '/support': 'Support', '/call': 'Call', '/notices': 'Notices',
  '/checkout': 'Checkout', '/account-delete': 'Delete account', '/chat': 'Chat',
  '/notifications': 'Notifications', '/stream': 'Stream',
};
export function prettify(s) {
  return String(s || '').replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
}
export function shortRoute(route) {
  if (!route || route === '—') return route || '—';
  const clean = route.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
  if (ROUTE_NAMES[clean]) return ROUTE_NAMES[clean];
  const segs = clean.split('/').filter(Boolean);
  const base = ROUTE_NAMES['/' + (segs[0] || '')] || prettify(segs[0] || clean);
  const tail = segs[segs.length - 1];
  if (segs.length > 1 && /^[A-Za-z0-9=_-]{6,}$/.test(tail)) return base + ' ·' + tail.slice(0, 4); // opaque id → short tag
  return base;
}

/* ------------------------------------------------------------------ naming a control */

// The control's rank among the SAME-ROLE unnamed controls on the same route, so «второе поле ввода
// без подписи» addresses exactly one thing and stays stable while that page's markup does.
export function ordinalOf(step, graph) {
  if (!step || !graph || !graph.elements) return null;
  const els = Array.isArray(graph.elements) ? graph.elements : Object.values(graph.elements);
  const peers = els.filter((e) => e && e.route === step.route && e.role === step.role
    && !String(e.name == null ? '' : e.name).trim())
    .sort((a, b) => (a.templateId || 0) - (b.templateId || 0));
  const i = peers.findIndex((e) => e.templateId === step.templateId);
  return i >= 0 ? i + 1 : null;
}
const trunc = (s, max) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);
// The full human phrase for a step's control. `graph` is the naming graph (see admin.html nameGraph).
export function controlText(step, graph, max = 60) {
  const p = controlPhrase(anchorSource(step, graph), { ordinal: ordinalOf(step, graph), pageLabel: shortRoute(step && step.route) });
  return trunc(p.text, max);
}
// Same phrase with the raw anchor kept in the tooltip.
export function controlHtml(step, graph, max = 60) {
  const src = step && typeof step === 'object' ? anchorSource(step, graph) : step;
  const full = controlPhrase(src, { ordinal: ordinalOf(step, graph), pageLabel: shortRoute(step && step.route) }).text;
  const raw = displayName(src, 80).full;
  return `<span title="${esc(full + (raw && raw !== full ? ` · ${raw}` : ''))}">${esc(trunc(full, max))}</span>`;
}

/* ------------------------------------------------------------------ outcome + summary */

// Classify a blocked/failed act. Returns null on success. THE TAXONOMY LIVES IN failure-hints.mjs —
// this is a thin adapter, and it must stay thin: the previous version guessed the cause from message
// TEXT with an ordered pile of regexes, and the first of them (`/refus/`) matched the words
// "firewall-refused", so all 43 REVEAL_FIREWALL acts of a reference run were reported as danger-floor
// refusals — including a `button "Close"` that danger-floor classifies as SAFE.
export function outcomeOf(s) {
  const cls = classify(s);
  if (!cls) return null;
  return { kind: cls.code, label: cls.chip, tone: cls.tone.key, why: cls.tone.hint };
}

// WHAT THE CLICK ACTUALLY DID, as one sentence. The panel used to answer this with three lines of
// field names — `no request caused` / `revealed 0 instance(s)` / `no observation (node-loop run)` —
// English jargon in a Russian interface, from which the reader learned nothing.
export function actSummary(s) {
  const n = ((s && s.requests) || []).length, rev = Number(s && s.revealed) || 0;
  const req = `${n} ${plural(n, ['запрос', 'запроса', 'запросов'])}`;
  const el = `${rev} ${plural(rev, ['новый элемент', 'новых элемента', 'новых элементов'])}`;
  if (s && s.external) return 'Ссылка ведёт на другой сайт — по ней намеренно не переходили, за пределами приложения изучать нечего.';
  if (s && s.error) return 'Клик не состоялся, поэтому ни запросов, ни новых элементов от него быть не может — почему именно, сказано выше.';
  if (n && rev) return `Клик сработал: страница отправила ${req} на сервер и показала ${el}.`;
  if (n) return `Клик отправил ${req} на сервер, но ничего нового на странице не появилось.`;
  if (rev) return `Клик не обращался к серверу, но открыл ${el} на странице.`;
  return 'Клик ничего не дал — ни запроса на сервер, ни новых элементов на странице.';
}

/* ------------------------------------------------------------------ the request rows */

// A request row rendered 2 of the 7 fields on `requests[]` — method and urlPattern — and DISCARDED
// `status` and `durationMs`. Both are captured: a per-requestId CDP ledger joins the response onto
// the causally-kept fire and trace writes it. A representative run holds POST /api/groups 500 ×2,
// POST /api/list-a 500 ×3 and POST /api/list-b 422 that no screen showed.
// Per docs/GOAL.md an anomalous status is the most valuable thing a crawl can find; per the operator's
// standing rule it is DATA RECORDED FOR PHASE 2 about the TARGET, never a defect of ours to triage
// here. So the row states it and marks it, and this module explains nothing about it.
export const anomalousRequests = (requests) => (Array.isArray(requests) ? requests : [])
  .filter((r) => r && Number.isFinite(Number(r.status)) && Number(r.status) >= 400);

export function requestRowsHtml(requests) {
  const rs = Array.isArray(requests) ? requests : [];
  if (!rs.length) return '';
  return rs.map((r) => {
    const st = Number(r.status);
    const known = Number.isFinite(st);
    const bad = known && st >= 400;
    const chip = known
      ? `<span class="st ${bad ? 'bad' : st >= 300 ? 'warn' : 'ok'}"${bad ? ' title="ответ не 2xx/3xx — аномалия, материал для Phase 2"' : ''}>${st}${bad ? ' ⚠' : ''}</span>`
      : '<span class="st none" title="ответ по этому запросу не зафиксирован">—</span>';
    const dur = Number.isFinite(r.durationMs) ? `<span class="dur">${r.durationMs}мс</span>` : '';
    return `<div class="reqrow${bad ? ' anomaly' : ''}">${chip}<span class="method m-${esc(r.method)}">${esc(r.method)}</span> `
      + `<span class="endpoint mono">${esc(r.urlPattern)}</span>${dur}</div>`;
  }).join('');
}

/* ------------------------------------------------------------------ the step detail */

export function stepDetailHtml(s, { stepGraph = null, nameGraph = null } = {}) {
  const reqs = requestRowsHtml(s.requests);
  const bad = anomalousRequests(s.requests).length;
  const anomalyNote = bad
    ? `<div class="anote">${bad} ${plural(bad, ['ответ', 'ответа', 'ответов'])} с кодом 4xx/5xx — записано как материал для Phase 2, это данные о приложении, а не наш сбой.</div>` : '';
  const t = s.timings || {}, w = (ms) => Math.max(2, Math.min(340, (ms || 0) * 1.2));
  // Draw ONLY the stages this act actually reached. A FAILED act threw before/inside the click,
  // so it carries `timings:{attemptMs}` and none of act/settle/snap.
  const bar = (nm, cls, ms) => (Number.isFinite(ms)
    ? `<div class="bar-row"><span class="nm">${nm}</span><div class="bar ${cls}" style="width:${w(ms)}px"></div><span class="muted">${ms}ms</span></div>` : '');
  const bars = [bar('клик', '', t.actMs), bar('ожидание ответа', 'settle', t.settleMs), bar('снимок страницы', 'snap', t.snapMs),
    bar('попытка клика', 'attempt', t.attemptMs)].join('') || '<div class="muted">стадии этого шага не замерялись</div>';
  // OBSERVATION IS AN AGENT-PATH-ONLY BLOCK. The live driver has no LLM stage, so on those runs there
  // is no observation to report. A section with nothing in it is dropped, not translated.
  const o = s.observe;
  const obs = o ? `<h5>что записал агент</h5><span class="tag ${esc(o.danger)}">опасность: ${esc(o.danger)}</span><span class="tag">эффект: ${esc(o.effect)}</span>${o.unreachable ? '<span class="tag" style="color:var(--bad)">не достучались</span>' : ''}<div>${esc(o.purpose) || '<span class="muted">—</span>'}</div>` : '';
  // Verdict first here too: the tone + the explanation sentence, with the raw error collapsed last.
  const oc = outcomeOf(s);
  const ex = oc ? explainFailure(anchorSource(s, nameGraph), stepGraph) : null;
  const err = oc ? `<h5>исход · ${esc(ex ? ex.toneLabel : oc.label)} · ${esc(oc.label)}</h5>
    <div style="color:var(--fg);font-size:12px;line-height:1.45">${esc(ex ? ex.sentence : oc.why)}</div>
    <details style="margin-top:5px"><summary style="cursor:pointer;font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.4px">сырые данные</summary>
      <div class="mono" style="color:var(--mut);font-size:11px;margin-top:4px;white-space:pre-wrap">${esc(s.error)}</div></details>` : '';
  // READING ORDER: the conclusion, then the evidence for it, then the timings. The request list is
  // kept because a caused endpoint IS the product of this whole tool — but it sits UNDER the sentence
  // that says whether there was one, instead of standing in for it.
  const facts = `<div class="muted" style="margin-top:6px;font-size:11px">запросов: ${(s.requests || []).length} · новых элементов: ${Number(s.revealed) || 0}${s.external ? ' · ссылка на другой сайт' : ''}</div>`;
  return `<div class="stepdetail">${err}
    <h5>что дал клик</h5>
    <div style="color:var(--fg);font-size:12px;line-height:1.45">${esc(actSummary(s))}</div>
    ${reqs ? `<div style="margin-top:6px">${reqs}</div>` : ''}${anomalyNote}${facts}
    <h5>сколько заняло</h5>${bars}${obs}</div>`;
}

/* ------------------------------------------------------------------ the failure card */

const STRATEGY_RU = { selector: 'CSS-селектор', testid: 'test-id', id: 'id', 'role-name': 'роль + имя', label: 'подпись', text: 'текст' };

// «ЧТО ПРОБОВАЛИ» — the resolver's six per-strategy records, which the projection used to drop (see
// scrub-math.deriveSteps). `ran:false` is not "nothing happened": the chain stops at the first
// strategy that resolves, so an untried strategy is itself the story of how the target was addressed.
export function attemptsHtml(target) {
  const list = target && Array.isArray(target.attempts) ? target.attempts : null;
  if (!list || !list.length) return '<span class="none">резолвер не оставил списка попыток: этот прогон писался до того, как он стал записываться</span>';
  const ran = list.filter((a) => a && a.ran).length;
  const head = `<div class="asum">стратегий в цепочке: ${list.length} · запустилось: ${ran}</div>`;
  const rows = list.map((a) => {
    const nm = STRATEGY_RU[a.strategy] || a.strategy;
    if (!a.ran) return `<div class="atry off"><span class="an">${esc(nm)}</span><span class="av">не пробовали</span></div>`;
    const same = a.sameTemplate == null ? '' : ` · того же шаблона ${a.sameTemplate}`;
    const hit = Number(a.visible) > 0;
    return `<div class="atry ${hit ? 'hit' : 'miss'}"><span class="an">${esc(nm)}</span>`
      + `<span class="av">нашла ${Number(a.raw) || 0}, из них видимых ${Number(a.visible) || 0}${esc(same)}</span></div>`;
  }).join('');
  return head + rows;
}

// «ЧТО РЕШИЛ СКРИПТ», BY TONE. The old line printed «Отмечен недостижимым. Недостижимых к этому шагу: N»
// UNCONDITIONALLY on every failure class, with N counting FAILED ACTS (39 on `fix1`) rather than
// unreachable controls (18 instance-level, 21 template-level). Two errors on the very card the
// operator opens when something broke: the wrong quantity under the wrong caption, and — worse — a
// DISABLED act (a FINDING: the app rendered an affordance it will not honour) and the 8 OUTWARD_REFUSED
// acts (a POLICY DECISION of OURS) both labelled «недостижим». Inverting a finding into a defect of
// ours is the exact failure failure-hints.mjs was written to end, so the four tones are respected and
// every number states the population it counts.
export function verdictOf(s, { steps = [], instanceStats = null, run = null } = {}) {
  const cls = classify(s);
  if (!cls) return 'Шаг прошёл: контрол отработан, отметки о недостижимости нет.';
  const same = steps.filter((x) => { const c = classify(x); return c && c.code === cls.code; }).length;
  const tail = `Шагов этого класса («${cls.chip}») в прогоне: ${same}.`;
  if (cls.tone.key === 'planned') return `Скрипт отказался жать сам — это решение политики, а не недостижимость: контрол остался неизученным по нашему выбору, а не потому, что мы до него не добрались. ${tail}`;
  if (cls.tone.key === 'finding') return `Записано как НАХОДКА, а не как сбой: контрол объявляет себя и не даёт себя нажать. Недостижимым он не отмечен. ${tail}`;
  if (cls.tone.key === 'broken') return `Шаг сорвался: до контрола дошли, оборвалось само действие. Недостижимым он не отмечен — неизученным остался. ${tail}`;
  const un = instanceStats && Number.isFinite(instanceStats.unreachable) ? instanceStats.unreachable
    : (run && run.stats && Number.isFinite(run.stats.unreachable) ? run.stats.unreachable : null);
  const many = un == null ? '' : ` Недостижимых за весь прогон: ${un} ${instanceStats && Number.isFinite(instanceStats.unreachable) ? 'экземпляров' : 'шаблонов'}.`;
  return `Отмечен недостижимым: контрол есть, но мы до него не добрались.${many} ${tail}`;
}

// The failure panel, in the ONE binding reading order (see failure-hints.mjs):
// 1 приговор · 2 где это было · 3 что пробовали · 4 что решил скрипт · 5 сырые данные (collapsed).
export function failurePanel(s, ex, oc, ctx = {}) {
  const where = s.route ? `<span class="mono">${esc(s.route)}</span>` : '<span class="none">положение не записано</span>';
  const had = s.target && typeof s.target.hadRevealPath === 'boolean' ? s.target.hadRevealPath : null;
  // The SAME field the Конвейер tab reads. While the projection dropped it the two tabs printed
  // opposite claims about one act; it is stated explicitly here so the agreement is visible.
  const reveal = had === null ? ''
    : `<div class="ocnote">${had ? 'путь к контролу был записан — до него надо было раскрывать' : 'пути к контролу записано не было — он ожидался прямо на странице'}</div>`;
  const attempts = attemptsHtml(s.target);
  const hasList = !!(s.target && Array.isArray(s.target.attempts) && s.target.attempts.length);
  return `<div class="ocard">
    <span class="octag">${esc(ex ? ex.toneLabel : oc.label)}</span>
    <div class="ocsent">${esc(ex ? ex.sentence : oc.why)}</div>
    <div class="octitle">${controlHtml(s, ctx.nameGraph, 60)}</div>
    <div class="ocsec"><h6>где это было</h6><div class="v">${where}${reveal}</div></div>
    <div class="ocsec"><h6>что пробовали</h6><div class="v ${hasList ? 'tries' : 'none'}">${attempts}</div></div>
    <div class="ocsec"><h6>что решил скрипт</h6><div class="v">${esc(verdictOf(s, ctx))}</div></div>
    <details class="ocraw"><summary>сырые данные</summary>
      <div class="ocerr mono">${esc(s.error)}</div></details></div>`;
}

/* ------------------------------------------------------------------ the stage */

// THE STAGE WAS BLANK ON ALL 200 STEPS AND BLAMED THE STEP. «кадр не снят для этого шага» /
// «нет скриншота для этого кадра» read as a per-step gap the operator might fix by picking another
// step. The truth is RUN-LEVEL: key-frames are opt-in (trace.mjs `viewMode`, BUGHUNTER_VIEW=1), the
// crawl ran without it, so ZERO of 200 acts have a PNG. Said once, at run level, with its population.
export function framesInRun(steps) {
  const list = Array.isArray(steps) ? steps : [];
  let withShot = 0;
  for (const x of list) { const sh = x && x.shots; if (sh && (sh.before || sh.after)) withShot++; }
  return { total: list.length, withShot };
}
export function stageNotice(steps) {
  const f = framesInRun(steps);
  if (!f.total) return '';
  if (f.withShot === 0) return `Кадры в этом прогоне не снимались — ни на одном из ${f.total} ${plural(f.total, ['шага', 'шагов', 'шагов'])}. `
    + 'Это свойство ПРОГОНА, а не этого шага: съёмка включается режимом <span class="mono">BUGHUNTER_VIEW=1</span>.';
  return `Для этого шага кадр не снят. Всего в прогоне снято ${f.withShot} из ${f.total}.`;
}

// THE SCHEMATIC STAND-IN FOR A KEY-FRAME. Screenshots structurally cannot exist on the failure path
// (every pre-click gate throws before `capture.before`), which is exactly why dom-skeleton.mjs was
// built — all 39 failures of `fix1` carry `payload.skeleton`, admin-server has served
// /api/runs/:id/skel/:file since it was written, and admin.html did not contain the string `skel`
// once. Columnar format: {v,w,h,truncated,nodes:[{d,tag,id,cls,role,name,x,y,w,h,vis}]}.
export function skeletonSvg(skel, rect) {
  if (!skel || !Array.isArray(skel.nodes) || !(skel.w > 0) || !(skel.h > 0)) return '';
  const vis = skel.nodes.filter((n) => n && n.vis && n.w > 1 && n.h > 1);
  const boxes = vis.slice(0, 600).map((n) => `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" class="sk d${Math.min(9, Number(n.d) || 0)}"/>`).join('');
  const labels = vis.filter((n) => n.name && n.w > 56 && n.h > 11).slice(0, 60)
    .map((n) => `<text x="${n.x + 4}" y="${n.y + Math.min(n.h - 3, 13)}" class="skt">${esc(trunc(String(n.name), 38))}</text>`).join('');
  const mark = rect && rect.width > 0 && rect.height > 0
    ? `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" class="skmark"/>` : '';
  // The cap drops the least informative nodes and the drop is always COUNTED — the project rule is
  // that a denominator never collapses silently, so the picture states what is missing from it.
  const cut = skel.truncated ? `<text x="6" y="${skel.h - 8}" class="skt cut">${skel.truncated} узлов не поместилось в бюджет снимка</text>` : '';
  return `<svg class="skel" viewBox="0 0 ${skel.w} ${skel.h}" preserveAspectRatio="xMidYMin meet" role="img" aria-label="схема DOM на момент сбоя">${boxes}${labels}${mark}${cut}</svg>`;
}

/* ------------------------------------------------------------------ coverage + the KPI strip */

// THE HEADLINE, AND THE POPULATION IT COUNTED. The strip printed `118/295` under «изучено контролов».
// Those are TEMPLATES (run.json.stats / frontierStats) — and a template is not a control: a 50-row
// table is ONE template with 50 addressable instances. Instance truth on `fix1` is 148/693 = 21.4%,
// so the caption inflated 40% against 21.4%, which would have been this project's fourth inflated
// headline. Nothing is recomputed here: admin-server calls lib/recon/frontier.mjs
// `frontierInstanceStats` and ships the result as `instanceStats`. Re-deriving a cap or sampling rule
// a lib/recon module already owns is precisely the drift class this whole effort exists to kill.
//
// The split answers the operator's real question — "why did you not press it" — by OWNER:
// `declined` is our own sampling policy saying no; `remaining` is work genuinely still owed.
// The partition is EXACT (693 with zero residue on fix1) and a non-zero residual is printed, never
// swallowed: a number that does not add up must say so rather than look tidy.
export function coverageSplit(st) {
  if (!st || !Number.isFinite(st.instances) || st.instances <= 0) return null;
  const declined = (st.siteRemainder || 0) + (st.drillSkipped || 0) + (st.widgetSkipped || 0) + (st.cappedRemainder || 0);
  const walked = st.walked || 0, remaining = st.remaining || 0, churn = st.churnSkipped || 0, unreachable = st.unreachable || 0;
  const total = st.instances;
  return {
    walked, remaining, declined, churnSkipped: churn, unreachable, total,
    residual: total - (walked + remaining + declined + churn + unreachable),
    pct: Math.round((walked / total) * 1000) / 10,
    // The declined bucket by rule, so «отклонила наша же выборка» can name WHICH rule declined.
    declinedBy: { site: st.siteRemainder || 0, rows: st.drillSkipped || 0, widget: st.widgetSkipped || 0, opener: st.cappedRemainder || 0 },
  };
}

const kpi = (v, l, cls) => `<span class="kpi${cls ? ' ' + cls : ''}"><b>${esc(v)}</b> <span>${esc(l)}</span></span>`;

export function kpiHtml({ run = null, steps = [], stats = null, instanceStats = null } = {}) {
  const st = (run && run.stats) || stats || {};
  // `avg act` is the average over acts that COMPLETED a causal window. A FAILED act carries only
  // `timings.attemptMs`, so attempt time is counted SEPARATELY under its own label — folding it into
  // `avg act` would silently redefine the measure, and a truthy `if (s.timings)` rendered `NaNms`.
  const edges = new Set(); let tot = 0, n = 0, att = 0, an = 0;
  for (const s of steps) {
    (s.requests || []).forEach((q) => edges.add(q.method + ' ' + q.urlPattern));
    const t = s.timings || {};
    if (Number.isFinite(t.actMs)) { tot += t.actMs; n++; }
    if (Number.isFinite(t.attemptMs)) { att += t.attemptMs; an++; }
  }
  const cov = coverageSplit(instanceStats);
  // A DASH IS NOT A NUMBER, AND ON A LIVE RUN IT IS NOT EVEN A GAP. The totals are stamped into
  // run.json when the run CLOSES, so a run in flight renders «–/–» and looks broken while working.
  const pending = st.explored == null && st.discovered == null && st.routes == null;
  const live = run && run.status === 'running';
  let totals;
  if (cov) {
    totals = kpi(`${cov.walked}/${cov.total}`, `изучено контролов — ${cov.pct}% (экземпляров, не шаблонов)`)
      + kpi(cov.remaining, 'осталось по-настоящему')
      + kpi(cov.declined, 'отклонила наша же выборка')
      + kpi(cov.unreachable, 'не достучались')
      + (cov.churnSkipped ? kpi(cov.churnSkipped, 'перерисовались до захода') : '')
      + kpi(st.routes ?? '–', 'страниц пройдено')
      + (cov.residual !== 0 ? `<span class="kpi wide bad">Разбиение не сходится: ${cov.residual} ${plural(Math.abs(cov.residual), ['экземпляр', 'экземпляра', 'экземпляров'])} не попали ни в одну группу — считать долю по этим числам нельзя.</span>` : '');
  } else if (pending) {
    totals = live ? '<span class="kpi wide">Итоги обхода (изучено, недостижимо, страниц) считаются по завершении прогона — он ещё идёт</span>'
      : '<span class="kpi wide">Итоги обхода не записаны: прогон завершился, не подведя их</span>';
  } else {
    // NO GRAPH SNAPSHOT FOR THIS RUN → only the template-level numbers exist. They are still printed,
    // but captioned as what they are. The old caption called them controls; that was the lie.
    totals = kpi(`${st.explored ?? '–'}/${st.discovered ?? '–'}`, 'изучено ШАБЛОНОВ (поэкземплярный счёт для этого прогона недоступен)')
      + kpi(st.unreachable ?? '–', 'не достучались (шаблонов)') + kpi(st.routes ?? '–', 'страниц пройдено');
  }
  return totals + [kpi(steps.length, 'действий'), kpi(edges.size, 'связей контрол → запрос'),
    kpi(n ? Math.round(tot / n) + 'мс' : '–', 'среднее действие'),
    ...(an ? [kpi(Math.round(att / an) + 'мс', 'средняя неудачная попытка')] : [])].join('');
}

/* ------------------------------------------------------------------ the rail counts */

// The counts beside each rail item. EVERY one is derived from the RUN ALREADY LOADED — nothing here
// fetches, and nothing invents. A section whose number cannot be derived returns null, which navCount
// renders as '—': zero would be a claim, '—' is the absence of one.
export function sectionCounts({ runs = [], run = null, steps = [], stats = null, instanceStats = null, pipeRows = null } = {}) {
  const st = (run && run.stats) || stats || {};
  const has = steps.length > 0;
  const cov = coverageSplit(instanceStats);
  const edges = new Set();
  let disabled = 0, anomalies = 0;
  const pages = new Set();
  for (const s of steps) {
    (s.requests || []).forEach((q) => edges.add(q.method + ' ' + q.urlPattern));
    pages.add(s.route || '—');
    const cls = classify(s);
    if (cls && cls.tone.key === 'finding') disabled++;
    anomalies += anomalousRequests(s.requests).length;
  }
  return {
    runs: runs.length,
    pages: has ? pages.size : null,              // pages WITH ACTS — st.routes is pages VISITED; see the walk stub
    routes: Number.isFinite(st.routes) ? st.routes : null,
    rows: Number.isFinite(pipeRows) ? pipeRows : null,
    els: Number.isFinite(st.discovered) ? st.discovered : null,
    edges: has ? edges.size : null,
    // Findings, both classes the run can actually answer for: a control that refuses to be operated,
    // and a response the target gave outside 2xx/3xx. Both are docs/GOAL.md findings.
    finds: has ? disabled + anomalies : null,
    findsSplit: has ? { disabled, anomalies } : null,
    cover: cov ? cov.walked : (Number.isFinite(st.explored) ? st.explored : null),
    coverTotal: cov ? cov.total : (Number.isFinite(st.discovered) ? st.discovered : null),
    owed: cov ? cov.remaining : null,
    tests: null,                                 // Phase-2 has produced nothing yet — '—', never 0
  };
}

// The pages of the loaded run, each mapped to its first act's index + act count, in walk order.
export function distinctRoutes(steps) {
  const seen = new Map();
  (steps || []).forEach((s, i) => { const r = s.route || '—'; if (!seen.has(r)) seen.set(r, { count: 0, idx: i }); seen.get(r).count++; });
  return seen;
}

// The newest `frontier.emit` stats in the trail — the live-run stand-in for run.json's closing totals.
export function lastStats(events, run) {
  const list = Array.isArray(events) ? events : [];
  for (let k = list.length - 1; k >= 0; k--) {
    const e = list[k];
    if (e && e.kind === 'frontier.emit' && e.payload && e.payload.stats) return e.payload.stats;
  }
  return (run && run.stats) || {};
}
