// FORM FILL — the missing half of "acting" on a form-bearing app.
//
// Measured on the live target crawl: 13 of 16 submit-like buttons fired NOTHING. "Post Item",
// "Update Info", "SUBMIT REQUEST", "Continue", "Create" were all scored COVERED with zero requests. The
// cause was mechanical, not conceptual: the stateful driver called actStep with no `fill` and no
// `prefill`, so it clicked Submit on an EMPTY form, client-side validation refused, and nothing was sent.
//
// This matters for COVERAGE, not just for realism: an unsubmitted form never opens its success state, its
// validation-error state, or its next step — and those states are exactly where the unreachable controls
// live. Filling is a reach mechanism.
//
// Values are benign and clearly synthetic, and carry the run's HUNT marker so anything created is provably
// ours (the ownership rail in explore-policy depends on that marker). Never real credentials, never
// payloads — this is recon, not fuzzing.

import { invisibleMark } from './hunt-gate.mjs';

// A plausible value for one field, chosen from its type/name/placeholder. Keep the vocabulary small and
// obviously-synthetic: the goal is to pass validation, not to look like a real user.
// Content pools. Varied on purpose: a site full of identical "What a beautiful day" posts reads as a bot
// even without any marker. Picking is DETERMINISTIC (hashed from the field + run) so a re-run reproduces
// the same data — reproducibility matters more than true randomness for a test tool.
const POSTS = [
  'What a beautiful day', 'Just finished a great workout', 'Anyone else watching the game tonight?',
  'Coffee first, everything else after', 'Finally got around to reading that book',
  'The weather turned out better than expected', 'Long week, glad it is Friday',
  'Trying out something new today', 'Good morning everyone', 'That was a solid episode',
];
const MESSAGES = [
  'Hey, how are you?', 'Hi there!', 'How is it going?', 'Long time no see',
  'Are you around later?', 'Just checking in', 'Hope you are doing well', 'Good to hear from you',
];
const COMMENTS = [
  'Nice one, thanks for sharing', 'Totally agree', 'This is great', 'Love this',
  'Well said', 'Thanks for posting', 'Interesting take', 'Could not agree more',
];
const TITLES = [
  'Weekend Meetup', 'Morning Run Club', 'Book Discussion', 'Coffee Catch-up',
  'Evening Session', 'Community Hangout', 'Study Group', 'Music Night',
];
const FIRST = ['James', 'Maria', 'Daniel', 'Sofia', 'Michael', 'Elena', 'Thomas', 'Anna', 'David', 'Laura'];
const LAST = ['Bennett', 'Kowalski', 'Reyes', 'Novak', 'Fischer', 'Moreau', 'Larsen', 'Costa'];
const BIOS = [
  'Coffee, books and long walks.', 'Here for the music and good conversation.',
  'Runner, reader, occasional cook.', 'Just enjoying the small things.',
];

function pick(list, seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return list[(h >>> 0) % list.length];
}

// A plausible value for one field, chosen from its type/name/placeholder.
export function valueFor(field, marker) {
  const t = (field.type || 'text').toLowerCase();
  const hint = `${field.name || ''} ${field.id || ''} ${field.placeholder || ''} ${field.ariaLabel || ''}`.toLowerCase();
  // The ownership mark is INVISIBLE (zero-width, hunt-gate.invisibleMark): a human reading the site sees
  // ordinary content, with nothing announcing that a bot wrote it, while `ownsTarget`/`ownsAnyHunt` can
  // still prove the item is ours before any edit or delete. It TRAILS the text — a leading zero-width run
  // can trip a UI that trims or validates the first character.
  const tag = marker ? invisibleMark(marker) : '';
  const seed = `${marker || ''}|${field.name || field.id || field.placeholder || t}`;

  if (t === 'email' || /e-?mail/.test(hint)) return `${pick(FIRST, seed).toLowerCase()}.${pick(LAST, seed).toLowerCase()}@yopmail.com`;
  if (t === 'tel' || /phone|mobile|tel\b/.test(hint)) return '5551234567';
  if (t === 'url' || /website|url|link/.test(hint)) return 'https://example.com';
  if (t === 'number' || /\bamount\b|\bprice\b|\bqty\b|\bquantity\b|\bage\b|\bcount\b/.test(hint)) return '1';
  if (t === 'date' || /date|birth|dob/.test(hint)) return '2026-01-15';
  if (t === 'time') return '12:00';
  if (t === 'password' || /password|passwd/.test(hint)) return 'QaBughunter1!';
  // A search box wants a QUERY, not a sentence — and no mark: a search creates nothing to own.
  if (/search|query|filter/.test(hint)) return pick(['music', 'events', 'travel', 'coffee'], seed);
  if (/first[ _-]?name|fname|given[ _-]?name/.test(hint)) return `${pick(FIRST, seed)}${tag}`;
  if (/last[ _-]?name|lname|surname|family[ _-]?name/.test(hint)) return `${pick(LAST, seed)}${tag}`;
  if (/name|user|handle|nick/.test(hint)) return `${pick(FIRST, seed)} ${pick(LAST, seed)}${tag}`;
  if (/title|subject|headline|group|event/.test(hint)) return `${pick(TITLES, seed)}${tag}`;
  if (/comment|reply/.test(hint)) return `${pick(COMMENTS, seed)}${tag}`;
  if (/message|chat|msg/.test(hint)) return `${pick(MESSAGES, seed)}${tag}`;
  if (/bio|about|description|desc/.test(hint)) return `${pick(BIOS, seed)}${tag}`;
  return `${pick(POSTS, seed)}${tag}`;
}

// Enumerate the fillable fields inside the form (or nearest container) that OWNS the target control, and
// return {selector, value} pairs actStep's prefill accepts. Read-only: it evaluates in the page and
// clicks nothing, so it opens no causal window and forges no edge.
//
// Scope discipline: fields are taken from the target's own <form>, else its nearest sizeable container —
// NOT the whole document. Filling every input on the page would type into unrelated widgets (a search box
// in the header, a chat composer in a sidebar) and attribute their requests to this act.
export async function fieldsFor(page, handle, marker) {
  if (!handle) return [];
  let fields = [];
  try {
    fields = await handle.evaluate((el) => {
      // SCOPE ASCENT. `closest('form')` fails on antd: a submit button routinely sits in
      // `.ant-modal-footer` or a plain `div.ant-row` while the fields live in a sibling subtree, so the
      // old fallback landed on `el.parentElement` — the row of buttons, which contains no fields at all,
      // and the form was submitted empty. Measured live: "Post Ad" had no form/modal/section anywhere in
      // its ancestor chain. So walk UP until an ancestor actually contains a fillable field.
      // Bounded at 6 levels and never past a dialog/form boundary, so we cannot climb into a neighbouring
      // widget and start typing into someone else's search box (whose requests would then be misattributed
      // to this act).
      const FIELDS = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select';
      let scope = el.closest('form') || el.closest('[role="dialog"], .ant-modal, .ant-drawer');
      if (!scope) {
        let p = el.parentElement;
        for (let up = 0; p && up < 6; up++, p = p.parentElement) {
          if (p.querySelector(FIELDS)) { scope = p; break; }
          if (p.matches('form, [role="dialog"], .ant-modal, .ant-drawer, body')) { scope = p; break; }
        }
        scope = scope || el.parentElement;
      }
      if (!scope) return [];
      const out = [];
      const nodes = scope.querySelectorAll(
        'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select',
      );
      // WHAT KIND of field this is — which decides how it can be actuated at all (field-actuate.mjs).
      // The antd branches come first: its Select and DatePicker both present as a READONLY <input>, so a
      // type-only classifier calls them plain text, `fill()` refuses a readonly input, and the required
      // field silently stays empty. That is the measured reason six runs created nothing.
      const kindOf = (f) => {
        const tag = f.tagName.toLowerCase();
        const type = (f.getAttribute('type') || '').toLowerCase();
        if (tag === 'select') return 'native-select';
        if (type === 'file') return 'upload';
        if (type === 'checkbox' || type === 'radio') return 'check';
        if (f.closest('.ant-select')) return 'select';
        if (f.closest('.ant-picker')) return 'date';
        return 'fill';                                          // incl. native date/time inputs, which accept fill()
      };
      // The cap bounds fields we ACCEPT, not nodes we look at. Counting every node meant a form whose
      // early inputs are hidden/disabled/prefilled burned the budget on skips and returned before reaching
      // the required ones — the live Create Event modal has 13 form nodes, so the old cap of 12 examined
      // nodes could not see all of them even in principle.
      for (const f of nodes) {
        if (out.length >= 14) break;                            // bounded: a giant form is not worth 100 fills
        if (f.disabled) continue;
        const kind = kindOf(f);
        // readOnly disqualifies a TEXT field and only a text field — for an antd Select/DatePicker it is
        // the normal resting state, and skipping on it is what dropped every dropdown on this target.
        if (kind === 'fill' && f.readOnly) continue;
        // Never clobber a value the app (or a previous field in this same pass) already put there.
        if (kind === 'fill' && f.value && f.value.trim()) continue;
        if (kind === 'check' && f.checked) continue;
        if ((kind === 'select' || kind === 'date') && f.closest('.ant-select, .ant-picker')
          ?.querySelector('.ant-select-selection-item, .ant-picker-input > input[value]:not([value=""])')) continue;
        const cs = getComputedStyle(f);
        // An antd Upload hides its real <input type=file> behind a styled button, so the visibility gate
        // must not apply to it — the hidden input IS the actuation surface setInputFiles targets.
        if (kind !== 'upload' && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
        // A stable-enough selector to re-find the field from the page root at fill time.
        let sel = null;
        if (f.id) sel = `#${CSS.escape(f.id)}`;
        else if (f.name) sel = `${f.tagName.toLowerCase()}[name="${CSS.escape(f.name)}"]`;
        else if (f.placeholder) sel = `${f.tagName.toLowerCase()}[placeholder="${CSS.escape(f.placeholder)}"]`;
        // Last resort: a positional path from the page root. Weaker than an id, but a field with no id,
        // no name and no placeholder is otherwise silently skipped — and on this target that describes
        // real required inputs, so skipping them guarantees the submit stays empty.
        if (!sel) {
          // Anchored at `body`, and NEVER truncated. A path cut off partway up stops being absolute: it
          // then matches the first structure of that shape ANYWHERE in the document, so a fill aimed at a
          // modal's title lands in some unrelated widget. Measured on the live Create Event modal, whose
          // required fields carry no id, no name and no placeholder — exactly the case this branch exists
          // for — the nesting is deeper than the old 8-segment cap.
          const parts = [];
          for (let n = f; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
            let k = 1;
            for (let sib = n.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === n.tagName) k++;
            parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${k})`);
          }
          sel = parts.length ? `body > ${parts.join(' > ')}` : null;
        }
        if (!sel) continue;                                     // genuinely unaddressable → skip, honestly
        out.push({
          selector: sel,
          kind,
          type: f.getAttribute('type') || (f.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text'),
          name: f.getAttribute('name') || '',
          id: f.id || '',
          placeholder: f.getAttribute('placeholder') || '',
          ariaLabel: f.getAttribute('aria-label') || '',
        });
      }
      return out;
    });
  } catch {
    return [];
  }
  // Only a text field carries a VALUE. A select/date/check/upload is actuated by interaction, and inventing
  // a string for it would put a bogus value in the trail that never reached the page.
  return fields.map((f) => ({
    selector: f.selector,
    kind: f.kind || 'fill',
    value: (f.kind || 'fill') === 'fill' ? valueFor(f, marker) : null,
  }));
}

// True iff this control looks like the thing that SUBMITS a form — the only class worth pre-filling.
// Clicking a nav link or a tab needs no field values, and filling for them would waste time and type
// into whatever container they happen to sit in.
const SUBMIT_RE = /\b(submit|send|post|save|create|add|update|continue|next|apply|confirm|sign\s?up|register|search|publish|share|comment|reply|invite|request)\b/i;
export function looksLikeSubmit({ role = '', name = '', type = '' } = {}) {
  if (type === 'submit') return true;
  if (role !== 'button' && role !== 'generic' && role !== 'link') return false;
  return SUBMIT_RE.test(name || '');
}
