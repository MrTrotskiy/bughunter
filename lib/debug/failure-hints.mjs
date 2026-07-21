// failure-hints — THE SINGLE SOURCE OF TRUTH for "why did this act not study the control".
//
// Every consumer (admin.html today, any future CLI / report) MUST import from here. No hint
// string may be inlined at a call site — that is how the previous classifier decayed: five
// distinct causes collapsed into one label, and the label was chosen by guessing at message
// TEXT. Measured on run `raw1` (287 acts, 146 failures), that guesser was wrong 43 times in a
// single class: its `/refus/` probe matched the words "firewall-refused", so every REVEAL_FIREWALL
// act was reported as a danger-floor refusal — including a `button "Close"` that danger-floor
// classifies as SAFE. It also printed «не удалось найти на странице» directly above a message
// saying the element IS present but not visible. Both are gone by construction here.
//
// FOUR TONES, and the two corrections that motivated them:
//  - ПО ПЛАНУ  — the mechanism did its job. A firewall block and a danger refusal are the safety
//    story WORKING. Painting them red reports our own guard rails as breakage.
//  - НАХОДКА   — DISABLED is a FINDING, not a failure. docs/GOAL.md: "the control announces itself
//    but refuses to be operated" is something to record and attribute. step.mjs already calls it a
//    finding. The old UI painted it «сбой» — the exact inversion of its meaning.
//  - НЕ ДОШЛИ  — a reach gap: the control exists, we could not get to it. Honest, not alarming.
//  - СЛОМАЛОСЬ — a genuine defect worth a human look.
//
// SENTENCE DISCIPLINE (binding):
//  - Verdict first, evidence second. Explain the situation, never paraphrase the error string.
//  - NEVER imply model cognition. The live driver has NO LLM stage; the subject is «скрипт» or the
//    named mechanism. Same rule pipeline-view.mjs already holds for its unexplained-time bucket.
//  - NEVER instruct the reader to navigate. The NO_INSTANCE branch used to end «откройте шаг во
//    вкладке «Прогоны»» — and the operator read that sentence WHILE ON that tab: an explanation
//    that sends the reader where he already is explains nothing and is a defect, not a hedge. When
//    a fact genuinely cannot be established, name the MISSING INPUT in one clause and stop. Every
//    caller that can supply the input now does (the walk caches the step's snapshot; the Конвейер
//    tab fetches one on selection), so the hedge is the rare case rather than the default.
//
// Keyed by TAXONOMY class (the operator's vocabulary, the one the census is written in); each class
// declares the source `code:` literals that map onto it, so the parity test can prove no thrown code
// is left without an explanation. `legacyRe` reads the runs ALREADY on disk, which carry prose only —
// trace payloads gained `code` later, so text matching stays load-bearing for archived runs.

export const TONES = {
  PLANNED: { key: 'planned', label: 'ПО ПЛАНУ', hint: 'механизм отработал как задумано' },
  UNREACHED: { key: 'unreached', label: 'НЕ ДОШЛИ', hint: 'контрол существует, но мы до него не добрались' },
  BROKEN: { key: 'broken', label: 'СЛОМАЛОСЬ', hint: 'настоящий сбой — стоит посмотреть' },
  FINDING: { key: 'finding', label: 'НАХОДКА', hint: 'это результат исследования, а не сбой' },
};

const ANSI = /\[[0-9;]*m/g;
export const clean = (s) => String(s == null ? '' : s).replace(ANSI, '');

// Russian plural for a count: [1, 2-4, 5+]. Exported because pipeline-view states counts too
// («эти 7 шагов», «а не 7 независимых событий») and a second copy would drift.
export function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  return b === 1 ? forms[0] : forms[2];
}
const steps = (n) => `${n} ${plural(n, ['шаг', 'шага', 'шагов'])}`;

/* --------------------------------------------------------------- evidence extractors */

// Playwright's timeout message already NAMES the element that ate the click:
//   `<span title="All" class="ant-select-selection-item">All</span> intercepts pointer events`
// That is the single most useful fact available anywhere in the table, and it was being thrown
// away with the rest of the raw string. Returns a compact human form, or null.
export function interceptingOf(message) {
  const m = clean(message).match(/<([a-zA-Z][\w-]*)\b[^>]*>([^<]*)<\/[a-zA-Z][\w-]*>\s*intercepts pointer events/)
    || clean(message).match(/<([a-zA-Z][\w-]*)\b[^>]*>\s*intercepts pointer events/);
  if (!m) return null;
  const text = (m[2] || '').trim();
  return text ? `<${m[1]}> «${text}»` : `<${m[1]}>`;
}

// `... firewall-refused request POST /api/addview (off-origin) ...`
export function firewallOf(message) {
  const m = clean(message).match(/firewall-refused request\s+([A-Z]+)\s+(\S+)/);
  return m ? { method: m[1], target: m[2] } : null;
}

// `refusing to fire a communication control "Join a meeting" (template 1323)`
//
// FOUR message shapes carry a floor class, and the regex used to read only the first two:
//   step.mjs      `refusing to fire a <floor> control "<name>" (template N)`
//   step.mjs      `refusing to fire a <floor> live representative "<name>" (template N)`   ← was missed
//   observe.mjs   `refusing an ACTED observation on a <floor> control "<name>"; …`          ← was missed
// A missed shape fell through to a generic «опасные», which is the defect this file exists to end:
// the icon-only-representative refusal is EXACTLY the case where the class is the interesting fact.
const DANGER_RU = {
  destructive: 'разрушительные', communication: 'связь с людьми',
  auth: 'вход и выход', payment: 'оплата',
};
export function dangerClassOf(message) {
  const m = clean(message).match(/refusing to (?:fire|click) an?\s+(\S+)\s+(?:control|link|live representative)/)
    || clean(message).match(/refusing an ACTED observation on an?\s+(\S+)\s+control/);
  if (!m) return null;
  return { raw: m[1], ru: DANGER_RU[m[1]] || m[1] };
}

// The route a route-level refusal was taken on. Covers BOTH writers:
//   step.mjs      `refusing to click a link to a danger route /logout (template 12)`
//   recon-run/whats-new  `refusing to navigate to a danger route /logout`
export function dangerRouteOf(message) {
  const m = clean(message).match(/danger route\s+(\S+)/);
  return m ? m[1] : null;
}

/* --------------------------------------------------------------- the refusal rules */

// WHICH RULE REFUSED, AND WHAT THAT COSTS. The sentence this replaces named ONE fixed category and
// ONE fixed justification — «классификатор отнёс контрол к категории «X». Это защита от logout /
// удаления / оплаты» — for every refusal in the project, whichever rule had actually fired. Two lies
// in one line, and the third instance of this bug class in a single session:
//
//  1. THE WRONG RULE. `danger-floor.dangerFloor()` classifies into FOUR disjoint classes and gates on
//     the `REFUSED` set; `explore-policy` adds THREE more refusals of its own with entirely different
//     justifications (`OUTWARD_REFUSED`, `FOREIGN_DESTROY`, `ACCOUNT_PROTECTED`). Seven rules, one
//     sentence, a trio of causes that belongs to none of them in particular. Measured on the runs on
//     disk: raw1 refused 7 controls as `communication` and 1 as `destructive`; raw3 and hunt1 between
//     them carry 57 `OUTWARD_REFUSED` acts — the DOMINANT refusal class of both runs, and it did not
//     classify at all (see the CLASSES entry below), so those rows rendered with no explanation
//     whatever while the 3 `destructive` rows got the boilerplate trio.
//  2. THE WRONG FRAME. It called the refusal «защита» — protection the operator wants. He does not.
//     CLAUDE.md states the posture: "there is NO read-only mode and no network write-firewall — the
//     crawler is a QA tool on the operator's own stand and is MEANT to create/edit/delete/pay". On a
//     DEFAULT run a danger refusal is LOST COVERAGE: the control was never studied, and re-running
//     with `--explore-all` removes the refusal entirely. Reporting that as a success inverts it.
//
// So the rule is derived from the payload's own evidence and each rule states its OWN justification.
// The MODE is derivable too, and from the source rather than from a flag we would have to trust:
// `DANGER_FLOOR` and `ROUTE_DANGER` are thrown ONLY in the `!exploreAll` branch (step.mjs:195,
// recon-run.mjs:144, whats-new.mjs:78), and the three explore-policy codes ONLY when explore-all is
// armed (`decidePolicy` is called nowhere else). The code IS the mode; nothing is inferred from
// run.json, which on raw3 would have been wrong in both directions — that run carries explore-all
// policy verdicts up to seq 151 AND default-mode DANGER_FLOOR refusals from seq 180.
//
// `lifted: true` means a default-run refusal that `--explore-all` removes. The three rails are
// `lifted: false` and DELIBERATELY never name the flag: suggesting a re-run that would change nothing
// is the same defect one level down.

const LIFTED_BY_EXPLORE_ALL = 'Контрол не изучен — это дыра в покрытии, а не успех. Отказ снимается: перезапуск с --explore-all убирает его и классифицирует контрол, нажав на него.';

export const REFUSAL_RULES = {
  destructive: { lifted: true, label: '«разрушительные»',
    why: 'имя или адрес контрола содержит слово о необратимом уничтожении данных' },
  auth: { lifted: true, label: '«вход и выход»',
    why: 'контрол завершает сессию, и остаток обхода шёл бы уже неавторизованным' },
  payment: { lifted: true, label: '«оплата»',
    why: 'контрол проводит платёж' },
  communication: { lifted: true, label: '«связь с людьми»',
    why: 'контрол инициирует звонок, встречу или трансляцию — это уходит наружу к живому человеку, и отменить это нечем' },
  'danger-route': { lifted: true, label: 'опасный адрес',
    why: null },   // the sentence names the route instead; see refusalSentence
  outward: { lifted: false, label: 'выход за пределы приложения',
    why: 'контрол обращается к живому человеку или отправляет что-то за пределы приложения',
    tier: 'Отказ намеренный и действует в любом режиме работы краулера: стенд ручается за то, что данные приложения — фикстуры, но не за то, что почтовый шлюз и шлюз сообщений замоканы.' },
  'foreign-destroy': { lifted: false, label: 'чужой контент',
    why: 'акт уничтожает то, что создал другой пользователь',
    tier: 'Отказ намеренный и переживает любой режим: чужое разрешено править с откатом, но не уничтожать — откатывать было бы уже нечего.' },
  'account-protected': { lifted: false, label: 'чужой аккаунт',
    why: 'удаление аккаунта разрешено только тому прогону, который этот аккаунт и создал, а этот создан не здесь',
    tier: 'Отказ намеренный и переживает любой режим.' },
};

// Resolve the rule that fired from the act's OWN payload. Returns `{ rule, route }`, or
// `{ rule: null, missing }` naming the input that would have answered it — never a plausible default.
export function refusalRuleOf(step) {
  const code = step && step.code ? String(step.code) : '';
  const message = clean(step && (step.error || step.message));
  if (code === 'OUTWARD_REFUSED' || /reaches a person or a third party/.test(message)) return { rule: 'outward' };
  if (code === 'FOREIGN_DESTROY' || /refusing to destroy another user's content/.test(message)) return { rule: 'foreign-destroy' };
  if (code === 'ACCOUNT_PROTECTED' || /refusing to delete an account this run did not create/.test(message)) return { rule: 'account-protected' };
  const floor = dangerClassOf(message);
  if (floor && REFUSAL_RULES[floor.raw]) return { rule: floor.raw };
  const route = dangerRouteOf(message);
  if (route) return { rule: 'danger-route', route };
  // A floor word we do not know is still EVIDENCE — report it verbatim rather than guessing.
  if (floor) return { rule: null, missing: `класс «${floor.raw}» не описан в таблице правил` };
  return { rule: null, missing: 'в сообщении нет ни класса опасности, ни адреса ссылки, а поле floor акт не пишет — его несут только события policy-verdict' };
}

// The whole refusal sentence: which rule, why THAT rule exists, and what the refusal cost.
export function refusalSentence(step) {
  const { rule, route, missing } = refusalRuleOf(step);
  if (!rule) return `Скрипт отказался действовать намеренно, но какое правило сработало — по этому шагу не восстановить: ${missing}.`;
  const r = REFUSAL_RULES[rule];
  const head = rule === 'danger-route'
    ? `Сработало правило «опасный адрес»: ссылка ведёт на ${route || 'адрес, которого нет в сообщении'}, и навигационный фильтр отнёс сам адрес к опасным. Какой именно класс адреса совпал, в сообщении не записано — оно несёт только адрес.`
    : `Сработало правило ${r.label}: ${r.why}.`;
  return `${head} ${r.lifted ? LIFTED_BY_EXPLORE_ALL : r.tier}`;
}

/* --------------------------------------------------------------- evidence extractors (cont.) */

// `reveal step changed route to /profile/xxx — no longer stay-on-page`
export function navigatedRouteOf(message) {
  const m = clean(message).match(/changed route to\s+(\S+)/);
  return m ? m[1] : null;
}

/* --------------------------------------------------------------- graph join */

// The reveal path recorded for a template, read off a graph snapshot. This join is what turns
// NO_INSTANCE from a shrug into a diagnosis: on `raw1`, 33 of 53 NO_INSTANCE acts had NO path
// recorded at all (the crawler never knew how to reach that control) and 20 had one that broke —
// two completely different stories that the old single label reported identically.
export function elementOf(graph, templateId) {
  const els = graph && graph.elements;
  if (!els || templateId == null) return null;
  return (Array.isArray(els) ? els.find((e) => e && e.templateId === templateId)
    : Object.values(els).find((e) => e && e.templateId === templateId)) || null;
}

export function revealPathFor(graph, templateId) {
  const el = elementOf(graph, templateId);
  if (!el) return null;
  const own = el.reveal && Array.isArray(el.reveal.statePath) ? el.reveal.statePath : null;
  if (own && own.length) return { path: own, from: 'element', el };
  for (const inst of el.instances || []) {
    const p = inst && inst.reveal && Array.isArray(inst.reveal.statePath) ? inst.reveal.statePath : null;
    if (p && p.length) return { path: p, from: 'instance', el };
  }
  return { path: [], from: 'none', el };
}

// "Was a reveal path ever recorded for this control?" — resolved from the STRONGEST evidence the
// caller could supply, in order:
//   1. the act's own payload. `stateful-step`/`recon-run` stamp `target.hadRevealPath` precisely to
//      separate "we never knew how to reach it" from "the recorded path BROKE" under one code, so
//      when a run carries it the question is answered with no graph at all (raw2 and later).
//   2. the graph snapshot for the step (runs already on disk, which stamp no such flag).
//   3. neither → UNKNOWN, and the sentence must say which input is missing rather than guess.
// `steps` is null when a path is known to EXIST but its length is not (the flag says yes, no graph
// was joined) — the sentence then omits the count instead of inventing one.
export function revealKnowledge(step, graph) {
  const reveal = graph && step ? revealPathFor(graph, step.templateId) : null;
  if (reveal) return { known: true, steps: reveal.path.length, reveal };
  const t = step && step.target && typeof step.target === 'object' ? step.target : null;
  const flag = step && typeof step.hadRevealPath === 'boolean' ? step.hadRevealPath
    : (t && typeof t.hadRevealPath === 'boolean' ? t.hadRevealPath : null);
  if (flag === true) return { known: true, steps: null, reveal: null };
  if (flag === false) return { known: true, steps: 0, reveal: null };
  return { known: false, steps: null, reveal: null };
}

// Locate WHICH hop of a recorded path the failing selector is, so the chain can be drawn
// «шаг 1 ✓, шаг 2 ✓, шаг 3 ✗». Returns a 1-based index, or null when it cannot be proven —
// in which case the sentence must not invent one.
export function hopIndexOf(graph, reveal, message) {
  const sel = clean(message).match(/reveal step selector\s+(.+?)\s+not present/);
  if (!sel || !reveal || !reveal.path.length || !graph) return null;
  const els = graph.elements || {};
  const all = Array.isArray(els) ? els : Object.values(els);
  for (let i = 0; i < reveal.path.length; i++) {
    const hop = reveal.path[i];
    const el = all.find((e) => e && e.templateId === hop.templateId);
    const inst = (el && (el.instances || []).find((x) => x && x.instanceKey === hop.instanceKey)) || null;
    if (inst && inst.instanceSelector === sel[1]) return i + 1;
  }
  return null;
}

/* --------------------------------------------------------------- the taxonomy */

// ORDER IS LOAD-BEARING for legacy prose matching: the most specific pattern must win. The old
// classifier put a bare `/refus/` first and it swallowed "firewall-refused" — 43 acts on one run.
export const CLASSES = [
  { code: 'REVEAL_FIREWALL', tone: TONES.PLANNED, chip: 'файрвол', codes: ['REVEAL_WRITE_BLOCKED'],
    legacyRe: /firewall-refused request/,
    explain: (c) => { const f = firewallOf(c.message); const what = f ? `${f.method} ${f.target}` : 'запись на сервер';
      return `Пока открывали путь к контролу, страница отправила ${what}. Файрвол не пропустил. Аккаунт не изменён, контрол остался неизученным.`; } },

  { code: 'REVEAL_HOP_MISSING', tone: TONES.UNREACHED, chip: 'путь оборван', codes: ['REVEAL_STALE'],
    legacyRe: /reveal step (?:selector .* not present|\S+ no longer resolves)/,
    explain: (c) => { const n = c.reveal ? c.reveal.path.length : 0; const at = hopIndexOf(c.graph, c.reveal, c.message);
      // The ✓/✗ chain is drawn ONLY when the failing hop is PROVEN by matching the selector against
      // the recorded path. An invented index would read as precision we do not have.
      if (at && n) return `Путь к контролу: ${Array.from({ length: n }, (_, i) => `шаг ${i + 1} ${i + 1 < at ? '✓' : i + 1 === at ? '✗' : '·'}`).join(', ')} — элемент этого шага исчез со страницы.`;
      return n ? `Путь к контролу был записан (${steps(n)}), но один из его шагов больше не существует на странице.`
        : 'Шаг записанного пути к контролу больше не существует на странице.'; } },

  { code: 'REVEAL_NAVIGATED', tone: TONES.UNREACHED, chip: 'путь увёл', codes: ['REVEAL_NAVIGATED'],
    legacyRe: /changed route to .* no longer stay-on-page/,
    explain: (c) => { const r = navigatedRouteOf(c.message);
      return `Путь к контролу увёл на другую страницу${r ? ` (${r})` : ''}. Он должен был открыть контрол на месте, а вместо этого сменил адрес — записанный путь устарел.`; } },

  // THREE codes, three different reasons a path was refused — collapsed into one sentence that named
  // a fixed pair ("опасное действие или уход на чужой домен") and omitted the third entirely, so a
  // REVEAL_DISMISS_IN_PATH row was described by two causes that both happened not to be its own.
  // Same defect as DANGER_REFUSED below, one level down. The code is in the payload; read it.
  { code: 'REVEAL_REFUSED', tone: TONES.PLANNED, chip: 'путь опасен', codes: ['REVEAL_DANGER', 'REVEAL_OFFORIGIN', 'REVEAL_DISMISS_IN_PATH'],
    legacyRe: /reveal step .*(danger|off-origin link|dismiss)/,
    explain: (c) => {
      const m = c.message;
      const kind = c.step && c.step.code === 'REVEAL_OFFORIGIN' ? 'offorigin'
        : c.step && c.step.code === 'REVEAL_DISMISS_IN_PATH' ? 'dismiss'
          : c.step && c.step.code === 'REVEAL_DANGER' ? 'danger'
            : /off-origin link/.test(m) ? 'offorigin' : /dismiss control/.test(m) ? 'dismiss' : /danger/.test(m) ? 'danger' : null;
      if (kind === 'offorigin') return 'Один из шагов пути к контролу — ссылка на чужой домен. Переходить по ней под нашей сессией не стали, до самого контрола не дошли.';
      if (kind === 'dismiss') return 'Путь к контролу проходит через закрывающий контрол: воспроизведение этого шага закрыло бы тот самый контейнер, в котором живёт цель. Путь не пошли, до контрола не дошли.';
      if (kind === 'danger') return 'Один из шагов пути к контролу сам классифицирован как опасный, поэтому путь не воспроизводили. До самого контрола не дошли.';
      return 'Путь к контролу отказались открывать, но какой из его шагов виноват — по этому шагу не восстановить: в сообщении нет ни кода отказа, ни признака шага.'; } },

  { code: 'REVEAL_UNWALKABLE', tone: TONES.UNREACHED, chip: 'путь непроходим', codes: ['REVEAL_CYCLE', 'REVEAL_TOO_DEEP', 'REVEAL_PROVENANCE_ONLY'],
    legacyRe: /reveal path (?:is cyclic|too deep|depth)|provenance only|provenance, not a replayable/,
    explain: (c) => {
      const m = c.message;
      const kind = c.step && c.step.code === 'REVEAL_CYCLE' ? 'cycle'
        : c.step && c.step.code === 'REVEAL_TOO_DEEP' ? 'deep'
          : c.step && c.step.code === 'REVEAL_PROVENANCE_ONLY' ? 'provenance'
            : /cyclic/.test(m) ? 'cycle' : /depth|too deep/.test(m) ? 'deep' : /provenance/.test(m) ? 'provenance' : null;
      if (kind === 'cycle') return 'Записанный путь к контролу возвращается на шаблон, который в нём уже был, — пройти такой путь нельзя, он зациклен.';
      if (kind === 'deep') {
        const d = m.match(/depth\s+(\d+)\s+exceeds\s+(\d+)/);
        return d ? `Записанный путь к контролу длиннее допустимого: ${d[1]} ${plural(Number(d[1]), ['шаг', 'шага', 'шагов'])} при пределе ${d[2]}.`
          : 'Записанный путь к контролу длиннее допустимого предела глубины.'; }
      if (kind === 'provenance') return 'Записанный путь — это происхождение контрола (как до него дошли по накопленному состоянию), а не воспроизводимый маршрут: заново по нему пройти нельзя.';
      return 'Записанный путь к контролу пройти нельзя, но чем именно он непроходим — по этому шагу не восстановить: в сообщении нет ни кода отказа, ни глубины.'; } },

  { code: 'NOT_VISIBLE', tone: TONES.UNREACHED, chip: 'не виден', codes: ['NOT_VISIBLE'],
    legacyRe: /is present but not visible in the current viewport/,
    text: 'Контрол есть в разметке, но не виден. Невидимое не нажимаем — это закрытая панель, а не поломка.' },

  { code: 'DISABLED', tone: TONES.FINDING, chip: 'выключен', codes: ['DISABLED'],
    legacyRe: /is visible but disabled/,
    text: 'Контрол виден и подписан, но выключен. Проверьте, должен ли он быть активен в этом состоянии.' },

  // THE RULE THAT FIRED, NOT A FIXED TRIO. See REFUSAL_RULES above for the two lies this replaces.
  // A DANGER_FLOOR act is DEFAULT-MODE BY CONSTRUCTION (step.mjs throws it only in the `!exploreAll`
  // branch), so the sentence can state the consequence without guessing at the mode: the control was
  // not studied, that is a coverage gap, and `--explore-all` removes the refusal.
  { code: 'DANGER_REFUSED', tone: TONES.PLANNED, chip: 'предохранитель', codes: ['DANGER_FLOOR'],
    legacyRe: /refusing to (?:fire|click) an?\s+\S+\s+(?:control|link|live representative)|refusing an ACTED observation/,
    explain: (c) => refusalSentence(c.step) },

  { code: 'ROUTE_REFUSED', tone: TONES.PLANNED, chip: 'адрес опасен', codes: ['ROUTE_DANGER'],
    legacyRe: /danger route/,
    explain: (c) => refusalSentence(c.step) },

  // THE EXPLORE-ALL RAILS. These three are the only `allow:false` verdicts explore-policy can return,
  // and every one of them lands on an act row as a thrown envelope — yet all three sat in
  // NOT_AN_ACT_OUTCOME as "verdicts ABOUT an act, not errors an act carries". They are both: the
  // caller turns `allow:false` into an envelopeError. The parity test could not catch it because
  // step.mjs throws `code: pre.code` — a VARIABLE, invisible to a scanner that reads code literals —
  // so 57 refusals across raw3 and hunt1 classified to null and rendered as unexplained rows (the
  // Walk tab drew them as ordinary successes; the Конвейер tab badged them flat-red «сбой»).
  // Unlike a danger-floor refusal these ARE deliberate and survive every mode, so their sentences
  // never mention a flag — see REFUSAL_RULES.
  { code: 'OUTWARD_REFUSED', tone: TONES.PLANNED, chip: 'наружу', codes: ['OUTWARD_REFUSED'],
    legacyRe: /reaches a person or a third party outside the app/,
    explain: (c) => refusalSentence(c.step) },

  { code: 'FOREIGN_DESTROY', tone: TONES.PLANNED, chip: 'чужое', codes: ['FOREIGN_DESTROY'],
    legacyRe: /refusing to destroy another user's content/,
    explain: (c) => refusalSentence(c.step) },

  { code: 'ACCOUNT_PROTECTED', tone: TONES.PLANNED, chip: 'чужой аккаунт', codes: ['ACCOUNT_PROTECTED'],
    legacyRe: /refusing to delete an account this run did not create/,
    explain: (c) => refusalSentence(c.step) },

  { code: 'OFF_ORIGIN', tone: TONES.PLANNED, chip: 'чужой домен', codes: ['OFF_ORIGIN'],
    legacyRe: /off-origin|external link/,
    text: 'Ссылка ведёт на чужой домен. Такие не открываем — за пределами приложения нам нечего изучать.' },

  // THE SPLIT. One message, two opposite stories — which one it is comes from the GRAPH, not from
  // the text, so no amount of message parsing could ever have told them apart. On `raw1`, 33 of 53
  // had no path recorded and 20 had one that broke.
  { code: 'NO_INSTANCE', tone: TONES.UNREACHED, chip: 'не нашли', codes: ['NO_INSTANCE'],
    legacyRe: /cannot resolve instance/,
    // UNKNOWN IS NOT ABSENT. When neither the payload flag nor a graph snapshot is available the
    // split cannot be made, and claiming "путь не записан" on a caller that simply never looked
    // would be the same species of lie this module exists to end. The unknown branch names the
    // MISSING INPUT — it never sends the reader to another tab (see SENTENCE DISCIPLINE above).
    explain: (c) => {
      const rk = c.revealKnown;
      const who = () => { const role = c.step && c.step.role ? c.step.role : '?';
        const d = displayName(c.step || '', 44);
        return `по роли «${role}»${d.text ? ` (${d.text})` : ''}`; };
      if (!rk.known) return 'Контрол не нашёлся на странице. Записан ли путь к нему — установить не по чему: у этого шага нет ни снимка графа, ни отметки о пути в трейле.';
      if (rk.steps === 0) return 'Контрола не было на экране, и мы не знаем, чем его открыть — путь к нему не записан.';
      if (rk.steps == null) return `Путь к контролу был записан, но контрол не нашёлся ни по нему, ни ${who()}.`;
      return `Путь был записан (${steps(rk.steps)}), но контрол не нашёлся ни по нему, ни ${who()}.`; } },

  { code: 'NO_TEMPLATE', tone: TONES.UNREACHED, chip: 'нет в графе', codes: ['NO_TEMPLATE'],
    legacyRe: /no such template|unknown template/,
    text: 'Скрипт не нашёл этот контрол в собственном графе — шаблон исчез между планированием акта и его выполнением.' },

  { code: 'ALIAS_COLLISION', tone: TONES.BROKEN, chip: 'двойник', codes: ['ALIAS_COLLISION'],
    legacyRe: /alias collision/,
    text: 'Под одним и тем же признаком на странице оказалось несколько разных контролов — нажимать вслепую нельзя, можно попасть не туда.' },

  // No `code:` in the source: these arrive as raw Playwright errors, so text IS the only key.
  { code: 'CLICK_TIMEOUT', tone: TONES.BROKEN, chip: 'клик не прошёл', codes: [],
    legacyRe: /Timeout \d+ms exceeded/,
    explain: (c) => { const who = interceptingOf(c.message); const secs = (clean(c.message).match(/Timeout (\d+)ms/) || [])[1];
      const wait = secs ? ` Ждали ${Math.round(Number(secs) / 1000)} секунд.` : '';
      return who ? `Контрол нашёлся и был виден, но клик не прошёл: сверху лежал ${who}.${wait}`
        : `Контрол нашёлся и был виден, но клик не прошёл — что-то перехватывало нажатие.${wait}`; } },

  { code: 'DETACHED', tone: TONES.BROKEN, chip: 'элемент исчез', codes: [],
    legacyRe: /not attached to the DOM/,
    text: 'Страница перерисовалась между «нашли» и «нажали».' },

  // THE TWO recordFail FALLBACK CODES, and the THIRD time this exact blind spot bit. The live drivers
  // stamp `code: err?.envelope?.code || (err?.clicked ? 'POST_CLICK_FAILED' : 'ACT_FAILED')` when an act
  // throws with NO envelope of its own (recon-run.mjs / stateful-step.mjs). Neither literal was in CLASSES,
  // so the parity test — which scans `envelopeError({code:'X'})` LITERALS — never saw them (same door
  // OUTWARD_REFUSED and the explore-policy trio slipped), and a raw non-envelope message that matched no
  // legacyRe classified to null: the row rendered flat-red «сбой» with NO sentence, the unexplained-row
  // defect this whole module exists to end. These arrive as STAMPED codes (resolved by BY_CODE); the
  // legacyRe is only a defensive net matching the fallback TOKEN, deliberately specific so it steals no
  // other prose (a raw Playwright message never contains these tokens — they are the codes, not the text).
  //
  // POST_CLICK_FAILED is the worse of the two and its sentence says so: `err.clicked === true` means the
  // control ALREADY FIRED before the failure, so under explore-all a mutation may have committed — the
  // operator must read that, not a bare code. ACT_FAILED is the generic "the step did not complete" and
  // deliberately makes NO such claim.
  { code: 'POST_CLICK_FAILED', tone: TONES.BROKEN, chip: 'клик прошёл, сбой', codes: ['POST_CLICK_FAILED'],
    legacyRe: /POST_CLICK_FAILED/,
    text: 'Клик уже дошёл до сервера — запрос ушёл, и на сервере что-то могло записаться (под --explore-all это была бы реальная правка). Но шаг завершился ошибкой уже ПОСЛЕ клика, поэтому результат не прочитан.' },

  { code: 'ACT_FAILED', tone: TONES.BROKEN, chip: 'шаг не завершён', codes: ['ACT_FAILED'],
    legacyRe: /ACT_FAILED/,
    text: 'Шаг не завершился: действие прервалось ошибкой, и контрол остался неизученным.' },
];

// A class carries EITHER a static `text` or a context-dependent `explain(ctx)` — never both.
const sentenceOf = (cls, ctx) => (cls.explain ? cls.explain(ctx) : cls.text);


// Codes that exist under lib/recon/ but can NEVER be an act's outcome — CLI usage envelopes,
// run-level setup failures, and the verdict vocabularies of explore-policy / reopen-policy (those
// are decisions ABOUT an act, returned as objects, not errors an act carries). Listed explicitly so
// the parity test still fails on a genuinely NEW code: landing in neither map is the build break.
export const NOT_AN_ACT_OUTCOME = new Set([
  'USAGE', 'INTERNAL', 'BAD_URL', 'PRIVATE_HOST',        // CLI argument / SSRF envelopes
  'LOGIN_FAILED', 'STORAGE_STATE_MISSING', 'STATE_DIR_BUSY', 'DAEMON_TIMEOUT', // run-level setup
  'CLEANUP_AMBIGUOUS',                                    // hunt-cleanup, after the crawl
  // explore-policy PERMITS only. Its three REFUSALS (OUTWARD_REFUSED / FOREIGN_DESTROY /
  // ACCOUNT_PROTECTED) were listed here too and are not permits: the caller throws them, they land on
  // act rows, and 57 such rows across raw3 + hunt1 went unexplained. They now have CLASSES entries,
  // and `explorePolicyRefusals()` in the test reads them out of the source so a fourth cannot be
  // added silently — the literal-scanning parity test cannot see them (step.mjs throws `code: pre.code`).
  'ALLOWED', 'ACCOUNT_OWN', 'AUTH_RELOGIN', 'FOREIGN_EDIT', 'FOREIGN_ADDITIVE',
  'REOPEN_OK', 'REOPEN_ALREADY', 'REOPEN_WALKED', 'REOPEN_NO_PATH', 'REOPEN_REFUSED',
  'REOPEN_NAVIGATED', 'REOPEN_UNVERIFIED', 'REOPEN_ROUTE_REFUSED', 'REOPEN_HOP_OK',
  'REOPEN_HOP_DANGER', 'REOPEN_HOP_STALE', 'REOPEN_HOP_REPEAT', 'REOPEN_HOP_OFFROUTE',
  'REOPEN_HOP_MODIFIES', 'REOPEN_HOP_DISMISS', 'REOPEN_HOP_UNKNOWN', 'REOPEN_HOP_UNPROVEN',
  'REOPEN_HOP_BUDGET_SPENT', 'REOPEN_HOP_CLICK_FAILED',   // reopen-policy hop verdicts
]);

const BY_CODE = new Map();
for (const c of CLASSES) for (const src of c.codes) BY_CODE.set(src, c);

/* --------------------------------------------------------------- the public API */

// Resolve a step to its taxonomy class. Prefers the STAMPED code (runs written after trace gained
// `payload.code`); falls back to ordered prose matching for the runs already on disk. Returns null
// for a successful act — success is not a failure class and must not be given one.
export function classify(step) {
  if (!step || !step.error) return null;
  if (step.code && BY_CODE.has(step.code)) return BY_CODE.get(step.code);
  const msg = clean(step.error);
  return CLASSES.find((c) => c.legacyRe.test(msg)) || null;
}

// The whole explanation for one step: verdict + evidence. `graph` is optional — without it the
// NO_INSTANCE split falls back to the payload's own `hadRevealPath` flag and, failing that, says
// which input is missing. Which is why the viewer fetches the snapshot on BOTH tabs that show a
// failure card: the split is the single most explanatory thing available (33 of 53 NO_INSTANCE
// failures on raw1 had no path at all, 20 had one that broke — two different diagnoses).
export function explainFailure(step, graph) {
  const cls = classify(step);
  if (!cls) return null;
  const reveal = graph ? revealPathFor(graph, step.templateId) : null;
  const revealKnown = revealKnowledge(step, graph);
  const ctx = { message: clean(step.error), step, graph, reveal, revealKnown };
  return {
    code: cls.code, chip: cls.chip,
    tone: cls.tone.key, toneLabel: cls.tone.label, toneHint: cls.tone.hint,
    sentence: sentenceOf(cls, ctx),
    revealSteps: reveal ? reveal.path.length : revealKnown.steps,
    revealKnown: revealKnown.known,
  };
}

/* --------------------------------------------------------------- the locator anchor */

// A nameless control rendered as its ROLE — «клик · button», «клик · textbox», «клик · radio» —
// and a role identifies NOTHING: the operator could not act on the row. The anchor was there all
// along and was simply never read. Measured on a reference run: 38 of 287 acts and 32 of 182 graph
// elements carry an empty name; 12 of those elements resolve to a real authored id (#video_upload,
// #gender, #org_type, #imageUpload) and the rest to a distinctive class or a sibling position.
//
// The chain runs over WHATEVER the source object holds — an act payload, a walk step, a pipeline
// row, a graph element — and touches no field that is not already on disk in some run:
//   name → test-id → stable id → the distinctive class of the element's OWN selector segment →
//   its position among its siblings → the template number.
// The bare role is deliberately NOT in the chain: it is what the defect looked like. Where nothing
// at all survives, the answer is «без имени» alone — an honest absence rather than a fake label.

// The element's own tail of a descendant selector: `a > b > button.x:nth-child(2)` → the last hop.
function lastSegment(sel) {
  const one = String(sel).split('\n')[0].trim();
  const hops = one.split('>');
  return hops[hops.length - 1].trim();
}
// Every hop of a descendant selector, innermost LAST.
function segmentsOf(sel) {
  return String(sel).split('\n')[0].trim().split('>').map((s) => s.trim()).filter(Boolean);
}
// CSS-module hash suffix: `Layout_logopart__bCbTu` → `Layout_logopart`. Kept as a display nicety
// only — the full class stays in the tooltip, and nothing here feeds identity.
// The hash alphabet includes `+` and `/` (base64-ish output): the live target renders
// `Connection_modalInput__aA+iF` and `Profile_claimAccountBox__+cOsk`, which a `[\w-]`-only class
// rule truncated mid-hash to `.Connection_modalInput__aA` — a strip that ran and left the noise in.
const MODULE_HASH = /__[A-Za-z0-9_+/=-]{2,}$/;
// A class token as it appears in a RECORDED selector, where CSS-special chars arrive backslash
// escaped (`.Profile_claimAccountBox__\+cOsk`). Matching without the escape stopped at the backslash.
const CLASS_TOKEN = /\.(?:\\.|[A-Za-z0-9_-])+/g;
const unescapeCss = (s) => s.replace(/\\(.)/g, '$1');
// Every class on one selector segment, unescaped and de-hashed, in source order.
function classesIn(segment) {
  return (String(segment).match(CLASS_TOKEN) || []).map(unescapeCss);
}
const TESTID_ATTR = /\[(?:data-testid|data-test|data-cy|data-qa)=["']?([^"'\]]+)/;
// Transient state classes — they describe the moment, not the control, so they never anchor.
const STATE_CLASS = /^\.(?:active|selected|current|open|opened|show|shown|hidden|disabled|checked|focus|focused|hover|is-[\w-]+)$/i;

// Every place a run has ever recorded the acted element's selector. raw1-era payloads carry NONE of
// the direct fields and embed it in the failure message instead, so the message is a real source.
export function selectorOf(src) {
  if (!src || typeof src !== 'object') return '';
  const loc = src.locator && src.locator.value ? String(src.locator.value) : '';
  const direct = src.instanceSelector || (src.target && src.target.selector) || src.selector
    || src.templateSelector || loc;
  if (direct) return String(direct);
  const msg = clean(src.error || src.message || '').split('\n')[0];
  const m = msg.match(/cannot resolve instance\s+(.+)$/) || msg.match(/^instance\s+(.+?)\s+is (?:present|visible)\b/);
  return m ? m[1].trim() : '';
}

// The best anchor available, plus WHICH rung of the chain produced it (so a caller can style or
// explain it). Never throws, never invents: an empty source yields kind 'none'.
export function anchorOf(src) {
  if (src == null) return { text: '', kind: 'none' };
  if (typeof src !== 'object') {
    const s = String(src).trim();
    return s ? { text: s, kind: 'name' } : { text: '', kind: 'none' };
  }
  const name = String(src.name == null ? '' : src.name).trim();
  if (name) return { text: name, kind: 'name' };

  // THE AUTHOR'S OWN LABEL FOR A FIELD. `dom-snapshot.fieldFactsOf` already records `label` and
  // `placeholder` and `graph-store` persists them, but the chain never read them — so a field whose
  // author DID write a caption could still bottom out at a selector. HONEST NOTE: on both runs on
  // disk this rung fires ZERO times (0 of 10 nameless controls carry either), so it fixes the class
  // of case rather than the ones the operator is looking at; those are answered by `container` below.
  const ff = src.fieldFacts && typeof src.fieldFacts === 'object' ? src.fieldFacts : null;
  const caption = ff && String(ff.label || ff.placeholder || '').trim();
  if (caption) return { text: caption, kind: 'caption' };

  const loc = src.locator && typeof src.locator === 'object' ? src.locator : null;
  if (loc && loc.type === 'testid' && loc.value) return { text: `[data-testid=${loc.value}]`, kind: 'testid' };
  if (loc && loc.type === 'id' && loc.value) return { text: '#' + String(loc.value).replace(/^#/, ''), kind: 'id' };

  const sel = selectorOf(src);
  if (sel) {
    const tid = sel.match(TESTID_ATTR);
    if (tid) return { text: `[data-testid=${tid[1]}]`, kind: 'testid' };
    const seg = lastSegment(sel);
    const id = seg.match(/#([A-Za-z_][\w-]*)/);
    if (id) return { text: '#' + id[1], kind: 'id' };
    const classes = classesIn(seg);
    if (classes.length) {
      // The LAST class is the most specific one the author wrote (`button.ant-btn.ant-btn-primary`)
      // — EXCEPT a transient STATE class, which names the moment rather than the control:
      // `button.owl-dot.active` anchored on «.active», which addresses nothing tomorrow.
      const durable = classes.filter((c) => !STATE_CLASS.test(c));
      const pick = (durable.length ? durable : classes).pop();
      return { text: pick.replace(MODULE_HASH, ''), kind: 'class' };
    }
    // THE CONTAINER, when the element's own segment says nothing. This is the case the operator
    // actually hit: «combobox без имени · input:nth-child(1)» — formally better than a bare role and
    // useless to a human. That control's real selector ends `… > div.Connection_modalInput__aA+iF >
    // div.ant-select > … > input`, so the author DID name the region it lives in; the chain simply
    // stopped at the leaf. Framework classes are skipped on the way up: `.ant-select-selector` is
    // the widget library talking, not the author, and it identifies nothing about THIS control.
    const anc = ancestorClass(sel);
    if (anc) return { text: anc, kind: 'container' };
    const pos = seg.match(/^([a-zA-Z][\w-]*)(:nth-child\(\d+\))?/);
    if (pos && pos[1]) return { text: pos[1] + (pos[2] || ''), kind: 'position' };
  }
  if (src.templateId != null) return { text: 't' + src.templateId, kind: 'template' };
  return { text: '', kind: 'none' };
}

// Classes minted by a widget library rather than by the application author. They are perfectly good
// STRUCTURAL anchors (dom-snapshot deliberately keeps `.ant-tabs-tab` as one) and perfectly useless
// as a HUMAN label, which is the only thing this chain is for.
const FRAMEWORK_CLASS = /^\.(?:ant|rc|radix|headlessui|mui|MuiBox|chakra|v|el|ivu|weui|adm|arco|semi|next)[-_]/i;

// Grid / layout primitives. Authored, yes — and they name a POSITION, not a region: on the live
// target the claim-account field's nearest authored ancestor is `.row`, three levels below
// `.Profile_claimAccountBox`, and «поле ввода в блоке row» is the same non-answer as a nth-child.
// Preferred-against, not banned: if a chain offers nothing else, `.row` still beats nothing.
const LAYOUT_CLASS = /^\.(?:row|col(?:umn)?(?:-\w+)?|container(?:-\w+)?|wrapper|content|inner|outer|box|main|body|header|footer|section|grid|flex(?:-\w+)?|d-flex|w-100|h-100|text-\w+|justify-\w+|align-\w+|m[trblxy]?-\d|p[trblxy]?-\d)$/i;

// The AUTHORED class above the element itself — the region a human would point at. Walks outward
// from the element and returns the innermost MEANINGFUL name, falling back to the innermost layout
// class only when the whole chain is layout.
export function ancestorClass(sel) {
  const segs = segmentsOf(sel);
  let layoutFallback = '';
  for (let i = segs.length - 2; i >= 0; i--) {   // -2: skip the element's own segment
    const classes = classesIn(segs[i])
      .filter((c) => !STATE_CLASS.test(c) && !FRAMEWORK_CLASS.test(c))
      .map((c) => c.replace(MODULE_HASH, ''));
    if (!classes.length) continue;
    const meaningful = classes.filter((c) => !LAYOUT_CLASS.test(c));
    if (meaningful.length) return meaningful.pop();
    if (!layoutFallback) layoutFallback = classes[classes.length - 1];
  }
  return layoutFallback;
}
// Is this anchor the widget library talking rather than the author? Used ONLY by the human phrase:
// `anchorOf` keeps a framework class deliberately (it is a perfectly good ADDRESSABLE anchor, and a
// revert-proven test pins that), but «кнопка в блоке ant-btn-default» tells a reader nothing about
// which button it is — every AntD button on the page is in that block.
const isFrameworkAnchor = (a) => (a.kind === 'class' || a.kind === 'container') && FRAMEWORK_CLASS.test(a.text);

// A raw1-era SUCCESSFUL act stamps no selector at all (only templateId/name/role/route), so a
// nameless one would bottom out at «без имени · t313». The graph the viewer already loads for the
// reveal-path split holds that element's selector and locator, so hand it over when we have it:
// same chain, one rung further up. Additive and pure — the step object is never mutated, and a
// missing graph or element degrades to the step exactly as before.
export function anchorSource(step, graph) {
  if (!step || typeof step !== 'object' || !graph) return step;
  if (String(step.name == null ? '' : step.name).trim()) return step;
  const el = elementOf(graph, step.templateId);
  if (!el) return step;
  const inst = (el.instances || []).find((i) => i && i.instanceSelector) || null;
  return {
    ...step,
    locator: step.locator || el.locator || (inst && inst.locator) || null,
    instanceSelector: step.instanceSelector || (inst && inst.instanceSelector) || null,
    templateSelector: step.templateSelector || el.templateSelector || null,
  };
}

// An element "name" is sometimes the concatenated text of a whole subtree — the operator was shown
// `Control A Control B Control C (0)No dataNo results found` as if it were a label.
// DISPLAY-SIDE ONLY: the derivation in lib/graph/ is identity-adjacent and is not touched here.
// (Upstream, dom-snapshot's `nameOf` falls back to `el.textContent` — the WHOLE subtree, including
// icon-font ligature text and aria-hidden nodes — which is where the blob is minted. Fixing it there
// means preferring own text nodes / innerText and skipping aria-hidden; nothing below can undo it.)
//
// Accepts EITHER a bare name string (the original contract, unchanged) OR a source object, in which
// case the anchor chain above fills in for a missing name and the result is prefixed «без имени · »
// so the row states the absence instead of disguising a role as a label.
export function displayName(src, max = 44) {
  const a = anchorOf(src);
  const full = !a.text ? (typeof src === 'object' && src !== null ? 'без имени' : '')
    : a.kind === 'name' ? a.text
      : `без имени · ${a.text}`;
  if (full.length <= max) return { text: full, full, truncated: false, kind: a.kind };
  return { text: full.slice(0, max - 1).trimEnd() + '…', full, truncated: true, kind: a.kind };
}

/* --------------------------------------------------------------- plain language */

// THE READER DOES NOT KNOW THE PROJECT. The binding rule the operator gave for every line that stays
// on screen: a person with no knowledge of this codebase must read it and understand what happened.
// A term IN BRACKETS beside a human phrase is fine; a term INSTEAD OF a phrase is not. An ARIA role
// is such a term — «combobox», «textbox», «tabpanel» are the accessibility tree's vocabulary, not a
// description of a thing on a screen.
const ROLE_RU = {
  button: 'кнопка', link: 'ссылка', textbox: 'поле ввода', searchbox: 'поле поиска',
  combobox: 'выпадающий список', listbox: 'список', option: 'пункт списка',
  checkbox: 'флажок', radio: 'переключатель', switch: 'переключатель', slider: 'ползунок',
  menu: 'меню', menuitem: 'пункт меню', menubar: 'строка меню',
  tab: 'вкладка', tabpanel: 'содержимое вкладки', tablist: 'набор вкладок',
  dialog: 'диалоговое окно', alertdialog: 'диалог с предупреждением', alert: 'предупреждение',
  img: 'изображение', heading: 'заголовок', row: 'строка таблицы', cell: 'ячейка',
  listitem: 'пункт списка', list: 'список', form: 'форма', search: 'поиск',
  navigation: 'навигация', banner: 'шапка', main: 'основная область',
  spinbutton: 'числовое поле', progressbar: 'индикатор', status: 'статус',
  generic: 'блок', presentation: 'оформление', none: 'оформление',
};
export function roleRu(role) {
  const r = String(role || '').trim().toLowerCase();
  if (!r) return 'элемент';
  return ROLE_RU[r] || r;
}

// How the anchor should be READ ALOUD, per rung. The rung is the difference between "the author
// named this" and "we are describing where it sits", and collapsing them is how «без имени ·
// input:nth-child(1)» came to be printed at a human as though it were a label.
const ANCHOR_PHRASE = {
  name: (t) => `«${t}»`,
  caption: (t) => `с подписью «${t}»`,
  testid: (t) => `с меткой ${t}`,
  id: (t) => `${t}`,
  class: (t) => `в блоке ${t.replace(/^\./, '')}`,
  container: (t) => `в блоке ${t.replace(/^\./, '')}`,
};

// ONE human phrase for a control: what kind of thing it is, and the best name anybody ever gave it.
// `ctx.ordinal` / `ctx.pageLabel` are the LAST resort the operator asked for by name — "имя страницы
// плюс порядковый номер" — and they are supplied by the caller because only the caller holds the
// graph needed to count siblings. Nothing here invents a field: `caption` comes from fieldFacts,
// `container` from the authored class of an ancestor in the recorded selector.
const ORDINAL_RU = ['первое', 'второе', 'третье', 'четвёртое', 'пятое', 'шестое', 'седьмое', 'восьмое', 'девятое', 'десятое'];
export function controlPhrase(src, ctx = {}) {
  const kind = roleRu(src && typeof src === 'object' ? src.role : null);
  let a = anchorOf(src);
  // A widget-library class is an anchor, not a description. Try the authored region above it before
  // falling back to page-and-count; «кнопка в блоке ant-btn-default» names every AntD button at once.
  if (isFrameworkAnchor(a)) {
    const authored = ancestorClass(selectorOf(src));
    a = authored ? { text: authored, kind: 'container' } : { text: '', kind: 'none' };
  }
  const phrase = ANCHOR_PHRASE[a.kind];
  if (a.text && phrase) return { text: `${kind} ${phrase(a.text)}`, kind: a.kind };
  // Nothing the author wrote survives. Say so in words and locate it the way a person would — by
  // page and by count — rather than handing over a CSS fragment.
  const where = ctx.pageLabel ? ` на странице «${ctx.pageLabel}»` : '';
  if (Number.isFinite(ctx.ordinal) && ctx.ordinal >= 1) {
    const nth = ORDINAL_RU[ctx.ordinal - 1] || `${ctx.ordinal}-е`;
    return { text: `${kind} без подписи — ${nth}${where ? ` такое${where}` : ' такое в обходе'}`, kind: 'ordinal' };
  }
  return { text: `${kind} без подписи${where}`, kind: 'none' };
}
