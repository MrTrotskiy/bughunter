// WIDGET POPUP CONTAINERS — the ONE list, shared by the two subsystems that must never disagree about
// what a widget popup is: `dom-snapshot` (which flags its contents non-frontier) and `field-actuate`
// (which drives those same contents to set a field's value).
//
// The two roles are opposite and both are required. A date picker's panel is NOT application surface —
// nobody "covers" `Choose a decade`, they pick a date — so its chrome must never become a coverage
// obligation. But actuating a date field means clicking a day cell INSIDE that same panel, which is the
// INC.6 typed-actuation fix that finally let a form submit at all. So: excluded from the FRONTIER,
// untouched by ACTUATION. Two lists would drift and silently break one side or the other, which is the
// same argument `explore-policy.mjs` was created to settle for the operator's rule set.
//
// AntD-specific, and honestly so. The container detection does not generalise — there is no reliable ARIA
// signal tying a portal panel back to the field that owns it. What DOES generalise is the discriminator
// applied on top (see dom-snapshot): a portal MENU (role=menuitem — a row's Edit/Delete/Share) is genuine
// application surface and is never excluded, while a picker/select panel is chrome. Measured on the live
// graph: 55 chrome templates (button/generic, 0 requests ever fired) vs 31 portal-menu templates
// (menuitem/menu, 6 requests) — role overlap between the two sets is ZERO.
//
// The rule FAILS OPEN by construction: an unrecognised widget stays a coverage obligation rather than
// vanishing. Adding a framework means adding one line here, and nothing else changes.

export const SELECT_POPUP = '.ant-select-dropdown';
export const PICKER_POPUP = '.ant-picker-dropdown';

export const WIDGET_POPUP_CONTAINERS = [SELECT_POPUP, PICKER_POPUP];

// The selector form used inside page.evaluate (`closest`) — a single comma-joined list.
export const WIDGET_POPUP_SELECTOR = WIDGET_POPUP_CONTAINERS.join(',');
