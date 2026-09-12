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

/**
 * Cloudflare Workers는 PBKDF2 반복 횟수를 10만 회로 제한한다.
 * 이를 넘기면 프로덕션에서 NotSupportedError로 실패한다
 * (로컬 workerd는 제한을 적용하지 않아 로컬 테스트만으로는 드러나지 않는다).
 * PIN은 4~8자리라 반복 횟수보다 5회 실패 잠금과 IP 요청 제한이 실질적인 방어선이다.
 */
const PBKDF2_ITERATIONS = 100_000;

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

/**
 * 길이까지 감추는 상수 시간 비교.
 * 두 값을 각각 SHA-256으로 해싱한 뒤 비교하므로 길이가 달라도
 * 비교 시간이 일정하고, 오답의 길이 정보가 새지 않는다.
 */
export async function secretEquals(a: string | null, b: string | null): Promise<boolean> {
  if (!a || !b) return false;
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return timingSafeEqual(ha, hb);
}

async function sha256Hex(v: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(v)));
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

export interface Session {
  familyId: string;
  /** 구성원 프로필까지 로그인했으면 그 id, 가족 공간까지만 들어온 상태면 null */
  memberId: string | null;
}

/**
 * 서명된 세션 토큰 발급 (기본 180일).
 * memberId가 없는 토큰은 "가족 공간에는 들어왔지만 내가 누군지는 아직 안 고른" 상태다.
 */
export async function signToken(
  session: Session,
  secret: string,
  days = 180,
): Promise<string> {
  const exp = Date.now() + days * 86_400_000;
  const payload = b64urlEncode(
    JSON.stringify({ f: session.familyId, m: session.memberId, exp }),
  );
  return `${payload}.${await hmac(payload, secret)}`;
}

/** 토큰 검증. 유효하면 세션, 아니면 null */
export async function verifyToken(token: string, secret: string): Promise<Session | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!timingSafeEqual(await hmac(payload, secret), sig)) return null;
  try {
    const { f, m, exp } = JSON.parse(b64urlDecode(payload)) as {
      f: string;
      m: string | null;
      exp: number;
    };
    if (!f || typeof exp !== "number" || Date.now() > exp) return null;
    return { familyId: f, memberId: typeof m === "string" ? m : null };
  } catch {
    return null;
  }
}
