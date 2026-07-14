// Structured failure envelope for the test-SDK runtime and lib/*.mjs CLIs.
// One JSON-line shape, one exit-code enum, one source of truth.
//
// Exit codes follow sysexits.h to avoid collision with node's own 1/3.
//
// Stream routing convention (decisions.md 2026-05-21):
//   - Result envelope (PASS / VIOLATION)  → stdout
//   - Startup-error envelope (USAGE/ENV)  → stderr
// Exit code carries the OK/not-OK signal; stream signals "structured
// result produced" vs "CLI failed to run". Matches kubectl / gh / jq.

export const EXIT = Object.freeze({
  OK: 0,
  VIOLATION: 2,
  USAGE: 64,
  ENV: 78,
});

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const FIX_ACTIONS = new Set(['run-cli', 'edit-file', 'refresh-artefact', 'manual']);

export function makeEnvelope({ code, message, target = null, fix = [], exit = 'VIOLATION' } = {}) {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    throw new TypeError(`envelope: code must match ${CODE_PATTERN}, got "${code}"`);
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('envelope: message must be non-empty string');
  }
  if (!(exit in EXIT)) {
    throw new TypeError(`envelope: exit must be one of ${Object.keys(EXIT).join('|')}, got "${exit}"`);
  }
  if (!Array.isArray(fix)) {
    throw new TypeError('envelope: fix must be array');
  }
  for (const entry of fix) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('envelope: each fix entry must be an object');
    }
    if (!FIX_ACTIONS.has(entry.action)) {
      throw new TypeError(`envelope: fix.action must be one of ${[...FIX_ACTIONS].join('|')}, got "${entry.action}"`);
    }
  }
  return { code, message, target, fix, exit };
}

export function envelopeToLine(env) {
  return JSON.stringify(env);
}

export function exitCode(envOrName) {
  const name = typeof envOrName === 'string' ? envOrName : envOrName?.exit;
  return EXIT[name] ?? EXIT.VIOLATION;
}

// Convenience: build an Error whose `.envelope` carries the structured shape.
// Callers throw the Error normally; downstream handlers introspect `.envelope`.
export function envelopeError(opts) {
  const env = makeEnvelope(opts);
  const err = new Error(env.message);
  err.envelope = env;
  err.code = env.code;
  return err;
}
