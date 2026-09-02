const DEFAULT_DESTINATION = "/inbox";

/** Accepts only same-origin absolute paths: rejects `//host`, `/\host`, and absolute URLs. */
export function safeNext(value: string | null, fallback = DEFAULT_DESTINATION) {
  return value && value.startsWith("/") && !/^\/[/\\]/.test(value) ? value : fallback;
}
