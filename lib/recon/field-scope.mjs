// FIELD SCOPE — the field's OWN validation region, so a field can answer without being submitted.
//
// THE PROBLEM. A field's battery asks what it accepts, and the received wisdom (our own `probe-battery.mjs`
// header included) is that a field answers nothing on its own: typing 51 characters into a field declaring
// 50 produces no request and no error, and the answer exists only after a COMMIT. That is true of the
// SERVER's opinion. It is not true of the CLIENT's — and the client is where the declared constraints live.
//
// Measured on run probe9: four textboxes were filled successfully and recorded `inert` — "Search Community",
// "Search your connections", "Group Name", "Search Rawcaster". Nothing was wrong with the fill. They simply
// have nothing to commit to, so under a commit-only model they can never leave L2.
//
// WHY NOT FIND THE COMMIT. Because for most of these fields there is no commit control to find, and because
// the search says nobody has solved field→commit on nameless markup: the classical crawlers (HiWE, the
// Google deep-web crawl, LabelEx, OPAL) all take the submit for free out of `<form action>` and solve only
// label→field; the LLM agents don't solve it either, they press Enter and hope (WebArena literally appends
// "\n"). Building the oracle nobody has is a poor trade when the client will answer directly.
//
// WHAT THIS READS INSTEAD. AntD's `Form.Item` validates on `validateTrigger`, which defaults to `onChange` —
// confirmed from the framework's own source, not inferred — so the error node is in the DOM after a fill and
// a blur, with no submit anywhere. `observables.readOutcome` already reads all three refusal tiers and
// already takes a `scope`. Nothing was calling it scoped to ONE field's own region, which is the whole gap.
//
// SCOPE, NOT PAGE. Page-scoped is the bug this avoids: another field's leftover error would be read as this
// field's answer — the same borrowed-evidence fallacy that made one toast the recorded outcome of three
// separate acts. The region is the field's own `.ant-form-item` / label wrapper, and when there is no such
// region the honest answer is that the field has no local validation region, not that it said nothing.

// The selector for the field's own validation region, or null when it has none. Read-only; opens no causal
// window and mutates nothing. Returns a selector rather than a handle so the caller can hand it straight to
// `readOutcome`'s `scope`.
export async function fieldScopeSelector(page, handle) {
  if (!handle) return null;
  try {
    return await handle.evaluate((el) => {
      // Ordered widest-precision-first: a framework form item, then a native label/fieldset association.
      const region = el.closest('.ant-form-item, .form-item, .field, [role="group"]')
        || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.closest('div,fieldset,li'))
        || el.closest('label')
        || null;
      if (!region) return null;
      // Mint a one-shot addressable handle for it. A data attribute is used deliberately: it is scoped to
      // this read, it is removed by nobody because it is overwritten on the next read, and it never enters
      // identity — dom-snapshot reads attributes, so the name is namespaced and stable rather than random,
      // which keeps a template selector from churning if one is ever captured mid-read.
      region.setAttribute('data-bh-scope', '1');
      for (const other of document.querySelectorAll('[data-bh-scope]')) {
        if (other !== region) other.removeAttribute('data-bh-scope');
      }
      return '[data-bh-scope]';
    });
  } catch {
    return null;
  }
}

// Commit the value the browser is holding, WITHOUT submitting anything: blur the field so change/blur-driven
// validation runs. This is a UI op under `__idle__` — it fires no request of its own and opens no causal
// window. A field that validates on neither trigger simply stays silent, which the caller reads as "no local
// answer" rather than as an answer.
export async function settleField(page, handle) {
  if (!handle) return false;
  try {
    await handle.evaluate((el) => {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (typeof el.blur === 'function') el.blur();
    });
    return true;
  } catch {
    return false;
  }
}
