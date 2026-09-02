import { base64Url, constantTimeEqual, fromBase64Url } from "resolve-server/lib/crypto";

const encoder = new TextEncoder();
const algorithm = "pbkdf2-sha256";
const iterations = 310_000;

async function derive(password: string, pepper: string, salt: Uint8Array<ArrayBuffer>, rounds: number) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(`${password}\u0000${pepper}`), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, key, 256);
  return base64Url(new Uint8Array(bits));
}

export async function hashPassword(password: string, pepper: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await derive(password, pepper, salt, iterations);
  return `${algorithm}$${iterations}$${base64Url(salt)}$${digest}`;
}

export async function verifyPassword(password: string, encoded: string, pepper: string): Promise<boolean> {
  const [storedAlgorithm, storedIterations, salt, expected] = encoded.split("$");
  const rounds = Number(storedIterations);
  if (storedAlgorithm !== algorithm || !Number.isSafeInteger(rounds) || rounds < 100_000 || !salt || !expected)
    return false;
  const actual = await derive(password, pepper, fromBase64Url(salt), rounds);
  return constantTimeEqual(actual, expected);
}
