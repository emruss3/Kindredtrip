/* KindredTrips — partner descriptions as safe, readable text.
 *
 * LiteAPI resort descriptions often arrive as HTML ("<p><strong>Dining</strong>
 * <br>…</p>", "&amp;"). Escaping them shows the tags as text; inserting them
 * raw trusts a third party with our page. This keeps a short allowlist of
 * formatting tags — with no attributes — and escapes everything else:
 *
 *   richText(html)  -> HTML with only <p> <br> <strong> <b> <em> <i> <ul> <ol> <li>
 *   plainText(html) -> text only (for previews), paragraphs separated by blank lines
 *
 * Entities (&amp; &quot; &#39; &nbsp; numeric) are decoded first, then the
 * whole string is escaped, then only bare allowlisted tags are restored, so
 * no attribute, script or other markup can survive. Importable from Node tests.
 */
(function (root) {
  "use strict";
  var ALLOWED = "p|br|strong|b|em|i|ul|ol|li";

  function decodeEntities(s) {
    return String(s == null ? "" : s)
      .replace(/&#(\d+);/g, function (_, n) { var c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; })
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { var c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; })
      .replace(/&nbsp;/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&apos;|&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function richText(html) {
    var escaped = escapeHtml(decodeEntities(html).trim());
    var tag = new RegExp("&lt;(\\/?)(" + ALLOWED + ")\\s*\\/?&gt;", "gi");
    var out = escaped.replace(tag, function (_, slash, name) { return "<" + slash + name.toLowerCase() + ">"; });
    // Plain text with no paragraph tags: keep the author's line breaks.
    if (!/<(p|ul|ol|br)>/.test(out)) out = out.replace(/\r?\n/g, "<br>");
    return out;
  }

  function plainText(html) {
    var s = String(html == null ? "" : html)
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/\s*(p|li|ul|ol)\s*>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "• ")
      .replace(/<[^>]*>/g, "");
    return decodeEntities(s)
      .split("\n").map(function (l) { return l.replace(/[ \t]+/g, " ").trim(); })
      .join("\n").replace(/\n{2,}/g, "\n").trim();
  }

  var api = { richText: richText, plainText: plainText, decodeEntities: decodeEntities };
  root.KTRichText = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
