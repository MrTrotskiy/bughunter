// row-vocabulary — the Russian sentence for ONE pipeline event, per kind. Pure (payload) → string,
// no DOM, no fs — so every kind's sentence is unit-testable against a real fix1-shaped payload
// (the Stage-0 extraction pattern), and the render half of pipeline-view.mjs stays thin.
//
// WHY THIS EXISTS. The «Конвейер» tab styled 3 of the 13 event kinds a real run emits; the other ten
// fell to a default badge «этап» and rendered their RAW ENGLISH kind name (`pick`, `drain-outcome`,
// `route-choice`, …) as the whole label, in a Russian UI — and 337 `policy-verdict` rows carried a
// `name`, so a script DECISION rendered as a bare control name, indistinguishable from a click. The
// crawler's own decision protocol was captured in full and shown as noise. Each sentence here names
// the ACTION, the ALTERNATIVES it passed over, and the RULE that decided — a route choice names what
// it skipped and why, a pick names how many candidates and the ranking rule, a refusal names the gate.
//
// HONESTY (binding, same discipline as failure-hints.mjs):
//  - NEVER imply the model thinks. The live driver decides in SCRIPT; the subject is «скрипт» or the
//    named mechanism, never «агент решает».
//  - A field the sentence wants but the payload does NOT carry degrades to «причина не записана» /
//    «ответ не записан» — it never invents a reason and never crashes. Missing capture is Stage 6,
//    not this file: this is rendering only, and it reads only fields the trail actually stamps.
//  - A `policy-verdict` is a VERDICT and must never read as an act: every one opens «Вердикт: …».
//
// This module is in the completeness gate's VIEW_FILES (viewer-truth.test.mjs), so a new operator
// sentence longer than WORD_FLOOR words must be declared in claims-labels.mjs — the same rule the
// other view modules obey.

import { plural, displayName } from './failure-hints.mjs';

// The kinds whose ROW LABEL is the sentence (they carry no useful WHO/WHERE of their own — the
// sentence IS the who/where). act / act.failed / route keep pipeline-view's own title logic and only
// borrow the sentence for the inspector lead.
export const PROTOCOL_KINDS = new Set([
  'route-choice', 'pick', 'pick-empty', 'policy-verdict', 'drain-outcome',
  'retire', 'retire-answered', 'reopen', 'reopen-delivered', 'reloc-census',
]);
// Every kind rowSentence can speak for (protocol + the three frame/nav kinds that also get a lead).
export const SPOKEN_KINDS = new Set([...PROTOCOL_KINDS, 'act', 'act.failed', 'route']);

// The best human name for a control, from whatever the payload holds (name → testid → id → class →
// position → template). displayName is the ONE truncator the walk and pipeline already share.
const ctrl = (src, max = 48) => (displayName(src == null ? '' : src, max).text || 'контрол');
const at = (r) => (r ? ` на ${r}` : '');

/* ------------------------------------------------------------------ per-kind vocabularies */

const ROUTE_RULE_RU = { 'bfs-queue': 'обход в ширину', 'least-visited': 'наименее посещённая' };
const ROUTE_SRC_RU = { queue: 'из очереди', 'with-work': 'среди страниц с недоделанным' };
const REJECT_WHY_RU = { current: 'уже на ней', visited: 'уже посещена', drained: 'уже исчерпана', danger: 'опасный адрес' };
const PICK_RULE_RU = { 'revealed-recency': 'свежераскрытые вперёд', ordinary: 'по порядку' };
const PICK_EMPTY_RU = { absent: 'нет на странице', 'resolved-since': 'уже разрешены', 'hidden-positional': 'скрыты позиционно', 'role-name-only': 'только роль и имя' };
const RETIRE_RULE_RU = { 'revisits-remain': 'остались повторные заходы', 'all-judged': 'всё осуждено' };
const RETIRE_ANS_RULE_RU = { 'no-progress': 'нет прогресса', 'element-blocked': 'контрол заблокирован' };
const PROBE_RU = { click: 'клик', 'fill-valid': 'валидное значение', 'fill-empty': 'пустое значение' };
const REOPEN_CODE_RU = { REOPEN_UNVERIFIED: 'путь не подтвердился', REOPEN_HOP_STALE: 'шаг пути устарел', REOPEN_OK: 'путь воспроизведён' };
const OWNER_RU = { none: 'не определён', foreign: 'чужой', own: 'наш' };

const NR = 'причина не записана';
const num = (v) => (Number.isFinite(v) ? v : null);

/* ------------------------------------------------------------------ the sentence */

// The one-line Russian sentence for an event of `kind` with `payload`. Returns '' for a null payload
// and a bare «Событие <kind>.» for a kind this vocabulary does not speak — never a raw English label
// standing alone as the row.
export function rowSentence(kind, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  switch (kind) {
    case 'route': {
      const bits = [];
      if (num(p.total) != null) bits.push(`контролов ${p.total}`);
      if (num(p.new) != null) bits.push(`новых для графа ${p.new}`);
      if (p.opaque) bits.push(`непрозрачных областей ${p.opaque}`);
      const tail = bits.length ? ` — ${bits.join(', ')}` : '';
      return `Сняли страницу ${p.route || '(адрес не записан)'}${tail}${p.overlayDismissed ? '; баннер закрыт' : ''}.`;
    }

    case 'route-choice': {
      const src = ROUTE_SRC_RU[p.source] || 'из очереди';
      const rule = ROUTE_RULE_RU[p.rule] || p.rule || NR;
      const work = num(p.withWork) != null ? `; кандидатов с работой ${p.withWork}` : '';
      let rej = '';
      if (Array.isArray(p.rejected) && p.rejected.length) {
        const f = p.rejected[0] || {};
        const total = num(p.rejectedTotal) != null ? p.rejectedTotal : p.rejected.length;
        rej = `; отклонили ${total}: ${f.route || '?'} — ${REJECT_WHY_RU[f.why] || f.why || NR}`;
      }
      return `${p.from || '(текущая)'} исчерпана → перешли на ${p.chosen || '(адрес не записан)'} (${src}, правило ${rule})${work}${rej}.`;
    }

    case 'drain-outcome': {
      const r = p.route || '(адрес не записан)';
      const a = num(p.acts);
      const acts = a == null ? '' : `${a} ${plural(a, ['действие', 'действия', 'действий'])}`;
      if (p.outcome === 'drained') return `${r}: страница исчерпана${acts ? ` за ${acts}` : ''} — неизученных контролов не осталось.`;
      if (p.outcome === 'navigated') return `${r}: ушли на другую страницу${acts ? ` после ${acts}` : ''}.`;
      if (p.outcome === 'budget') return `${r}: остановились по лимиту${acts ? ` (${acts})` : ''} — изучено не всё.`;
      return `${r}: заход завершён (${p.outcome || 'без исхода'})${acts ? `, ${acts}` : ''}.`;
    }

    case 'retire': {
      const rule = RETIRE_RULE_RU[p.rule] || p.rule || NR;
      const bits = [];
      if (num(p.judged) != null) bits.push(`разобрано ${p.judged}`);
      if (num(p.unreachable) != null) bits.push(`недостижимо ${p.unreachable}`);
      if (num(p.deferred) != null) bits.push(`отложено ${p.deferred}`);
      const tail = bits.length ? `; ${bits.join(', ')}` : '';
      return `${p.route || '(адрес не записан)'}: страницу отложили — ${rule}${tail}.`;
    }

    case 'pick': {
      const n = num(p.candidates);
      const name = ctrl(p.chosen);
      const rule = PICK_RULE_RU[p.chosen && p.chosen.rule] || (p.chosen && p.chosen.rule) || NR;
      const head = n == null ? `Выбрали ${name}` : `Из ${n} ${plural(n, ['кандидата', 'кандидатов', 'кандидатов'])} выбрали ${name}`;
      const bits = [];
      if (num(p.outranked) > 0) bits.push(`${p.outranked} проиграли по рангу`);
      if (num(p.rejectedTotal) > 0) bits.push(`${p.rejectedTotal} отклонены`);
      const tail = bits.length ? `; ${bits.join(', ')}` : '';
      return `${head} (правило ${rule})${tail}.`;
    }

    case 'pick-empty': {
      const n = num(p.candidates);
      const reasons = p.reasons && typeof p.reasons === 'object' ? p.reasons : {};
      const summ = Object.entries(reasons).map(([k, v]) => `${v} ${PICK_EMPTY_RU[k] || k}`).join(', ');
      const head = n == null ? 'Нажимать некого' : `Из ${n} ${plural(n, ['кандидата', 'кандидатов', 'кандидатов'])} нажимать некого`;
      return `${p.route ? p.route + ': ' : ''}${head} — ${summ || NR}.`;
    }

    case 'policy-verdict': {
      const name = ctrl(p, 56);
      let body;
      if (p.code === 'OUTWARD_REFUSED') body = `нажать ${name} ЗАПРЕЩЕНО — уходит к живому человеку или за пределы приложения, откатить нечем`;
      else if (p.code === 'FOREIGN_ADDITIVE') body = `нажать ${name} разрешено — дополняющее действие над чужим контентом, правится с откатом`;
      else if (p.code === 'ALLOWED') body = `нажать ${name} разрешено — контрол безопасен, владелец ${OWNER_RU[p.ownership] || p.ownership || 'не определён'}`;
      else body = `нажать ${name} ${p.allow === false ? 'ЗАПРЕЩЕНО' : 'разрешено'} (${p.code || 'код не записан'})`;
      const notes = [];
      if (p.needsRestore) notes.push('потребует отката');
      if (p.needsRelogin) notes.push('после него — повторный вход');
      return `Вердикт: ${body}${notes.length ? `; ${notes.join('; ')}` : ''}.`;
    }

    case 'act': {
      const name = ctrl(p, 48);
      const nreq = Array.isArray(p.requests) ? p.requests.length : 0;
      const rev = num(p.revealed) || 0;
      const reqc = nreq ? `вызвано ${nreq} ${plural(nreq, ['запрос', 'запроса', 'запросов'])}` : 'сервер не отвечал';
      const revc = rev ? `, раскрыто ${rev} ${plural(rev, ['контрол', 'контрола', 'контролов'])}` : '';
      return `Нажали ${name}: ${reqc}${revc}.`;
    }

    case 'act.failed': {
      const name = ctrl(p, 48);
      const code = p.code || (p.error || p.message ? 'сбой' : null);
      return `Клик по ${name} не удался${code ? ` (${code})` : ''}.`;
    }

    case 'reopen': {
      const name = ctrl(p, 44);
      if (p.ok) {
        const h = num(p.hops);
        const hops = h != null ? ` (${h} ${plural(h, ['шаг', 'шага', 'шагов'])} пути)` : '';
        return `Снова открыли ${name}${at(p.route)}${hops}.`;
      }
      const why = REOPEN_CODE_RU[p.code] || p.code || NR;
      const hop = p.failedHop && p.failedHop.name ? ` — оборвалось на шаге «${p.failedHop.name}»` : '';
      return `Не смогли снова открыть ${name}${at(p.route)}: ${why}${hop}.`;
    }

    case 'reopen-delivered': {
      const name = ctrl(p, 44);
      if (p.delivered === false) return `Контрол ${name}${at(p.route)} не доставлен: ${REOPEN_CODE_RU[p.code] || p.code || NR}.`;
      return `Контрол ${name}${at(p.route)} снова доступен — путь к нему воспроизведён.`;
    }

    case 'retire-answered': {
      const name = ctrl(p, 44);
      const rule = RETIRE_ANS_RULE_RU[p.rule] || p.rule || NR;
      let ans = 'ответ не записан';
      if (p.answer) {
        const [probe, code] = String(p.answer).split(':');
        ans = `${PROBE_RU[probe] || probe}${code ? ` → ${code}` : ''}`;
      }
      return `Недоделанный контрол ${name}${at(p.route)} закрыт: ${ans} (${rule})${p.finding ? ' — это находка' : ''}.`;
    }

    case 'reloc-census': {
      const a = num(p.attempted) || 0;
      const s = num(p.succeeded) || 0;
      const rr = num(p.refusedRepeat) || 0;
      const df = num(p.distinctFailed) || 0;
      return `Перепись повторных заходов: из ${a} попыток удалось ${s}, повторных отказов ${rr}, так и не разрешено ${df}.`;
    }

    default:
      return `Событие ${kind || '?'}.`;
  }
}
