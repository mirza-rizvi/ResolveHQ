import { base64Url, fromBase64Url } from "resolve-server/lib/crypto";

const encoder = new TextEncoder();
/**
 * The Workers runtime refuses PBKDF2 above 100,000 iterations outright:
 * `Pbkdf2 failed: iteration counts above 100000 are not supported`. It is a hard
 * ceiling in the runtime's WebCrypto, not a CPU budget, so no plan raises it. Local
 * workerd does not enforce it, which is why 310,000 passed every test and every local
 * run while making sign-in impossible on every real deployment (#9).
 *
 * The floor and the ceiling are therefore the same number today. Raise both together if
 * the runtime ever lifts the cap; never lower the floor to fit a CPU budget.
 */
export const passwordIterations = 100_000;
export const minIterations = 100_000;
export const maxIterations = 100_000;
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

/**
 * A well-formed hash that matches no password, used to spend the same derivation time on
 * an unknown account as on a real one. Sign-in used to return in milliseconds when the
 * email was unknown and in tens of milliseconds when it was not, which told an
 * unauthenticated caller which addresses have accounts.
 */
export const DECOY_HASH = "pbkdf2-sha256$100000$BKtl8lgSzWp_CeIanhNWFg$k3uDh33WPtp5jd5wNKUWG2d8ZLJt3cbrIS8LRwaR8kc";

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
      rounds < minIterations ||
      // A hash written before the ceiling was known cannot be verified here at all:
      // deriving it would throw. Refusing it reads as a wrong password, which is the
      // safe direction; the account needs a password reset.
      rounds > maxIterations ||
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
