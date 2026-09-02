import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "resolve-server/lib/sanitize-html";

describe("sanitizeHtml", () => {
  it("keeps formatting and strips scripts, handlers, and unsafe links", () => {
    const out = sanitizeHtml('<p onclick="x()">Hi <strong>there</strong><script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://ok.test/path?a=1">ok</a><img src=x onerror=alert(1)></p><ul><li>one</li></ul>');
    expect(out).toBe('<p>Hi <strong>there</strong><a>bad</a><a href="https://ok.test/path?a=1" rel="noopener noreferrer" target="_blank">ok</a></p><ul><li>one</li></ul>');
  });

  it("escapes text content", () => {
    expect(sanitizeHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("closes unbalanced tags and drops style content", () => {
    expect(sanitizeHtml("<p><em>dangling<style>p{color:red}</style>")).toBe("<p><em>dangling</em></p>");
  });

  it("keeps mailto links and caps the output length", () => {
    expect(sanitizeHtml('<a href="mailto:help@ok.test">mail</a>')).toBe('<a href="mailto:help@ok.test" rel="noopener noreferrer" target="_blank">mail</a>');
    expect(sanitizeHtml("x".repeat(250_000))).toHaveLength(200_000);
  });
});
