// Rich replies are stored as HTML and forwarded to the mail provider, so the
// markup an agent submits is re-rendered inside somebody else's inbox. Rather
// than filtering known-bad markup, this tokenizer rebuilds the document from an
// allow-list: only the tags below survive, every attribute except a safe `href`
// is discarded, and all remaining text is entity-escaped.
const allowedTags = new Set(["p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li", "a"]);
const voidTags = new Set(["br"]);
const rawTextTags = new Set(["script", "style"]);
const safeSchemes = /^(https?:|mailto:)/i;
const namedEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" };
const maxInput = 200_000;
const maxOutput = 200_000;

export function sanitizeHtml(input: string): string {
  const source = input.slice(0, maxInput);
  const openTags: string[] = [];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let out = "";
  let last = 0;
  // `script` and `style` hold raw text rather than markup, so their contents are
  // dropped along with the tags instead of being escaped into the output.
  let skipping = "";
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(source))) {
    // Escaping can quintuple a chunk's length, so the budget is enforced on the
    // output rather than the input. Text is truncated to fit and the pass stops;
    // the open-tag stack is still flushed below, so the result stays balanced.
    if (!skipping) {
      const text = escapeText(source.slice(last, match.index));
      if (out.length + text.length > maxOutput) { out += truncateEscaped(text, maxOutput - out.length); break; }
      out += text;
    }
    last = tagPattern.lastIndex;
    const name = match[1].toLowerCase();
    const closing = match[0].startsWith("</");
    if (rawTextTags.has(name)) {
      if (closing) { if (skipping === name) skipping = ""; }
      else if (!skipping) skipping = name;
      continue;
    }
    if (skipping || !allowedTags.has(name)) continue;
    // A closing tag only spends budget the pending flush had already reserved.
    if (closing) {
      if (openTags.lastIndexOf(name) >= 0) {
        while (openTags.length) {
          const top = openTags.pop()!;
          out += `</${top}>`;
          if (top === name) break;
        }
      }
      continue;
    }
    const tag = name === "a" ? openAnchor(match[2]) : `<${name}>`;
    // A tag is emitted whole or not at all; a partial one would be malformed.
    if (out.length + tag.length > maxOutput) break;
    out += tag;
    if (!voidTags.has(name)) openTags.push(name);
  }
  if (!skipping && out.length < maxOutput) {
    const text = escapeText(source.slice(last));
    out += out.length + text.length > maxOutput ? truncateEscaped(text, maxOutput - out.length) : text;
  }
  while (openTags.length) out += `</${openTags.pop()}>`;
  return out;
}

function openAnchor(attributes: string) {
  const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
  // Editors paste hrefs that are already entity-encoded, so the value is decoded
  // exactly once before the scheme check and re-escaped exactly once on the way
  // out — otherwise `?a=1&amp;b=2` would grow another `&amp;` on every round trip.
  // Decoding cannot smuggle a scheme past the check: `java&#x09;script:` decodes
  // to a tab inside the scheme, and an allow-list of `http(s):` and `mailto:`
  // rejects it either way.
  const value = stripControls(decodeEntities(href?.[2] ?? href?.[3] ?? href?.[4] ?? "")).trim();
  return safeSchemes.test(value) ? `<a href="${escapeAttribute(value)}" rel="noopener noreferrer" target="_blank">` : "<a>";
}

// Browsers drop control characters from a URL before resolving it, so the same
// characters are dropped here and the stored href matches what a client follows.
function stripControls(value: string) {
  return [...value].filter((character) => { const code = character.codePointAt(0) ?? 0; return code > 0x1f && code !== 0x7f; }).join("");
}

function decodeEntities(value: string) {
  return value.replace(/&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z][a-zA-Z0-9]*));?/g, (whole, hex?: string, decimal?: string, name?: string) => {
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
    if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10));
    return namedEntities[(name ?? "").toLowerCase()] ?? whole;
  });
}

function fromCodePoint(code: number) {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
  return String.fromCodePoint(code);
}

// Cutting escaped text mid-entity could leave a bare `&lt`, which HTML parsers
// still read as `<`; drop any trailing fragment so the tail stays inert.
function truncateEscaped(value: string, budget: number) {
  return value.slice(0, Math.max(0, budget)).replace(/&[#a-zA-Z0-9]*$/, "");
}

function escapeText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string) {
  return escapeText(value).replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}
