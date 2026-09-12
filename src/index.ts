import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  hashPin,
  makeJoinCode,
  randomId,
  secretEquals,
  signToken,
  verifyPin,
  verifyToken,
} from "./auth";
import { rateLimit, sweepRateLimits } from "./ratelimit";
import { buildIcs, type IcsEvent } from "./ics";
import {
  addDays,
  dayLabel,
  expandOccurrences,
  nowTimeKST,
  timeLabel,
  todayKST,
  type EventRow,
} from "./dates";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AUTH_SECRET: string;
  /** 가족 공간 생성에 필요한 설치 코드. 없으면 생성 자체가 잠긴다. */
  SIGNUP_CODE?: string;
  /** 웹 푸시 공개키 (비밀이 아니며 브라우저에 그대로 전달된다) */
  VAPID_PUBLIC_KEY?: string;
}

type Vars = { familyId: string; memberId: string | null };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/* ------------------------------ 공통 유틸 ------------------------------ */

const MEMBER_COLORS = ["#4f7cff", "#ff6b6b", "#2bb673", "#f59f00", "#a855f7", "#0ea5e9"];
const REPEATS = new Set(["none", "daily", "weekly", "monthly", "yearly"]);
const VISIBILITIES = new Set(["family", "private"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PIN_RE = /^\d{4,8}$/;
/** 초대 코드 길이. 32종 문자 12자리 = 60비트 */
const INVITE_LEN = 12;

/** 사람이 옮겨 적은 초대 코드를 정규화한다 (대소문자·하이픈·공백 무시) */
function normalizeInvite(v: string): string {
  return v.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** 초대 코드를 새로 발급한다. 유일 인덱스 충돌 시 다시 뽑는다. */
async function issueInviteCode(db: D1Database, familyId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeJoinCode(INVITE_LEN);
    try {
      await db.prepare(`UPDATE families SET invite_code = ? WHERE id = ?`).bind(code, familyId).run();
      return code;
    } catch {
      // 충돌 → 다시 시도
    }
  }
  throw new HttpError(409, "초대 링크를 만들지 못했습니다. 다시 시도해 주세요.");
}

class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 429, message: string) {
    super(message);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clientIp(c: any): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    "unknown"
  );
}

/** 제한을 넘으면 429로 막는다 */
async function guard(c: any, scope: string, limit: number, windowSec: number) {
  const res = await rateLimit(c.env.DB, scope, clientIp(c), limit, windowSec);
  await sweepRateLimits(c.env.DB);
  if (!res.ok) {
    const mins = Math.ceil(res.retryAfter / 60);
    throw new HttpError(
      429,
      `요청이 너무 많습니다. ${mins <= 1 ? "잠시" : mins + "분"} 후 다시 시도해 주세요.`,
    );
  }
}

function str(v: unknown, field: string, max: number, required = true): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${field}을(를) 입력해 주세요.`);
    return null;
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} 형식이 올바르지 않습니다.`);
  const t = v.trim();
  if (required && !t) throw new HttpError(400, `${field}을(를) 입력해 주세요.`);
  if (t.length > max) throw new HttpError(400, `${field}은(는) ${max}자 이하로 입력해 주세요.`);
  return t || null;
}

function dateField(v: unknown, field: string, required = true): string | null {
  const s = str(v, field, 10, required);
  if (s === null) return null;
  if (!DATE_RE.test(s)) throw new HttpError(400, `${field}은(는) YYYY-MM-DD 형식이어야 합니다.`);
  return s;
}

function timeField(v: unknown, field: string): string | null {
  const s = str(v, field, 5, false);
  if (s === null) return null;
  if (!TIME_RE.test(s)) throw new HttpError(400, `${field}은(는) HH:MM 형식이어야 합니다.`);
  return s;
}

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error("unhandled", err);
  return c.json({ error: "서버에서 문제가 발생했습니다." }, 500);
});

/* ------------------------------ 인증 미들웨어 ------------------------------ */

/** 가족 공간에 들어온 것까지만 확인한다 (구성원 선택 전 단계에서 사용) */
async function requireFamily(c: any, next: () => Promise<void>) {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new HttpError(401, "로그인이 필요합니다.");
  if (!c.env.AUTH_SECRET) throw new HttpError(403, "서버에 AUTH_SECRET이 설정되지 않았습니다.");
  const session = await verifyToken(token, c.env.AUTH_SECRET);
  if (!session) throw new HttpError(401, "세션이 만료되었습니다. 다시 로그인해 주세요.");
  c.set("familyId", session.familyId);
  c.set("memberId", session.memberId);
  await next();
}

/**
 * "내가 누구인지"까지 확정된 세션만 통과시킨다.
 * 개인 전용 항목을 가려내려면 반드시 구성원 신원이 필요하다.
 */
async function requireMember(c: any, next: () => Promise<void>) {
  await requireFamily(c, async () => {});
  const memberId = c.get("memberId");
  if (!memberId) throw new HttpError(403, "내 프로필을 먼저 선택해 주세요.");

  // 프로필이 삭제되었을 수 있으므로 실제 존재를 확인한다
  const row = await c.env.DB.prepare(
    `SELECT id FROM members WHERE id = ? AND family_id = ?`,
  )
    .bind(memberId, c.get("familyId"))
    .first();
  if (!row) throw new HttpError(401, "프로필을 찾을 수 없습니다. 다시 로그인해 주세요.");

  await next();
}

/* ------------------------------ 가족 생성 / 참여 ------------------------------ */

app.post("/api/family/create", async (c) => {
  // 같은 IP에서 1시간에 5번까지만 생성 시도 가능
  await guard(c, "create", 5, 3600);

  const body = await c.req.json().catch(() => ({}));

  // 설치 코드가 서버에 없으면 생성 기능 자체를 잠근다 (fail closed)
  if (!c.env.SIGNUP_CODE) {
    throw new HttpError(
      403,
      "가족 공간 생성이 잠겨 있습니다. 서버 관리자가 SIGNUP_CODE를 설정해야 합니다.",
    );
  }
  if (!(await secretEquals(str(body.signupCode, "설치 코드", 200, false), c.env.SIGNUP_CODE))) {
    throw new HttpError(401, "설치 코드가 올바르지 않습니다.");
  }

  const name = str(body.name, "가족 이름", 40)!;
  if (!c.env.AUTH_SECRET) throw new HttpError(403, "서버에 AUTH_SECRET이 설정되지 않았습니다.");

  const id = randomId();
  const widgetToken = randomId(24);
  const created = nowIso();

  // 가족 공용 PIN은 쓰지 않는다 — 초대 링크가 그 역할을 한다.
  // pin_hash 는 NOT NULL 이라 사용 안 함 표시만 남기고,
  // join_code(옛 짧은 코드)는 유일 제약 때문에 계속 채워 둔다.
  let inviteCode = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    inviteCode = makeJoinCode(INVITE_LEN);
    try {
      await c.env.DB.prepare(
        `INSERT INTO families (id, name, join_code, invite_code, pin_hash, widget_token, created_at)
         VALUES (?, ?, ?, ?, 'disabled', ?, ?)`,
      )
        .bind(id, name, makeJoinCode(), inviteCode, widgetToken, created)
        .run();
      break;
    } catch (e) {
      if (attempt === 5) throw e;
      inviteCode = "";
    }
  }
  if (!inviteCode) throw new HttpError(409, "초대 링크 생성에 실패했습니다. 다시 시도해 주세요.");

  // 입력된 구성원 이름들 등록
  const names: string[] = Array.isArray(body.members) ? body.members : [];
  const stmts = names
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .filter((n) => n && n.length <= 20)
    .slice(0, 12)
    .map((n, i) =>
      c.env.DB.prepare(
        `INSERT INTO members (id, family_id, name, color, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(randomId(), id, n, MEMBER_COLORS[i % MEMBER_COLORS.length], i, created),
    );
  if (stmts.length) await c.env.DB.batch(stmts);

  const created_members = await c.env.DB.prepare(
    `SELECT id, name, color, (pin_hash IS NOT NULL) AS claimed
     FROM members WHERE family_id = ? ORDER BY sort_order`,
  )
    .bind(id)
    .all();

  return c.json({
    // 아직 "내가 누구인지"는 고르지 않은 상태의 토큰
    token: await signToken({ familyId: id, memberId: null }, c.env.AUTH_SECRET),
    family: { id, name, inviteCode, widgetToken },
    members: created_members.results ?? [],
  });
});

app.post("/api/family/join", async (c) => {
  // 초대 코드를 바꿔가며 찍어보는 시도를 막는다: 1분에 10회
  await guard(c, "join", 10, 60);

  const body = await c.req.json().catch(() => ({}));
  const code = normalizeInvite(str(body.inviteCode, "초대 코드", 40)!);
  if (!c.env.AUTH_SECRET) throw new HttpError(403, "서버에 AUTH_SECRET이 설정되지 않았습니다.");
  if (code.length !== INVITE_LEN) {
    throw new HttpError(401, "초대 링크가 올바르지 않습니다. 가족에게 새 링크를 받아 주세요.");
  }

  const row = await c.env.DB.prepare(
    `SELECT id, name, invite_code, widget_token FROM families WHERE invite_code = ?`,
  )
    .bind(code)
    .first<{ id: string; name: string; invite_code: string; widget_token: string }>();
  if (!row) {
    throw new HttpError(401, "초대 링크가 올바르지 않거나 새 링크로 바뀌었습니다.");
  }

  const roster = await c.env.DB.prepare(
    `SELECT id, name, color, (pin_hash IS NOT NULL) AS claimed
     FROM members WHERE family_id = ? ORDER BY sort_order, created_at`,
  )
    .bind(row.id)
    .all();

  return c.json({
    token: await signToken({ familyId: row.id, memberId: null }, c.env.AUTH_SECRET),
    family: { id: row.id, name: row.name, inviteCode: row.invite_code, widgetToken: row.widget_token },
    members: roster.results ?? [],
  });
});

/** 초대 링크가 퍼졌을 때 새로 만든다. 이전 링크는 즉시 막히고, 이미 들어온 가족은 그대로다. */
app.post("/api/family/invite/reset", requireMember, async (c) => {
  const inviteCode = await issueInviteCode(c.env.DB, c.get("familyId"));
  return c.json({ inviteCode });
});

/* ------------------------------ 내 프로필 선택 (구성원 로그인) ------------------------------ */

/** 가족 공간에 들어온 뒤 "나는 누구인가"를 확정한다 */
app.get("/api/members/roster", requireFamily, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, color, (pin_hash IS NOT NULL) AS claimed
     FROM members WHERE family_id = ? ORDER BY sort_order, created_at`,
  )
    .bind(c.get("familyId"))
    .all();
  const fam = await c.env.DB.prepare(`SELECT name FROM families WHERE id = ?`)
    .bind(c.get("familyId"))
    .first<{ name: string }>();
  return c.json({ members: rows.results ?? [], familyName: fam?.name ?? null });
});

/**
 * 프로필 차지하기 / 프로필 로그인.
 * 아직 주인이 없는 프로필이면 입력한 PIN이 그 사람의 개인 PIN으로 설정된다.
 * 이미 주인이 있으면 개인 PIN이 맞아야 통과한다.
 */
app.post("/api/members/claim", requireFamily, async (c) => {
  await guard(c, "claim", 12, 60);

  const familyId = c.get("familyId");
  const body = await c.req.json().catch(() => ({}));
  const memberId = str(body.memberId, "구성원", 40)!;
  const pin = str(body.pin, "비밀번호", 8)!;
  if (!PIN_RE.test(pin)) throw new HttpError(400, "비밀번호는 숫자 4~8자리로 만들어 주세요.");

  const member = await c.env.DB.prepare(
    `SELECT id, name, color, pin_hash, widget_token, fail_count, locked_until
     FROM members WHERE id = ? AND family_id = ?`,
  )
    .bind(memberId, familyId)
    .first<{
      id: string;
      name: string;
      color: string;
      pin_hash: string | null;
      widget_token: string | null;
      fail_count: number;
      locked_until: string | null;
    }>();
  if (!member) throw new HttpError(404, "구성원을 찾을 수 없습니다.");

  if (member.locked_until && member.locked_until > nowIso()) {
    throw new HttpError(429, "비밀번호를 여러 번 틀렸습니다. 5분 후 다시 시도해 주세요.");
  }

  const widgetToken = member.widget_token ?? randomId(24);

  if (!member.pin_hash) {
    // 아직 주인이 없는 프로필 → 지금 입력한 PIN이 개인 PIN이 된다
    await c.env.DB.prepare(
      `UPDATE members SET pin_hash = ?, widget_token = ?, claimed_at = ? WHERE id = ?`,
    )
      .bind(await hashPin(pin), widgetToken, nowIso(), member.id)
      .run();
  } else {
    if (!(await verifyPin(pin, member.pin_hash))) {
      const fails = member.fail_count + 1;
      const lockUntil = fails >= 5 ? new Date(Date.now() + 5 * 60_000).toISOString() : null;
      await c.env.DB.prepare(
        `UPDATE members SET fail_count = ?, locked_until = ? WHERE id = ?`,
      )
        .bind(lockUntil ? 0 : fails, lockUntil, member.id)
        .run();
      throw new HttpError(401, "비밀번호가 올바르지 않습니다.");
    }
    await c.env.DB.prepare(
      `UPDATE members SET fail_count = 0, locked_until = NULL, widget_token = ? WHERE id = ?`,
    )
      .bind(widgetToken, member.id)
      .run();
  }

  return c.json({
    token: await signToken({ familyId, memberId: member.id }, c.env.AUTH_SECRET),
    me: { id: member.id, name: member.name, color: member.color, widgetToken },
  });
});

/* ------------------------------ 전체 상태 조회 ------------------------------ */

app.get("/api/state", requireMember, async (c) => {
  const familyId = c.get("familyId");
  const me = c.get("memberId")!;
  const today = todayKST();
  const from = addDays(today, -1);
  const to = addDays(today, 120);

  const [family, members, events, memos] = await Promise.all([
    c.env.DB.prepare(`SELECT id, name, invite_code, widget_token FROM families WHERE id = ?`)
      .bind(familyId)
      .first<{ id: string; name: string; invite_code: string | null; widget_token: string }>(),
    c.env.DB.prepare(
      `SELECT id, name, color, (pin_hash IS NOT NULL) AS claimed
       FROM members WHERE family_id = ? ORDER BY sort_order, created_at`,
    )
      .bind(familyId)
      .all<{ id: string; name: string; color: string; claimed: number }>(),
    // 개인 전용 항목은 만든 사람에게만 보인다
    c.env.DB.prepare(
      `SELECT id, title, date, time, end_time, location, notes, member_id, repeat, repeat_until,
              owner_id, visibility
       FROM events
       WHERE family_id = ?
         AND (visibility = 'family' OR owner_id = ?)
         AND (repeat != 'none' OR date >= ?)`,
    )
      .bind(familyId, me, from)
      .all<EventRow>(),
    c.env.DB.prepare(
      `SELECT id, text, pinned, done, member_id, owner_id, visibility, created_at, updated_at
       FROM memos
       WHERE family_id = ? AND (visibility = 'family' OR owner_id = ?)
       ORDER BY done, pinned DESC, created_at DESC`,
    )
      .bind(familyId, me)
      .all(),
  ]);

  if (!family) throw new HttpError(404, "가족 정보를 찾을 수 없습니다.");

  // 초대 링크 방식 이전에 만들어진 가족은 초대 코드가 없다 → 처음 조회할 때 발급한다
  const inviteCode = family.invite_code ?? (await issueInviteCode(c.env.DB, family.id));

  const occurrences = expandOccurrences(events.results ?? [], from, to).map((o) => ({
    ...o,
    date: o.occurs_on,
    dayLabel: dayLabel(o.occurs_on, today),
    timeLabel: timeLabel(o.time),
  }));

  const meRow = (members.results ?? []).find((m) => m.id === me);
  const myWidget = await c.env.DB.prepare(
    `SELECT widget_token FROM members WHERE id = ?`,
  )
    .bind(me)
    .first<{ widget_token: string | null }>();

  return c.json({
    family: {
      id: family.id,
      name: family.name,
      inviteCode,
      widgetToken: family.widget_token,
    },
    me: {
      id: me,
      name: meRow?.name ?? null,
      color: meRow?.color ?? null,
      // 내 개인 항목까지 보이는 개인 위젯 주소
      widgetToken: myWidget?.widget_token ?? null,
    },
    today,
    members: members.results ?? [],
    events: occurrences,
    memos: memos.results ?? [],
  });
});

/* ------------------------------ 구성원 ------------------------------ */

// 프로필 선택 화면에서 아직 목록에 없는 자기 이름을 추가할 수 있어야 하므로
// 구성원 확정 전(가족 PIN만 통과한 상태)에도 허용한다.
app.post("/api/members", requireFamily, async (c) => {
  const familyId = c.get("familyId");
  const body = await c.req.json().catch(() => ({}));
  const name = str(body.name, "이름", 20)!;

  const { count } = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM members WHERE family_id = ?`,
  )
    .bind(familyId)
    .first<{ count: number }>()) ?? { count: 0 };
  if (count >= 12) throw new HttpError(400, "구성원은 최대 12명까지 등록할 수 있습니다.");

  const id = randomId();
  const color = str(body.color, "색상", 9, false) ?? MEMBER_COLORS[count % MEMBER_COLORS.length];
  await c.env.DB.prepare(
    `INSERT INTO members (id, family_id, name, color, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, familyId, name, color, count, nowIso())
    .run();

  return c.json({ member: { id, name, color } });
});

app.delete("/api/members/:id", requireMember, async (c) => {
  const familyId = c.get("familyId");
  const me = c.get("memberId")!;
  const target = c.req.param("id");

  const row = await c.env.DB.prepare(
    `SELECT id, name, pin_hash FROM members WHERE id = ? AND family_id = ?`,
  )
    .bind(target, familyId)
    .first<{ id: string; name: string; pin_hash: string | null }>();
  if (!row) throw new HttpError(404, "구성원을 찾을 수 없습니다.");

  // 이미 주인이 있는 프로필은 본인만 지울 수 있다.
  // 남이 지워버리면 그 사람의 개인 항목이 통째로 사라지기 때문이다.
  if (row.pin_hash && row.id !== me) {
    throw new HttpError(403, `${row.name} 님의 프로필은 본인만 삭제할 수 있습니다.`);
  }

  // 프로필이 사라지면 그 사람의 개인 항목도 볼 사람이 없으므로 함께 정리한다
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM events WHERE family_id = ? AND visibility = 'private' AND owner_id = ?`,
    ).bind(familyId, target),
    c.env.DB.prepare(
      `DELETE FROM memos WHERE family_id = ? AND visibility = 'private' AND owner_id = ?`,
    ).bind(familyId, target),
    c.env.DB.prepare(`DELETE FROM members WHERE id = ? AND family_id = ?`).bind(target, familyId),
  ]);

  return c.json({ ok: true });
});

/* ------------------------------ 일정 ------------------------------ */

/**
 * 대상 항목을 내가 건드릴 수 있는지 확인한다.
 * 개인 전용 항목은 만든 사람만 열람·수정·삭제할 수 있고,
 * 남의 개인 항목에는 "없음"(404)으로 답해 존재 자체를 숨긴다.
 */
async function assertCanEdit(
  db: D1Database,
  table: "events" | "memos",
  id: string,
  familyId: string,
  me: string,
): Promise<void> {
  const row = await db
    .prepare(`SELECT owner_id, visibility FROM ${table} WHERE id = ? AND family_id = ?`)
    .bind(id, familyId)
    .first<{ owner_id: string | null; visibility: string }>();

  // 남의 개인 항목도 "없음"으로 답해 존재를 노출하지 않는다
  const notFound = table === "events" ? "일정을 찾을 수 없습니다." : "메모를 찾을 수 없습니다.";
  if (!row) throw new HttpError(404, notFound);
  if (row.visibility === "private" && row.owner_id !== me) {
    throw new HttpError(404, notFound);
  }
}

function visibilityField(v: unknown): string {
  const raw = str(v, "공개 범위", 10, false) ?? "family";
  if (!VISIBILITIES.has(raw)) throw new HttpError(400, "공개 범위 설정이 올바르지 않습니다.");
  return raw;
}

async function assertMember(db: D1Database, familyId: string, memberId: string | null) {
  if (!memberId) return null;
  const row = await db
    .prepare(`SELECT id FROM members WHERE id = ? AND family_id = ?`)
    .bind(memberId, familyId)
    .first();
  if (!row) throw new HttpError(400, "선택한 구성원을 찾을 수 없습니다.");
  return memberId;
}

app.post("/api/events", requireMember, async (c) => {
  const familyId = c.get("familyId");
  const me = c.get("memberId")!;
  const body = await c.req.json().catch(() => ({}));

  const visibility = visibilityField(body.visibility);
  const title = str(body.title, "일정 내용", 120)!;
  const date = dateField(body.date, "날짜")!;
  const time = timeField(body.time, "시간");
  const endTime = timeField(body.endTime, "종료 시간");
  const location = str(body.location, "장소", 80, false);
  const notes = str(body.notes, "메모", 500, false);
  const memberId = await assertMember(c.env.DB, familyId, str(body.memberId, "담당", 40, false));
  const repeat = str(body.repeat, "반복", 10, false) ?? "none";
  if (!REPEATS.has(repeat)) throw new HttpError(400, "반복 설정이 올바르지 않습니다.");
  const repeatUntil = repeat === "none" ? null : dateField(body.repeatUntil, "반복 종료일", false);
  if (repeatUntil && repeatUntil < date) {
    throw new HttpError(400, "반복 종료일은 시작 날짜보다 뒤여야 합니다.");
  }
  if (endTime && time && endTime < time) {
    throw new HttpError(400, "종료 시간은 시작 시간보다 뒤여야 합니다.");
  }

  const id = randomId();
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO events
       (id, family_id, title, date, time, end_time, location, notes, member_id,
        repeat, repeat_until, owner_id, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, familyId, title, date, time, endTime, location, notes, memberId,
          repeat, repeatUntil, me, visibility, ts, ts)
    .run();

  return c.json({ id });
});

app.patch("/api/events/:id", requireMember, async (c) => {
  const familyId = c.get("familyId");
  const me = c.get("memberId")!;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  await assertCanEdit(c.env.DB, "events", id, familyId, me);

  const sets: string[] = [];
  const args: (string | null)[] = [];
  const put = (col: string, val: string | null) => {
    sets.push(`${col} = ?`);
    args.push(val);
  };

  if ("title" in body) put("title", str(body.title, "일정 내용", 120));
  if ("date" in body) put("date", dateField(body.date, "날짜"));
  if ("time" in body) put("time", timeField(body.time, "시간"));
  if ("endTime" in body) put("end_time", timeField(body.endTime, "종료 시간"));
  if ("location" in body) put("location", str(body.location, "장소", 80, false));
  if ("notes" in body) put("notes", str(body.notes, "메모", 500, false));
  if ("memberId" in body) {
    put("member_id", await assertMember(c.env.DB, familyId, str(body.memberId, "담당", 40, false)));
  }
  if ("repeat" in body) {
    const repeat = str(body.repeat, "반복", 10, false) ?? "none";
    if (!REPEATS.has(repeat)) throw new HttpError(400, "반복 설정이 올바르지 않습니다.");
    put("repeat", repeat);
  }
  if ("repeatUntil" in body) put("repeat_until", dateField(body.repeatUntil, "반복 종료일", false));
  if ("visibility" in body) {
    put("visibility", visibilityField(body.visibility));
    // 공유였던 항목을 개인 전용으로 바꾸면 지금 바꾼 사람이 주인이 된다
    put("owner_id", me);
  }

  if (!sets.length) throw new HttpError(400, "변경할 내용이 없습니다.");
  put("updated_at", nowIso());

  await c.env.DB.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ? AND family_id = ?`)
    .bind(...args, id, familyId)
    .run();

  return c.json({ ok: true });
});

app.delete("/api/events/:id", requireMember, async (c) => {
  const id = c.req.param("id");
  const familyId = c.get("familyId");
  await assertCanEdit(c.env.DB, "events", id, familyId, c.get("memberId")!);

  await c.env.DB.prepare(`DELETE FROM events WHERE id = ? AND family_id = ?`)
    .bind(id, familyId)
    .run();
  return c.json({ ok: true });
});

/* ------------------------------ 메모 ------------------------------ */

app.post("/api/memos", requireMember, async (c) => {
  const familyId = c.get("familyId");
  const me = c.get("memberId")!;
  const body = await c.req.json().catch(() => ({}));
  const visibility = visibilityField(body.visibility);
  const text = str(body.text, "메모 내용", 300)!;
  const memberId = await assertMember(c.env.DB, familyId, str(body.memberId, "담당", 40, false));
  const pinned = body.pinned ? 1 : 0;

  const id = randomId();
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO memos
       (id, family_id, text, pinned, done, member_id, owner_id, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  )
    .bind(id, familyId, text, pinned, memberId, me, visibility, ts, ts)
    .run();

  return c.json({ id });
});

app.patch("/api/memos/:id", requireMember, async (c) => {
  const familyId = c.get("familyId");
  const me = c.get("memberId")!;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  await assertCanEdit(c.env.DB, "memos", id, familyId, me);

  const sets: string[] = [];
  const args: (string | number | null)[] = [];

  if ("text" in body) {
    sets.push("text = ?");
    args.push(str(body.text, "메모 내용", 300));
  }
  if ("pinned" in body) {
    sets.push("pinned = ?");
    args.push(body.pinned ? 1 : 0);
  }
  if ("done" in body) {
    sets.push("done = ?");
    args.push(body.done ? 1 : 0);
  }
  if ("memberId" in body) {
    sets.push("member_id = ?");
    args.push(await assertMember(c.env.DB, familyId, str(body.memberId, "담당", 40, false)));
  }
  if ("visibility" in body) {
    sets.push("visibility = ?", "owner_id = ?");
    args.push(visibilityField(body.visibility), me);
  }
  if (!sets.length) throw new HttpError(400, "변경할 내용이 없습니다.");

  sets.push("updated_at = ?");
  args.push(nowIso());

  await c.env.DB.prepare(`UPDATE memos SET ${sets.join(", ")} WHERE id = ? AND family_id = ?`)
    .bind(...args, id, familyId)
    .run();

  return c.json({ ok: true });
});

app.delete("/api/memos/:id", requireMember, async (c) => {
  const id = c.req.param("id");
  const familyId = c.get("familyId");
  await assertCanEdit(c.env.DB, "memos", id, familyId, c.get("memberId")!);

  await c.env.DB.prepare(`DELETE FROM memos WHERE id = ? AND family_id = ?`)
    .bind(id, familyId)
    .run();
  return c.json({ ok: true });
});

/* ------------------------------ 푸시 알림 ------------------------------ */

const TIME_ONLY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 브라우저가 구독할 때 필요한 공개키 */
app.get("/api/push/key", (c) => {
  if (!c.env.VAPID_PUBLIC_KEY) {
    throw new HttpError(403, "서버에 알림 설정이 되어 있지 않습니다.");
  }
  return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY });
});

/** 기기 구독 등록 (같은 endpoint 로 다시 오면 갱신) */
app.post("/api/push/subscribe", requireMember, async (c) => {
  const familyId = c.get("familyId");
  const me = c.get("memberId")!;
  const body = await c.req.json().catch(() => ({}));

  const endpoint = str(body.endpoint, "구독 주소", 700)!;
  if (!endpoint.startsWith("https://")) {
    throw new HttpError(400, "구독 주소가 올바르지 않습니다.");
  }
  const p256dh = str(body.p256dh, "구독 키", 200)!;
  const auth = str(body.auth, "구독 키", 100)!;
  const ua = str(body.ua, "기기", 200, false);

  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions
       (id, family_id, member_id, endpoint, p256dh, auth, ua, created_at, fail_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(endpoint) DO UPDATE SET
       family_id = excluded.family_id,
       member_id = excluded.member_id,
       p256dh    = excluded.p256dh,
       auth      = excluded.auth,
       ua        = excluded.ua,
       fail_count = 0`,
  )
    .bind(randomId(), familyId, me, endpoint, p256dh, auth, ua, nowIso())
    .run();

  return c.json({ ok: true });
});

app.post("/api/push/unsubscribe", requireMember, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const endpoint = str(body.endpoint, "구독 주소", 700)!;
  await c.env.DB.prepare(
    `DELETE FROM push_subscriptions WHERE endpoint = ? AND family_id = ?`,
  )
    .bind(endpoint, c.get("familyId"))
    .run();
  return c.json({ ok: true });
});

/** 이 기기가 이미 등록돼 있는지 + 가족 알림 설정 */
app.get("/api/push/status", requireMember, async (c) => {
  const familyId = c.get("familyId");
  const endpoint = c.req.query("endpoint") ?? "";

  const [row, family] = await Promise.all([
    endpoint
      ? c.env.DB.prepare(
          `SELECT member_id FROM push_subscriptions WHERE endpoint = ? AND family_id = ?`,
        )
          .bind(endpoint, familyId)
          .first<{ member_id: string }>()
      : Promise.resolve(null),
    c.env.DB.prepare(
      `SELECT notify_enabled, notify_lead_min, notify_allday_at, notify_morning
       FROM families WHERE id = ?`,
    )
      .bind(familyId)
      .first<{
        notify_enabled: number;
        notify_lead_min: number;
        notify_allday_at: string;
        notify_morning: string | null;
      }>(),
  ]);

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM push_subscriptions WHERE family_id = ?`,
  )
    .bind(familyId)
    .first<{ c: number }>();

  return c.json({
    subscribed: !!row,
    deviceCount: count?.c ?? 0,
    hasKey: !!c.env.VAPID_PUBLIC_KEY,
    settings: {
      enabled: !!family?.notify_enabled,
      leadMin: family?.notify_lead_min ?? 30,
      allDayAt: family?.notify_allday_at ?? "08:00",
      morning: family?.notify_morning ?? null,
    },
  });
});

/** 가족 공통 알림 설정 변경 */
app.patch("/api/push/settings", requireMember, async (c) => {
  const familyId = c.get("familyId");
  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const args: (string | number | null)[] = [];

  if ("enabled" in body) {
    sets.push("notify_enabled = ?");
    args.push(body.enabled ? 1 : 0);
  }
  if ("leadMin" in body) {
    const n = Number(body.leadMin);
    if (![0, 10, 30, 60, 120].includes(n)) {
      throw new HttpError(400, "미리 알림 시간이 올바르지 않습니다.");
    }
    sets.push("notify_lead_min = ?");
    args.push(n);
  }
  if ("allDayAt" in body) {
    const t = str(body.allDayAt, "종일 일정 알림 시각", 5)!;
    if (!TIME_ONLY.test(t)) throw new HttpError(400, "시각 형식이 올바르지 않습니다.");
    sets.push("notify_allday_at = ?");
    args.push(t);
  }
  if ("morning" in body) {
    if (body.morning === null || body.morning === "") {
      sets.push("notify_morning = ?");
      args.push(null);
    } else {
      const t = str(body.morning, "아침 요약 시각", 5)!;
      if (!TIME_ONLY.test(t)) throw new HttpError(400, "시각 형식이 올바르지 않습니다.");
      sets.push("notify_morning = ?");
      args.push(t);
    }
  }
  if (!sets.length) throw new HttpError(400, "변경할 내용이 없습니다.");

  await c.env.DB.prepare(`UPDATE families SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...args, familyId)
    .run();

  return c.json({ ok: true });
});

/* ------------------------------ 위젯용 읽기 전용 엔드포인트 ------------------------------ */

app.use("/api/widget/*", cors({ origin: "*", allowMethods: ["GET"] }));

app.get("/api/widget/:token", async (c) => {
  // 정상 위젯은 15분 주기로 호출한다. 넉넉히 두되 토큰 대량 추측은 막는다.
  await guard(c, "widget", 60, 60);

  const token = c.req.param("token");

  // 토큰은 두 종류다.
  //   구성원 토큰 → 가족 공유 항목 + 그 사람의 개인 항목
  //   가족 토큰   → 가족 공유 항목만
  const asMember = await c.env.DB.prepare(
    `SELECT m.id AS member_id, m.name AS member_name, f.id AS family_id, f.name AS family_name
     FROM members m JOIN families f ON f.id = m.family_id
     WHERE m.widget_token = ?`,
  )
    .bind(token)
    .first<{ member_id: string; member_name: string; family_id: string; family_name: string }>();

  let family: { id: string; name: string };
  let viewerId: string | null = null;
  let viewerName: string | null = null;

  if (asMember) {
    family = { id: asMember.family_id, name: asMember.family_name };
    viewerId = asMember.member_id;
    viewerName = asMember.member_name;
  } else {
    const asFamily = await c.env.DB.prepare(
      `SELECT id, name FROM families WHERE widget_token = ?`,
    )
      .bind(token)
      .first<{ id: string; name: string }>();
    if (!asFamily) throw new HttpError(404, "위젯 토큰이 올바르지 않습니다.");
    family = asFamily;
  }

  const today = todayKST();
  const to = addDays(today, 21);

  const [events, memos, members] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, title, date, time, end_time, location, notes, member_id, repeat, repeat_until,
              owner_id, visibility
       FROM events
       WHERE family_id = ?
         AND (visibility = 'family' OR owner_id = ?)
         AND (repeat != 'none' OR date >= ?)`,
    )
      .bind(family.id, viewerId, today)
      .all<EventRow>(),
    c.env.DB.prepare(
      `SELECT id, text, pinned, member_id, owner_id, visibility FROM memos
       WHERE family_id = ? AND done = 0 AND (visibility = 'family' OR owner_id = ?)
       ORDER BY pinned DESC, created_at DESC LIMIT 12`,
    )
      .bind(family.id, viewerId)
      .all<{
        id: string;
        text: string;
        pinned: number;
        member_id: string | null;
        owner_id: string | null;
        visibility: string;
      }>(),
    c.env.DB.prepare(`SELECT id, name, color FROM members WHERE family_id = ?`)
      .bind(family.id)
      .all<{ id: string; name: string; color: string }>(),
  ]);

  const byId = new Map((members.results ?? []).map((m) => [m.id, m]));
  const nowTime = nowTimeKST();

  const upcoming = expandOccurrences(events.results ?? [], today, to)
    // 오늘 일정 중 이미 지난 시각은 위젯에서 제외
    .filter((o) => !(o.occurs_on === today && o.time !== null && o.time < nowTime))
    .slice(0, 12)
    .map((o) => {
      const m = o.member_id ? byId.get(o.member_id) : undefined;
      return {
        id: o.id,
        title: o.title,
        private: o.visibility === "private",
        date: o.occurs_on,
        dayLabel: dayLabel(o.occurs_on, today),
        time: o.time,
        timeLabel: timeLabel(o.time),
        location: o.location,
        member: m?.name ?? null,
        color: m?.color ?? null,
        isToday: o.occurs_on === today,
      };
    });

  return c.json(
    {
      family: family.name,
      // 개인 위젯이면 누구 것인지 알려준다 (위젯 제목에 활용)
      viewer: viewerName,
      today,
      nowTime,
      updatedAt: nowIso(),
      events: upcoming,
      memos: (memos.results ?? []).map((m) => {
        const who = m.member_id ? byId.get(m.member_id) : undefined;
        return {
          id: m.id,
          text: m.text,
          pinned: !!m.pinned,
          private: m.visibility === "private",
          member: who?.name ?? null,
          color: who?.color ?? null,
        };
      }),
    },
    // 위젯이 자주 깨우므로 짧은 캐시만 허용
    { headers: { "cache-control": "public, max-age=30" } },
  );
});

/* ------------------------------ 정적 파일 / SPA 폴백 ------------------------------ */

/* ------------------------------ 휴대폰 캘린더 구독 (ICS) ------------------------------ */

/**
 * 위젯 토큰으로 보는 사람을 판별한다.
 *   구성원 토큰 → 가족 공유 항목 + 그 사람의 개인 항목
 *   가족 토큰   → 가족 공유 항목만
 */
async function resolveViewer(db: D1Database, token: string) {
  const m = await db
    .prepare(
      `SELECT m.id AS member_id, m.name AS member_name, f.id AS family_id, f.name AS family_name
       FROM members m JOIN families f ON f.id = m.family_id WHERE m.widget_token = ?`,
    )
    .bind(token)
    .first<{ member_id: string; member_name: string; family_id: string; family_name: string }>();
  if (m) {
    return { familyId: m.family_id, familyName: m.family_name, viewerId: m.member_id, viewerName: m.member_name };
  }
  const f = await db
    .prepare(`SELECT id, name FROM families WHERE widget_token = ?`)
    .bind(token)
    .first<{ id: string; name: string }>();
  return f ? { familyId: f.id, familyName: f.name, viewerId: null, viewerName: null } : null;
}

app.get("/api/calendar/:file", async (c) => {
  // 휴대폰 캘린더가 주기적으로 받아간다. 토큰 대량 추측만 막을 만큼 넉넉히 둔다
  await guard(c, "calendar", 60, 60);

  const token = c.req.param("file").replace(/\.ics$/i, "");
  const viewer = await resolveViewer(c.env.DB, token);
  if (!viewer) throw new HttpError(404, "캘린더 주소가 올바르지 않습니다.");

  const rows = (
    await c.env.DB.prepare(
      `SELECT e.id, e.title, e.date, e.time, e.end_time, e.location, e.notes, e.member_id,
              e.repeat, e.repeat_until, e.owner_id, e.visibility, e.updated_at,
              m.name AS member_name
       FROM events e LEFT JOIN members m ON m.id = e.member_id
       WHERE e.family_id = ?
         AND (e.visibility = 'family' OR e.owner_id = ?)
         AND (e.repeat != 'none' OR e.date >= ?)`,
    )
      .bind(viewer.familyId, viewer.viewerId, addDays(todayKST(), -60))
      .all<IcsEvent>()
  ).results ?? [];

  const ics = buildIcs({
    calName: viewer.viewerName
      ? `${viewer.familyName} · ${viewer.viewerName}`
      : `${viewer.familyName} 가족`,
    host: new URL(c.req.url).host,
    events: rows,
  });

  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="family.ics"',
      "cache-control": "private, max-age=300",
    },
  });
});

app.all("/api/*", (c) => c.json({ error: "요청한 API를 찾을 수 없습니다." }, 404));

/** 검색엔진 색인 차단: 주소가 퍼져 모르는 사람이 찾아오는 것을 막는다 */
app.get("/robots.txt", (c) =>
  c.text("User-agent: *\nDisallow: /\n", 200, {
    "cache-control": "public, max-age=3600",
  }),
);

const SECURITY_HEADERS: Record<string, string> = {
  // 앱은 자기 출처의 리소스만 쓴다. 외부 스크립트 주입을 차단한다.
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    // 화면 조립에 style 속성을 쓰므로 inline style만 허용 (script는 불허)
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow",
  // 음성으로 일정을 추가하므로 같은 출처에서는 마이크를 허용해야 한다
  "permissions-policy": "geolocation=(), camera=(), microphone=(self)",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

app.on(["GET", "HEAD"], "*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404) return withSecurityHeaders(res);

  const url = new URL(c.req.url);
  url.pathname = "/index.html";
  return withSecurityHeaders(await c.env.ASSETS.fetch(new Request(url, c.req.raw)));
});

export default app;
