// PURE, I/O-free redaction for captured request/response bodies — the security-critical core
// of body capture. No browser, no disk: it takes a raw body string + content-type and returns a
// redacted, size-capped string, so raw secrets never persist. Unit-tested (tests/unit/redact.test.mjs).
//
// TWO defenses, both mandatory:
//   1. Redaction — KEY-level (secret-named keys, incl. a bare `…_key`/`…_token` segment →
//      [REDACTED]) AND VALUE-level (every string leaf scrubbed for JWT / Bearer / AWS / Stripe /
//      GitHub / Slack / Google / card / SSN / email, and a card-shaped number leaf), so a secret
//      in a VALUE under an innocent key is still caught. Form-urlencoded is walked STRUCTURALLY.
//   2. Bounded work — the raw input is hard-truncated to a WORK_BOUND before any parse/regex, and
//      every pattern is LINEAR (upper-bounded quantifiers), so there is no ReDoS. The OUTPUT cap
//      is applied AFTER redaction, so a secret straddling it is fully redacted, never cut mid-token.

// The OUTPUT cap: applied to the REDACTED string (after redaction), so a matched secret is
// always fully replaced before any cut. The DoS WORK_BOUND is a separate, larger hard-truncate
// on the RAW input (bounds memory + linear-regex work); only a >1 MB extreme is cut pre-redaction.
export const BODY_CAP = 64 * 1024;
const WORK_BOUND = 1024 * 1024;
const REDACTED = '[REDACTED]';
const TRUNC_MARK = '…[truncated]';

// Secret-KEY vocabulary (case-insensitive, whole-word after normalization). A JSON/form key
// whose NAME matches has its value replaced. Words are matched with \b boundaries against a
// normalized key (camelCase/snake/kebab → spaces), so `apiKey`/`api_key`/`api-key` all hit
// `api key` while short words (pin/pan/sid/auth) do NOT match inside `shipping`/`author`.
const SECRET_WORDS = [
  'password', 'passwd', 'pwd', 'secret', 'secret key', 'secret access key', 'access token',
  'refresh token', 'id token', 'token', 'jwt', 'bearer', 'api key', 'apikey', 'authorization',
  'auth', 'set cookie', 'cookie', 'session id', 'sessionid', 'session', 'sid', 'csrf', 'xsrf',
  'otp', 'totp', 'mfa', 'pin', 'credential', 'private key', 'client secret', 'cvv', 'cvc',
  'card number', 'pan', 'ssn', 'aws access key id', 'aws secret access key',
];
const SECRET_KEY_RE = new RegExp('\\b(?:' + SECRET_WORDS.join('|').replace(/ /g, '\\s+') + ')\\b', 'i');
// A key whose FINAL (or any) normalized SEGMENT is exactly one of these is secret even without a
// qualifier — `stripe_key` / `encryption_key` / `session_token` — while `keyboard` / `tokenizer` /
// `monkey` do NOT match (segment equality, not substring).
const SEGMENT_SECRETS = new Set(['key', 'token', 'secret', 'password', 'credential']);
// Identity/PII keys masked ONLY in form request bodies (the credential POST buffers username/
// email/login) — not globally, so a profile response's `user` object is not blanket-redacted.
const IDENTITY_WORDS = ['username', 'user name', 'user', 'userid', 'user id', 'uid', 'login', 'email', 'e mail'];
const IDENTITY_KEY_RE = new RegExp('\\b(?:' + IDENTITY_WORDS.join('|').replace(/ /g, '\\s+') + ')\\b', 'i');

// VALUE-level high-confidence patterns, applied to every string leaf. ALL LINEAR: every
// quantifier is UPPER-BOUNDED (no unbounded `+`/`*` that backtracks O(n²) on a long non-matching
// run — e.g. a 64 KB word-run with no `@` used to make an unbounded email local-part quadratic).
const JWT_RE = /eyJ[A-Za-z0-9_-]{1,4000}\.[A-Za-z0-9_-]{1,4000}\.[A-Za-z0-9_-]{1,4000}/g;
const BEARER_RE = /Bearer\s{1,8}[^\s]{1,4000}/gi;
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g; // 13–19 digit runs (optional space/dash groups)
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g; // PII — redact by default (local trail)
// Opaque PROVIDER credentials (linear, upper-bounded). pk_ (publishable) is intentionally NOT
// matched. A stringified 13–19 digit integer card number is handled at the number leaf (L4).
const STRIPE_RE = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,4000}/g;
const GITHUB_RE = /\bgh[posru]_[A-Za-z0-9]{20,4000}/g;
const SLACK_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,4000}/g;
const GOOGLE_API_RE = /\bAIza[0-9A-Za-z_-]{35}/g;

function normalizeMime(mimeType) {
  if (typeof mimeType !== 'string') return '';
  return mimeType.split(';')[0].trim().toLowerCase();
}

// Normalize a key so camelCase/snake/kebab spellings all expose their words to \b patterns. The
// ACRONYM split (`API`+`Token`) runs BEFORE the lower-upper split, so `APIToken`/`AUTHToken` (an
// all-caps run has no lower-upper boundary) become `api token`/`auth token`, not `apitoken`.
function normalizeKey(key) {
  return String(key)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // acronym boundary: APIToken → API Token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // camelCase: authToken → auth Token
    .replace(/[_\-]+/g, ' ')                      // snake / kebab
    .toLowerCase();
}
function keyIsSecret(key, extraRe) {
  const norm = normalizeKey(key);
  if (SECRET_KEY_RE.test(norm)) return true;
  if (norm.split(/\s+/).some((seg) => SEGMENT_SECRETS.has(seg))) return true; // bare key/token/secret segment
  return extraRe ? extraRe.test(norm) : false;
}

// The response content-type allowlist: JSON and text/* (which carry endpoint shape), EXCEPT
// text/html (whole pages — huge, low value). Everything else (binary/image) → false.
export function bodyAllowed(mimeType) {
  const m = normalizeMime(mimeType);
  if (!m) return false;
  if (m === 'text/html') return false;
  if (m === 'application/json') return true;
  if (/^application\/[\w.+-]*\+json$/.test(m)) return true;
  return m.startsWith('text/');
}

// Scrub a single string for value-level secrets (linear patterns only).
//
// Also exported as `redactText` for consumers that handle plain text rather than a typed HTTP body —
// the `browse` skill scrubs subprocess stdout/stderr before it reaches the transcript. Same patterns,
// no mime dispatch, no cap: a caller holding loose text gets exactly the value-level scrubbing, and
// there is ONE secret-pattern list rather than a second one drifting in a skill.
function redactString(s) {
  if (typeof s !== 'string' || s === '') return s;
  return s
    .replace(JWT_RE, REDACTED)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(AWS_KEY_RE, REDACTED)
    .replace(STRIPE_RE, REDACTED)
    .replace(GITHUB_RE, REDACTED)
    .replace(SLACK_RE, REDACTED)
    .replace(GOOGLE_API_RE, REDACTED)
    .replace(SSN_RE, REDACTED)
    .replace(CARD_RE, REDACTED)
    .replace(EMAIL_RE, REDACTED);
}

// A 13–19 digit integer is almost never a legitimate business value → treat a number leaf like a
// card/SSN-shaped string (JSON numbers carry no dashes, so only the digit-run form applies).
function redactNumber(val) {
  return (Number.isInteger(val) && /^\d{13,19}$/.test(String(val))) ? REDACTED : val;
}

// Deep-walk parsed JSON: a secret-named KEY → [REDACTED]; every string LEAF is value-scrubbed and
// a number leaf is card/SSN-checked.
function redactValue(val) {
  if (typeof val === 'string') return redactString(val);
  if (typeof val === 'number') return redactNumber(val);
  if (Array.isArray(val)) return val.map(redactValue);
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = keyIsSecret(k) ? REDACTED : redactValue(v);
    return out;
  }
  return val;
}

// JSON (or JSON-looking) text: parse → walk → re-serialize; on parse failure, scrub as text.
function redactJsonOrText(raw) {
  const t = raw.trimStart();
  if (t[0] === '{' || t[0] === '[') {
    try { return JSON.stringify(redactValue(JSON.parse(raw))); } catch { /* fall through */ }
  }
  return redactString(raw);
}

// application/x-www-form-urlencoded: STRUCTURAL walk (no regex over the whole body). A secret-
// or identity-named key → [REDACTED]; other values are value-scrubbed. Keys/values are kept
// decoded for trail readability (byte-fidelity is not needed for a diagnostic).
function redactForm(raw) {
  let params;
  try { params = new URLSearchParams(raw); } catch { return redactString(raw); }
  const out = [];
  for (const [k, v] of params) {
    out.push(`${k}=${keyIsSecret(k, IDENTITY_KEY_RE) ? REDACTED : redactString(v)}`);
  }
  return out.join('&');
}

function capString(s, cap) {
  const str = String(s);
  if (!Number.isFinite(cap) || str.length <= cap) return str;
  return str.slice(0, Math.max(0, cap - TRUNC_MARK.length)) + TRUNC_MARK;
}

// WORK-BOUND (pre-parse) → REDACT the whole ≤1 MB body → OUTPUT-CAP. Redaction runs on the full
// work-bounded body BEFORE the output cut, so a secret straddling the 64 KB output boundary is
// fully [REDACTED] rather than cut mid-token (its surviving prefix would otherwise leak). Only a
// >1 MB extreme is hard-truncated before redaction (bounds memory + linear-regex work).
export function redactBody(raw, mimeType, { cap = BODY_CAP } = {}) {
  if (typeof raw !== 'string' || raw === '') return '';
  const workTruncated = raw.length > WORK_BOUND;
  const work = workTruncated ? raw.slice(0, WORK_BOUND) : raw;
  const m = normalizeMime(mimeType);
  const redacted = m === 'application/x-www-form-urlencoded' ? redactForm(work) : redactJsonOrText(work);
  let out = capString(redacted, cap); // stamps TRUNC_MARK when redaction still left it over the cap
  if (workTruncated && !out.endsWith(TRUNC_MARK)) out = out.slice(0, Math.max(0, cap - TRUNC_MARK.length)) + TRUNC_MARK;
  return out;
}

export { redactString as redactText };
