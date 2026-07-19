// FIELD ACTUATE — typed actuation for the fields a create-form actually contains.
//
// Measured on the live target crawl: the submit click on "Create Event" DID happen, the causal window
// DID open, and the only request that ever left was `get_status_detail` — the modal's own load. The form
// was rejected by client-side validation because its REQUIRED fields were never filled. Not because we
// failed to find them: because we only knew ONE way to put a value into a field.
//
// `fill()` covers `<input type=text>` and `<textarea>`. It covers nothing else, and an antd form is mostly
// something else:
//   - Select   → `span.ant-select-selection-search > input`, which is READONLY. form-fill skipped it.
//   - DatePicker → same readonly-input shape, value set by picking a cell, not by typing.
//   - Upload   → `input[type=file]`, which `fill()` cannot touch at all.
//   - Checkbox/radio → `fill()` is meaningless; they need checked state.
// Playwright has four distinct APIs for these (fill / selectOption / setChecked / setInputFiles) plus the
// click-the-portal dance antd needs. Using one of them and calling the form "covered" is how six runs
// produced zero created entities.
//
// Everything here acts INSIDE the scope form-fill already resolved, and every step is bounded — a widget
// that does not respond in seconds is skipped so the act still reaches its click, rather than stalling the
// crawl on Playwright's 30s default actionability timeout.

import fs from 'node:fs';
import { SELECT_POPUP, PICKER_POPUP } from '../graph/widget-popup.mjs';
import path from 'node:path';

const T = 3000;                                    // per-interaction ceiling; a slow widget is skipped, not waited on

// antd renders dropdowns into a PORTAL at <body>, not inside the field. The `:not(...-hidden)` guard
// matters: a closed dropdown stays in the DOM, so without it we would click an invisible stale option
// belonging to a different field.
// Composed from the SHARED container list (widget-popup.mjs) so actuation and frontier-exclusion can never
// disagree about what a widget popup is. The two use it for opposite purposes and both are required: the
// frontier must never hand out a day cell as a control to cover, and actuation must click exactly that cell
// to set the field. One list, two consumers.
const OPEN_SELECT = `${SELECT_POPUP}:not(${SELECT_POPUP}-hidden)`;
const OPEN_PICKER = `${PICKER_POPUP}:not(${PICKER_POPUP}-hidden)`;
const OPTION = `${OPEN_SELECT} .ant-select-item-option:not(.ant-select-item-option-disabled)`;
const DAY_CELL = `${OPEN_PICKER} td.ant-picker-cell-in-view:not(.ant-picker-cell-disabled)`;
const TIME_CELL = `${OPEN_PICKER} .ant-picker-time-panel-cell:not(.ant-picker-time-panel-cell-disabled)`;
const OK_BTN = `${OPEN_PICKER} .ant-picker-ok button`;

// A 1×1 transparent PNG. Deliberately the smallest valid image: this is recon reaching a validation gate,
// not an upload test. If a target rejects it on dimensions, the trail records the rejection — which is a
// finding, not a silent skip.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Materialize the upload fixture once per run, under the run's own state dir — never in the repo.
function fixtureImage(stateDir) {
  const dir = stateDir || path.join(process.cwd(), 'state');
  const file = path.join(dir, 'upload-fixture.png');
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, Buffer.from(PNG_1X1, 'base64'));
    }
    return file;
  } catch {
    return null;
  }
}

// Click the first offered option of an antd Select. WHICH option is irrelevant for recon — the point is to
// satisfy a required field so the form can submit; picking the first is deterministic and reproducible.
async function actuateSelect(page, handle) {
  await handle.click({ timeout: T }).catch(() => null);
  const opt = await page.waitForSelector(OPTION, { timeout: T, state: 'visible' }).catch(() => null);
  if (!opt) return false;
  await opt.click({ timeout: T }).catch(() => null);
  return true;
}

// A native <select>. Index 1 skips the conventional placeholder option; index 0 is the fallback for a
// select that has no placeholder.
async function actuateNativeSelect(handle) {
  const n = await handle.evaluate((el) => el.options?.length || 0).catch(() => 0);
  if (n === 0) return false;
  const idx = n > 1 ? 1 : 0;
  const done = await handle.selectOption({ index: idx }, { timeout: T }).then(() => true).catch(() => false);
  return done;
}

// antd DatePicker / TimePicker. The value is set by CLICKING a cell in the portal panel, never by typing:
// the visible input is readonly. A datetime picker additionally gates its value behind an OK button, and
// skipping that leaves the field visually filled but empty in form state — the exact failure this module
// exists to stop.
async function actuatePicker(page, handle) {
  await handle.click({ timeout: T }).catch(() => null);
  const day = await page.waitForSelector(DAY_CELL, { timeout: T, state: 'visible' }).catch(() => null);
  if (day) await day.click({ timeout: T }).catch(() => null);
  else {
    const time = await page.$(TIME_CELL).catch(() => null);
    if (!time) return false;
    await time.click({ timeout: T }).catch(() => null);
  }
  const ok = await page.$(OK_BTN).catch(() => null);
  if (ok) await ok.click({ timeout: T }).catch(() => null);
  return true;
}

async function actuateCheck(handle) {
  return handle.setChecked(true, { timeout: T }).then(() => true).catch(() => false);
}

async function actuateUpload(handle, stateDir) {
  const file = fixtureImage(stateDir);
  if (!file) return false;
  return handle.setInputFiles(file, { timeout: T }).then(() => true).catch(() => false);
}

// Plain text. Kept here so every kind goes through ONE dispatcher and a new kind cannot be added in one
// place and forgotten in another.
async function actuateFill(handle, value) {
  return handle.fill(String(value ?? ''), { timeout: T }).then(() => true).catch(() => false);
}

// Put a value into ONE discovered field, by its kind. Returns whether the field was actuated — the caller
// records that, so a form that submits empty is attributable to a specific unactuated field rather than to
// "validation, probably".
export async function actuateField(page, handle, field, { stateDir } = {}) {
  if (!handle || !field) return false;
  switch (field.kind) {
    case 'select': return actuateSelect(page, handle);
    case 'native-select': return actuateNativeSelect(handle);
    case 'date': return actuatePicker(page, handle);
    case 'check': return actuateCheck(handle);
    case 'upload': return actuateUpload(handle, stateDir);
    case 'fill':
    default: return actuateFill(handle, field.value);
  }
}

// Apply a whole prefill set, in document order. Best-effort per field: one unresolvable selector must not
// abort the rest, because a partially-filled form still tells us MORE than an empty one — the validation
// error it raises names the field we failed to reach.
export async function actuateAll(page, fields, { stateDir } = {}) {
  const out = { attempted: 0, actuated: 0, skipped: [] };
  if (!Array.isArray(fields)) return out;
  for (const f of fields) {
    if (!f || !f.selector) continue;
    out.attempted++;
    const h = await page.$(f.selector).catch(() => null);
    if (!h) { out.skipped.push({ selector: f.selector, why: 'unresolved' }); continue; }
    const ok = await actuateField(page, h, f, { stateDir });
    if (ok) out.actuated++;
    else out.skipped.push({ selector: f.selector, why: `kind:${f.kind || 'fill'}` });
  }
  return out;
}
