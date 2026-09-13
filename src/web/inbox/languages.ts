/** Fixed target list for translation. Codes match the ISO 639-1 form the API accepts. */
export const translationLanguages = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "ja", label: "Japanese" },
] as const;

export function providerLabel(provider: string | null | undefined) {
  return provider === "workers-ai" ? "Cloudflare Workers AI" : "OpenAI";
}
