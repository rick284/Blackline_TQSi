import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16384, R = 8, P = 1, KEYLEN = 64;

const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, KEYLEN, { N, r: R, p: P }, (e, k) => (e ? reject(e) : resolve(k))));

/** scrypt, a random salt per password. Stored as "scrypt$N$salt$hash" so the cost can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${N}$${salt.toString("base64")}$${(await derive(password, salt)).toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || Number(n) !== N || !salt || !hash) return false;
  const got = await derive(password, Buffer.from(salt, "base64"));
  const want = Buffer.from(hash, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A session token is shown once; only its SHA-256 is stored, so a database leak does not leak live sessions. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const MIN_PASSWORD = 10;
