const enc = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(bytes = 12): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

// 사람이 받아쓰기 쉬운 초대 코드 (I, O, 0, 1 제외)
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function makeJoinCode(len = 6): string {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return [...b].map((n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join("");
}

/* ---------- PIN 해싱 (PBKDF2-SHA256) ---------- */

const PBKDF2_ITERATIONS = 120_000;

export async function hashPin(pin: string): Promise<string> {
  const salt = randomId(16);
  return `${salt}:${await derivePin(pin, salt)}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  return timingSafeEqual(await derivePin(pin, salt), expected);
}

async function derivePin(pin: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(bits);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- 세션 토큰 (HMAC-SHA256) ---------- */

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

/** 가족 공간에 대한 서명된 세션 토큰 발급 (기본 180일) */
export async function signToken(familyId: string, secret: string, days = 180): Promise<string> {
  const exp = Date.now() + days * 86_400_000;
  const payload = b64urlEncode(JSON.stringify({ f: familyId, exp }));
  return `${payload}.${await hmac(payload, secret)}`;
}

/** 토큰 검증. 유효하면 familyId, 아니면 null */
export async function verifyToken(token: string, secret: string): Promise<string | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!timingSafeEqual(await hmac(payload, secret), sig)) return null;
  try {
    const { f, exp } = JSON.parse(b64urlDecode(payload)) as { f: string; exp: number };
    if (!f || typeof exp !== "number" || Date.now() > exp) return null;
    return f;
  } catch {
    return null;
  }
}
