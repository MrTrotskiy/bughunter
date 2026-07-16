// Small text sanitizers shared across the recon CLIs. Kept in one place so both report.mjs
// and the unreached-analysis helper reuse a SINGLE implementation — no duplication, and no
// import cycle (report.mjs imports the classifier from unreached.mjs, and both import oneLine
// from here, which imports neither).

// Collapse a possibly-untrusted string (a browser error's call log, an agent-derived purpose,
// a page-derived bucket key) to one scannable line: strip C0/C1 control bytes FIRST — an
// ESC/OSC sequence in page-derived text must never reach the operator's terminal raw — then
// collapse whitespace and cap the length. `\p{Cc}` is the Unicode Control category (exactly
// U+0000–U+001F plus U+007F–U+009F), so the source itself stays free of literal control bytes.
export function oneLine(s, cap = 100) {
  const flat = String(s).replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > cap ? flat.slice(0, cap - 1) + '…' : flat;
}
