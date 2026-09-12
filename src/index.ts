import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  hashPin,
  makeJoinCode,
  randomId,
  signToken,
  verifyPin,
  verifyToken,
} from "./auth";
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
}

type Vars = { familyId: string };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/* ------------------------------ 공통 유틸 ------------------------------ */

const MEMBER_COLORS = ["#4f7cff", "#ff6b6b", "#2bb673", "#f59f00", "#a855f7", "#0ea5e9"];
const REPEATS = new Set(["none", "daily", "weekly", "monthly", "yearly"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PIN_RE = /^\d{4,8}$/;

class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 429, message: string) {
    super(message);
  }
}

function nowIso() {
  return new Date().toISOString();
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

async function requireFamily(c: any, next: () => Promise<void>) {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new HttpError(401, "로그인이 필요합니다.");
  if (!c.env.AUTH_SECRET) throw new HttpError(403, "서버에 AUTH_SECRET이 설정되지 않았습니다.");
  const familyId = await verifyToken(token, c.env.AUTH_SECRET);
  if (!familyId) throw new HttpError(401, "세션이 만료되었습니다. 다시 로그인해 주세요.");
  c.set("familyId", familyId);
  await next();
}

/* ------------------------------ 가족 생성 / 참여 ------------------------------ */

app.post("/api/family/create", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = str(body.name, "가족 이름", 40)!;
  const pin = str(body.pin, "PIN", 8)!;
  if (!PIN_RE.test(pin)) throw new HttpError(400, "PIN은 숫자 4~8자리로 만들어 주세요.");
  if (!c.env.AUTH_SECRET) throw new HttpError(403, "서버에 AUTH_SECRET이 설정되지 않았습니다.");

  const id = randomId();
  const widgetToken = randomId(24);
  const pinHash = await hashPin(pin);
  const created = nowIso();

  // 초대 코드 충돌 시 재시도
  let joinCode = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    joinCode = makeJoinCode();
    try {
      await c.env.DB.prepare(
        `INSERT INTO families (id, name, join_code, pin_hash, widget_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, name, joinCode, pinHash, widgetToken, created)
        .run();
      break;
    } catch (e) {
      if (attempt === 5) throw e;
      joinCode = "";
    }
  }
  if (!joinCode) throw new HttpError(409, "초대 코드 생성에 실패했습니다. 다시 시도해 주세요.");

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

  return c.json({
    token: await signToken(id, c.env.AUTH_SECRET),
    family: { id, name, joinCode, widgetToken },
  });
});

app.post("/api/family/join", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = str(body.joinCode, "초대 코드", 12)!.toUpperCase();
  const pin = str(body.pin, "PIN", 8)!;
  if (!c.env.AUTH_SECRET) throw new HttpError(403, "서버에 AUTH_SECRET이 설정되지 않았습니다.");

  const row = await c.env.DB.prepare(
    `SELECT id, name, join_code, pin_hash, widget_token, fail_count, locked_until
     FROM families WHERE join_code = ?`,
  )
    .bind(code)
    .first<{
      id: string;
      name: string;
      join_code: string;
      pin_hash: string;
      widget_token: string;
      fail_count: number;
      locked_until: string | null;
    }>();

  // 코드가 틀린 경우와 PIN이 틀린 경우를 구분해서 알려주지 않는다
  if (!row) throw new HttpError(401, "초대 코드 또는 PIN이 올바르지 않습니다.");

  if (row.locked_until && row.locked_until > nowIso()) {
    throw new HttpError(429, "PIN을 여러 번 틀렸습니다. 5분 후 다시 시도해 주세요.");
  }

  if (!(await verifyPin(pin, row.pin_hash))) {
    const fails = row.fail_count + 1;
    const lockUntil = fails >= 5 ? new Date(Date.now() + 5 * 60_000).toISOString() : null;
    await c.env.DB.prepare(
      `UPDATE families SET fail_count = ?, locked_until = ? WHERE id = ?`,
    )
      .bind(lockUntil ? 0 : fails, lockUntil, row.id)
      .run();
    throw new HttpError(401, "초대 코드 또는 PIN이 올바르지 않습니다.");
  }

  await c.env.DB.prepare(`UPDATE families SET fail_count = 0, locked_until = NULL WHERE id = ?`)
    .bind(row.id)
    .run();

  return c.json({
    token: await signToken(row.id, c.env.AUTH_SECRET),
    family: { id: row.id, name: row.name, joinCode: row.join_code, widgetToken: row.widget_token },
  });
});

/* ------------------------------ 전체 상태 조회 ------------------------------ */

app.get("/api/state", requireFamily, async (c) => {
  const familyId = c.get("familyId");
  const today = todayKST();
  const from = addDays(today, -1);
  const to = addDays(today, 120);

  const [family, members, events, memos] = await Promise.all([
    c.env.DB.prepare(`SELECT id, name, join_code, widget_token FROM families WHERE id = ?`)
      .bind(familyId)
      .first<{ id: string; name: string; join_code: string; widget_token: string }>(),
    c.env.DB.prepare(
      `SELECT id, name, color FROM members WHERE family_id = ? ORDER BY sort_order, created_at`,
    )
      .bind(familyId)
      .all<{ id: string; name: string; color: string }>(),
    c.env.DB.prepare(
      `SELECT id, title, date, time, end_time, location, notes, member_id, repeat, repeat_until
       FROM events
       WHERE family_id = ? AND (repeat != 'none' OR date >= ?)`,
    )
      .bind(familyId, from)
      .all<EventRow>(),
    c.env.DB.prepare(
      `SELECT id, text, pinned, done, member_id, created_at, updated_at
       FROM memos WHERE family_id = ? ORDER BY done, pinned DESC, created_at DESC`,
    )
      .bind(familyId)
      .all(),
  ]);

  if (!family) throw new HttpError(404, "가족 정보를 찾을 수 없습니다.");

  const occurrences = expandOccurrences(events.results ?? [], from, to).map((o) => ({
    ...o,
    date: o.occurs_on,
    dayLabel: dayLabel(o.occurs_on, today),
    timeLabel: timeLabel(o.time),
  }));

  return c.json({
    family: {
      id: family.id,
      name: family.name,
      joinCode: family.join_code,
      widgetToken: family.widget_token,
    },
    today,
    members: members.results ?? [],
    events: occurrences,
    memos: memos.results ?? [],
  });
});

/* ------------------------------ 구성원 ------------------------------ */

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

app.delete("/api/members/:id", requireFamily, async (c) => {
  const res = await c.env.DB.prepare(`DELETE FROM members WHERE id = ? AND family_id = ?`)
    .bind(c.req.param("id"), c.get("familyId"))
    .run();
  if (!res.meta.changes) throw new HttpError(404, "구성원을 찾을 수 없습니다.");
  return c.json({ ok: true });
});

/* ------------------------------ 일정 ------------------------------ */

async function assertMember(db: D1Database, familyId: string, memberId: string | null) {
  if (!memberId) return null;
  const row = await db
    .prepare(`SELECT id FROM members WHERE id = ? AND family_id = ?`)
    .bind(memberId, familyId)
    .first();
  if (!row) throw new HttpError(400, "선택한 구성원을 찾을 수 없습니다.");
  return memberId;
}

app.post("/api/events", requireFamily, async (c) => {
  const familyId = c.get("familyId");
  const body = await c.req.json().catch(() => ({}));

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
       (id, family_id, title, date, time, end_time, location, notes, member_id, repeat, repeat_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, familyId, title, date, time, endTime, location, notes, memberId, repeat, repeatUntil, ts, ts)
    .run();

  return c.json({ id });
});

app.patch("/api/events/:id", requireFamily, async (c) => {
  const familyId = c.get("familyId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const existing = await c.env.DB.prepare(
    `SELECT id FROM events WHERE id = ? AND family_id = ?`,
  )
    .bind(id, familyId)
    .first();
  if (!existing) throw new HttpError(404, "일정을 찾을 수 없습니다.");

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

  if (!sets.length) throw new HttpError(400, "변경할 내용이 없습니다.");
  put("updated_at", nowIso());

  await c.env.DB.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ? AND family_id = ?`)
    .bind(...args, id, familyId)
    .run();

  return c.json({ ok: true });
});

app.delete("/api/events/:id", requireFamily, async (c) => {
  const res = await c.env.DB.prepare(`DELETE FROM events WHERE id = ? AND family_id = ?`)
    .bind(c.req.param("id"), c.get("familyId"))
    .run();
  if (!res.meta.changes) throw new HttpError(404, "일정을 찾을 수 없습니다.");
  return c.json({ ok: true });
});

/* ------------------------------ 메모 ------------------------------ */

app.post("/api/memos", requireFamily, async (c) => {
  const familyId = c.get("familyId");
  const body = await c.req.json().catch(() => ({}));
  const text = str(body.text, "메모 내용", 300)!;
  const memberId = await assertMember(c.env.DB, familyId, str(body.memberId, "담당", 40, false));
  const pinned = body.pinned ? 1 : 0;

  const id = randomId();
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO memos (id, family_id, text, pinned, done, member_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(id, familyId, text, pinned, memberId, ts, ts)
    .run();

  return c.json({ id });
});

app.patch("/api/memos/:id", requireFamily, async (c) => {
  const familyId = c.get("familyId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const existing = await c.env.DB.prepare(`SELECT id FROM memos WHERE id = ? AND family_id = ?`)
    .bind(id, familyId)
    .first();
  if (!existing) throw new HttpError(404, "메모를 찾을 수 없습니다.");

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
  if (!sets.length) throw new HttpError(400, "변경할 내용이 없습니다.");

  sets.push("updated_at = ?");
  args.push(nowIso());

  await c.env.DB.prepare(`UPDATE memos SET ${sets.join(", ")} WHERE id = ? AND family_id = ?`)
    .bind(...args, id, familyId)
    .run();

  return c.json({ ok: true });
});

app.delete("/api/memos/:id", requireFamily, async (c) => {
  const res = await c.env.DB.prepare(`DELETE FROM memos WHERE id = ? AND family_id = ?`)
    .bind(c.req.param("id"), c.get("familyId"))
    .run();
  if (!res.meta.changes) throw new HttpError(404, "메모를 찾을 수 없습니다.");
  return c.json({ ok: true });
});

/* ------------------------------ 위젯용 읽기 전용 엔드포인트 ------------------------------ */

app.use("/api/widget/*", cors({ origin: "*", allowMethods: ["GET"] }));

app.get("/api/widget/:token", async (c) => {
  const token = c.req.param("token");
  const family = await c.env.DB.prepare(
    `SELECT id, name FROM families WHERE widget_token = ?`,
  )
    .bind(token)
    .first<{ id: string; name: string }>();
  if (!family) throw new HttpError(404, "위젯 토큰이 올바르지 않습니다.");

  const today = todayKST();
  const to = addDays(today, 21);

  const [events, memos, members] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, title, date, time, end_time, location, notes, member_id, repeat, repeat_until
       FROM events WHERE family_id = ? AND (repeat != 'none' OR date >= ?)`,
    )
      .bind(family.id, today)
      .all<EventRow>(),
    c.env.DB.prepare(
      `SELECT id, text, pinned, member_id FROM memos
       WHERE family_id = ? AND done = 0
       ORDER BY pinned DESC, created_at DESC LIMIT 12`,
    )
      .bind(family.id)
      .all<{ id: string; text: string; pinned: number; member_id: string | null }>(),
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

app.all("/api/*", (c) => c.json({ error: "요청한 API를 찾을 수 없습니다." }, 404));

app.get("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404) return res;
  const url = new URL(c.req.url);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url, c.req.raw));
});

export default app;
