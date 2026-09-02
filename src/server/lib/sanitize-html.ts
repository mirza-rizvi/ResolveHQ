// Rich replies are stored as HTML and forwarded to the mail provider, so the
// markup an agent submits is re-rendered inside somebody else's inbox. Rather
// than filtering known-bad markup, this tokenizer rebuilds the document from an
// allow-list: only the tags below survive, every attribute except a safe `href`
// is discarded, and all remaining text is entity-escaped.
const allowedTags = new Set(["p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li", "a"]);
const voidTags = new Set(["br"]);
const rawTextTags = new Set(["script", "style"]);
const safeSchemes = /^(https?:|mailto:)/i;
const maxLength = 200_000;

export function sanitizeHtml(input: string): string {
  const source = input.slice(0, maxLength);
  const openTags: string[] = [];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let out = "";
  let last = 0;
  // `script` and `style` hold raw text rather than markup, so their contents are
  // dropped along with the tags instead of being escaped into the output.
  let skipping = "";
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(source))) {
    if (!skipping) out += escapeText(source.slice(last, match.index));
    last = tagPattern.lastIndex;
    const name = match[1].toLowerCase();
    const closing = match[0].startsWith("</");
    if (rawTextTags.has(name)) {
      if (closing) { if (skipping === name) skipping = ""; }
      else if (!skipping) skipping = name;
      continue;
    }
    if (skipping || !allowedTags.has(name)) continue;
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
    if (voidTags.has(name)) { out += `<${name}>`; continue; }
    if (name === "a") {
      const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[2]);
      const value = (href?.[2] ?? href?.[3] ?? href?.[4] ?? "").trim();
      out += safeSchemes.test(value) ? `<a href="${escapeAttribute(value)}" rel="noopener noreferrer" target="_blank">` : "<a>";
      openTags.push(name);
      continue;
    }
    out += `<${name}>`;
    openTags.push(name);
  }
  if (!skipping) out += escapeText(source.slice(last));
  while (openTags.length) out += `</${openTags.pop()}>`;
  return out;
}

function escapeText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string) {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
