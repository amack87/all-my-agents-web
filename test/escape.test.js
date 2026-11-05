import test from "node:test";
import assert from "node:assert/strict";
import { esc } from "../public/escape.js";

// The point of these tests is that a value coming from another machine cannot
// break out of the markup it is interpolated into. Session names, agent names
// and machine names all arrive over the mesh from peers.

test("escapes the characters that would otherwise become markup", () => {
  assert.equal(esc("<script>"), "&lt;script&gt;");
  assert.equal(esc("a & b"), "a &amp; b");
});

test("escapes a double quote so it cannot close an attribute", () => {
  assert.equal(esc('x" onmouseover="alert(1)'), "x&quot; onmouseover=&quot;alert(1)");
});

test("escapes a single quote so it cannot close an attribute", () => {
  assert.equal(esc("x' onmouseover='alert(1)"), "x&#39; onmouseover=&#39;alert(1)");
});

test("escapes the ampersand before the other entities, so nothing double-escapes", () => {
  // &lt; must not become &amp;lt;, which would render as the text "&lt;".
  assert.equal(esc("&lt;"), "&amp;lt;");
});

test("null and undefined become the empty string", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
});

test("a falsy value that is not null is still rendered", () => {
  // A session may legitimately be named "0". Swallowing it would hide the
  // session from the sidebar.
  assert.equal(esc(0), "0");
  assert.equal(esc(false), "false");
  assert.equal(esc(""), "");
});

test("a non-string is stringified rather than dropped", () => {
  assert.equal(esc(42), "42");
});

test("plain text is left alone", () => {
  assert.equal(esc("slice"), "slice");
});
