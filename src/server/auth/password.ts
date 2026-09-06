import { base64Url, fromBase64Url } from "resolve-server/lib/crypto";

const encoder = new TextEncoder();
export const passwordIterations = 310_000;
const algorithm = "pbkdf2-sha256";
export type AuthTiming = { operation: "hash" | "verify"; elapsedMs: number };

async function derive(password: string, pepper: string, salt: Uint8Array<ArrayBuffer>, rounds: number) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(`${password}\u0000${pepper}`), "PBKDF2", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, key, 256),
  );
}

export async function hashPassword(password: string, pepper: string, timings?: AuthTiming[]): Promise<string> {
  const start = timings ? performance.now() : 0;
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const digest = await derive(password, pepper, salt, passwordIterations);
    return `${algorithm}$${passwordIterations}$${base64Url(salt)}$${base64Url(digest)}`;
  } finally {
    timings?.push({ operation: "hash", elapsedMs: performance.now() - start });
  }
}

export async function verifyPassword(
  password: string,
  encoded: string,
  pepper: string,
  timings?: AuthTiming[],
): Promise<boolean> {
  const start = timings ? performance.now() : 0;
  try {
    const parts = encoded.split("$");
    const [storedAlgorithm, storedIterations, salt, expected] = parts;
    const rounds = Number(storedIterations);
    if (
      parts.length !== 4 ||
      storedAlgorithm !== algorithm ||
      !/^\d+$/.test(storedIterations) ||
      !Number.isSafeInteger(rounds) ||
      rounds < 100_000 ||
      rounds > 0xffffffff ||
      !/^[A-Za-z0-9_-]+$/.test(salt ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(expected ?? "")
    )
      return false;
    let decodedSalt: Uint8Array<ArrayBuffer>, digest: Uint8Array<ArrayBuffer>;
    try {
      decodedSalt = fromBase64Url(salt);
      digest = fromBase64Url(expected);
    } catch {
      return false;
    }
    if (!decodedSalt.length || digest.length !== 32) return false;
    const actual = await derive(password, pepper, decodedSalt, rounds);
    return crypto.subtle.timingSafeEqual(actual, digest);
  } finally {
    timings?.push({ operation: "verify", elapsedMs: performance.now() - start });
  }
}
