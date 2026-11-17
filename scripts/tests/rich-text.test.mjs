import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const R = createRequire(import.meta.url)("../../rich-text.js");

// The Simpson Bay description from the bug report, as LiteAPI sends it.
const simpson = "<p><strong>Luxurious Beachfront Property</strong><br>The Simpson Bay Resort, Marina &amp; Spa offers a lavish stay on Simpson Bay Beach with 5 outdoor pools.</p><p>Ready to experience it? Book your stay at Simpson Bay Resort, Marina &amp; Spa now.</p>";

test("partner formatting renders as formatting, not visible tags", () => {
  const html = R.richText(simpson);
  assert.equal(html,
    "<p><strong>Luxurious Beachfront Property</strong><br>The Simpson Bay Resort, Marina &amp; Spa offers a lavish stay on Simpson Bay Beach with 5 outdoor pools.</p><p>Ready to experience it? Book your stay at Simpson Bay Resort, Marina &amp; Spa now.</p>");
  assert.ok(!html.includes("&lt;"));
  assert.ok(!html.includes("&amp;amp;"));
});

test("lists are kept", () => {
  assert.equal(R.richText("<ul><li>Pool</li><li>Spa</li></ul>"), "<ul><li>Pool</li><li>Spa</li></ul>");
});

test("anything outside the allowlist is escaped, attributes never survive", () => {
  const out = R.richText('<p onclick="x()">Hi</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:1">l</a>');
  // No live tag other than bare allowlisted ones; no tag carries attributes.
  assert.ok(!/<(script|img|a)\b/i.test(out));
  assert.ok(!/<[a-z]+\s[^>]*>/i.test(out));
  assert.ok(out.includes("&lt;script&gt;"));
  // Encoded markup can't sneak back in as live tags either.
  assert.ok(!/<script/i.test(R.richText("&lt;script&gt;alert(1)&lt;/script&gt;")));
});

test("plain-text descriptions keep their line breaks", () => {
  assert.equal(R.richText("Line one\nLine two & more"), "Line one<br>Line two &amp; more");
});

test("plain-text preview drops tags and decodes entities", () => {
  assert.equal(R.plainText(simpson),
    "Luxurious Beachfront Property\nThe Simpson Bay Resort, Marina & Spa offers a lavish stay on Simpson Bay Beach with 5 outdoor pools.\nReady to experience it? Book your stay at Simpson Bay Resort, Marina & Spa now.");
  assert.equal(R.plainText("<ul><li>Pool</li><li>Spa</li></ul>"), "• Pool\n• Spa");
});
