import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "resolve-server/lib/sanitize-html";

describe("sanitizeHtml", () => {
  it("keeps formatting and strips scripts, handlers, and unsafe links", () => {
    const out = sanitizeHtml(
      '<p onclick="x()">Hi <strong>there</strong><script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://ok.test/path?a=1">ok</a><img src=x onerror=alert(1)></p><ul><li>one</li></ul>',
    );
    expect(out).toBe(
      '<p>Hi <strong>there</strong><a>bad</a><a href="https://ok.test/path?a=1" rel="noopener noreferrer" target="_blank">ok</a></p><ul><li>one</li></ul>',
    );
  });

  it("escapes text content", () => {
    expect(sanitizeHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("closes unbalanced tags and drops style content", () => {
    expect(sanitizeHtml("<p><em>dangling<style>p{color:red}</style>")).toBe("<p><em>dangling</em></p>");
  });

  it("keeps mailto links", () => {
    expect(sanitizeHtml('<a href="mailto:help@ok.test">mail</a>')).toBe(
      '<a href="mailto:help@ok.test" rel="noopener noreferrer" target="_blank">mail</a>',
    );
  });

  it("decodes an entity-encoded href exactly once so query strings survive a round trip", () => {
    const once = sanitizeHtml('<a href="https://ok.test/?a=1&amp;b=2">q</a>');
    expect(once).toBe('<a href="https://ok.test/?a=1&amp;b=2" rel="noopener noreferrer" target="_blank">q</a>');
    // Re-sanitizing stored output must be a no-op rather than growing another &amp;.
    expect(sanitizeHtml(once)).toBe(once);
  });

  it("rejects a scheme smuggled through a character reference", () => {
    expect(sanitizeHtml('<a href="java&#x09;script:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="java&#9;script:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("caps the escaped output, not just the input, and still closes its tags", () => {
    const out = sanitizeHtml(`<p>${"&".repeat(200_000)}</p>`);
    expect(out.length).toBeLessThanOrEqual(200_000 + 64);
    expect(out.startsWith("<p>")).toBe(true);
    expect(out.endsWith("</p>")).toBe(true);
    // Truncation must not leave a half-written entity behind.
    expect(out.slice(0, -4).endsWith("&amp;")).toBe(true);
  });
});
