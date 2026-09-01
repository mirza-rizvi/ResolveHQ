export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function normalizeSearch(...values: Array<string | null | undefined>): string {
  return values.filter(Boolean).join(" ").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}
