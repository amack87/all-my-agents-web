// HTML escaping for values interpolated into markup.
//
// `esc` is used in two places: as text content and inside an attribute value.
// Escaping only < > & is enough for text, but NOT for an attribute — a value
// containing a double quote closes the attribute and everything after it
// becomes markup.
//
// That is not hypothetical. A session name, agent name or machine name can
// arrive from a peer machine over the mesh, and AMA renders those straight
// into attributes such as data-name="...". A peer that reports a session
// named `x" onmouseover="...` would otherwise run script in the AMA origin —
// and the AMA origin is on the allowlist, so that script can then drive the
// API. See docs/adr/0005-origin-allowlist.md.
//
// Pure and DOM-free so it can be unit tested. The previous implementation
// built a <span> and read its innerHTML, which escaped < > & but left quotes
// untouched — and could not be tested without a DOM.

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 * null and undefined become the empty string; everything else is stringified
 * first, so 0 and false are rendered rather than swallowed.
 */
export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}
