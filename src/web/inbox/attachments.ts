export const maxAttachmentSize = 15 * 1024 * 1024;

export const attachmentAccept = ".pdf,.zip,.json,.txt,.csv,.jpg,.jpeg,.png,.gif,.webp,.docx,.xlsx";

const typeByExtension: Record<string, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  json: "application/json",
  txt: "text/plain",
  csv: "text/csv",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const allowedTypes = new Set(Object.values(typeByExtension));

/**
 * The content type the upload intent should declare, or null when the file is
 * not one the server accepts. Browsers disagree about types for zip, csv and
 * docx, so the extension decides whenever the reported type is not on the
 * allowlist — the server still checks the bytes.
 */
export function resolveContentType(file: { name: string; type: string }): string | null {
  if (file.type && allowedTypes.has(file.type)) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return typeByExtension[extension] ?? null;
}
