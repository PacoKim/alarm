/**
 * 알림 발송 워커 (예약 실행 전용)
 *
 * Cloudflare Pages에는 예약 실행(Cron)이 없어서, 앱과 같은 D1을 공유하는
 * 별도 워커로 분리했다. 공개 주소(route)는 두지 않고 스케줄로만 깨어난다.
 *
 * 5분마다 실행되며 세 종류의 알림을 보낸다.
 *   lead    시각이 있는 일정 → 시작 N분 전
 *   allday  종일 일정        → 당일 지정 시각
 *   morning 아침 요약        → 지정 시각에 오늘 일정 한 번에
 *
 * 같은 알림을 두 번 보내지 않도록 notify_log 에 키를 남긴다.
 * 틱을 한 번 놓쳐도 다음 틱에서 따라잡되, 너무 늦은 것은 보내지 않는다.
 */
import { buildPushPayload } from "@block65/webcrypto-web-push";
import { addDays, expandOccurrences, timeLabel, todayKST, type EventRow } from "./dates";

export interface NotifierEnv {
  DB: D1Database;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

const TICK_MINUTES = 5;
/** 예정 시각을 이만큼 넘겼으면 이미 지난 알림으로 보고 건너뛴다 */
const LATE_TOLERANCE_MIN = 20;

interface FamilyRow {
  id: string;
  name: string;
  notify_enabled: number;
  notify_lead_min: number;
  notify_allday_at: string;
  notify_morning: string | null;
}

interface SubRow {
  id: string;
  member_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  fail_count: number;
}

/* ---------- 한국시간 헬퍼 ---------- */

function nowMinutesKST(now: Date): number {
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * 예정 시각(분)이 이번 틱에서 보낼 대상인지.
 * [now - TICK, now + LATE_TOLERANCE] 이 아니라
 * "이미 지났고 너무 늦지는 않은" 구간을 본다.
 */
function isDue(scheduledMin: number, nowMin: number): boolean {
  const diff = nowMin - scheduledMin;
  return diff >= 0 && diff < TICK_MINUTES + LATE_TOLERANCE_MIN;
}

/* ---------- 발송 ---------- */

interface Notice {
  title: string;
  body: string;
  tag: string;
  /** null 이면 가족 전체, 값이 있으면 그 구성원에게만 */
  onlyMember: string | null;
  logKey: string;
}

async function sendToSubs(
  env: NotifierEnv,
  subs: SubRow[],
  notice: Notice,
): Promise<{ sent: number; gone: number; failed: number }> {
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  let sent = 0;
  let gone = 0;
  let failed = 0;

  const targets = notice.onlyMember
    ? subs.filter((s) => s.member_id === notice.onlyMember)
    : subs;

  for (const sub of targets) {
    const subscription = {
      endpoint: sub.endpoint,
      expirationTime: null,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };

    try {
      const payload = await buildPushPayload(
        {
          data: { title: notice.title, body: notice.body, tag: notice.tag },
          options: { ttl: 3600, urgency: "normal" },
        },
        subscription,
        vapid,
      );

      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: payload.headers,
        body: payload.body,
      });

      if (res.ok) {
        sent++;
        await env.DB.prepare(
          `UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE id = ?`,
        )
          .bind(new Date().toISOString(), sub.id)
          .run();
      } else if (res.status === 404 || res.status === 410) {
        // 구독이 사라진 기기 (앱 삭제·권한 해제) → 정리한다
        gone++;
        await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).bind(sub.id).run();
      } else {
        failed++;
        console.log(`push failed ${res.status} ${await res.text().catch(() => "")}`);
        await env.DB.prepare(
          `UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?`,
        )
          .bind(sub.id)
          .run();
      }
    } catch (err) {
      failed++;
      console.log("push error", String(err));
    }
  }

  return { sent, gone, failed };
}

async function alreadySent(env: NotifierEnv, key: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT key FROM notify_log WHERE key = ?`)
    .bind(key)
    .first();
  return !!row;
}

async function markSent(env: NotifierEnv, key: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notify_log (key, sent_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`,
  )
    .bind(key, new Date().toISOString())
    .run();
}

/* ---------- 가족 한 곳 처리 ---------- */

async function processFamily(env: NotifierEnv, family: FamilyRow, now: Date) {
  const today = todayKST(now);
  const nowMin = nowMinutesKST(now);

  const subs = (
    await env.DB.prepare(
      `SELECT id, member_id, endpoint, p256dh, auth, fail_count
       FROM push_subscriptions WHERE family_id = ? AND fail_count < 10`,
    )
      .bind(family.id)
      .all<SubRow>()
  ).results ?? [];

  if (!subs.length) return { sent: 0, skipped: "구독 없음" };

  // 오늘 일정만 필요하다 (반복 포함)
  const rows = (
    await env.DB.prepare(
      `SELECT id, title, date, time, end_time, location, notes, member_id,
              repeat, repeat_until, owner_id, visibility
       FROM events WHERE family_id = ? AND (repeat != 'none' OR date >= ?)`,
    )
      .bind(family.id, today)
      .all<EventRow>()
  ).results ?? [];

  const todays = expandOccurrences(rows, today, today);
  const notices: Notice[] = [];

  for (const ev of todays) {
    const onlyMember = ev.visibility === "private" ? (ev.owner_id ?? null) : null;

    if (ev.time) {
      const due = toMinutes(ev.time) - family.notify_lead_min;
      if (isDue(due, nowMin)) {
        const lead = family.notify_lead_min;
        notices.push({
          title: lead === 0 ? `지금 · ${ev.title}` : `${lead}분 후 · ${ev.title}`,
          body: [timeLabel(ev.time), ev.location].filter(Boolean).join(" · "),
          tag: `ev-${ev.id}-${ev.occurs_on}`,
          onlyMember,
          logKey: `lead:${ev.id}:${ev.occurs_on}`,
        });
      }
    } else if (isDue(toMinutes(family.notify_allday_at), nowMin)) {
      notices.push({
        title: `오늘 · ${ev.title}`,
        body: ev.location ?? "종일 일정",
        tag: `ev-${ev.id}-${ev.occurs_on}`,
        onlyMember,
        logKey: `allday:${ev.id}:${ev.occurs_on}`,
      });
    }
  }

  // 아침 요약
  if (family.notify_morning && isDue(toMinutes(family.notify_morning), nowMin)) {
    const shared = todays.filter((e) => e.visibility !== "private");
    const lines = shared
      .slice(0, 5)
      .map((e) => `${e.time ? timeLabel(e.time) : "종일"} ${e.title}`);
    notices.push({
      title: shared.length
        ? `오늘 일정 ${shared.length}개`
        : "오늘은 등록된 일정이 없어요",
      body: lines.join("\n") || "편하게 보내세요 🌿",
      tag: `morning-${today}`,
      onlyMember: null,
      logKey: `morning:${family.id}:${today}`,
    });
  }

  let sent = 0;
  for (const notice of notices) {
    if (await alreadySent(env, notice.logKey)) continue;
    // 먼저 기록해 중복 발송을 막는다 (발송 실패보다 중복이 더 나쁘다)
    await markSent(env, notice.logKey);
    const r = await sendToSubs(env, subs, notice);
    sent += r.sent;
    console.log(
      `[${family.name}] ${notice.logKey} → 발송 ${r.sent} · 만료정리 ${r.gone} · 실패 ${r.failed}`,
    );
  }

  return { sent, skipped: null };
}

/* ---------- 오래된 기록 정리 ---------- */

async function sweep(env: NotifierEnv): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  await env.DB.prepare(`DELETE FROM notify_log WHERE sent_at < ?`).bind(cutoff).run();
}

/* ---------- 엔트리 ---------- */

export default {
  async scheduled(_event: ScheduledController, env: NotifierEnv, ctx: ExecutionContext) {
    ctx.waitUntil(run(env));
  },

  // 수동 점검용. 배포 시 route 를 두지 않으므로 공개 주소는 없다.
  async fetch(_req: Request, env: NotifierEnv): Promise<Response> {
    const result = await run(env);
    return Response.json(result);
  },
};

async function run(env: NotifierEnv) {
  const now = new Date();
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
    console.log("VAPID 키가 설정되지 않아 건너뜀");
    return { ok: false, reason: "no vapid keys" };
  }

  const families = (
    await env.DB.prepare(
      `SELECT id, name, notify_enabled, notify_lead_min, notify_allday_at, notify_morning
       FROM families WHERE notify_enabled = 1`,
    ).all<FamilyRow>()
  ).results ?? [];

  let total = 0;
  for (const family of families) {
    try {
      const r = await processFamily(env, family, now);
      total += r.sent;
    } catch (err) {
      console.log(`[${family.name}] 처리 실패`, String(err));
    }
  }

  await sweep(env);
  return { ok: true, families: families.length, sent: total, at: now.toISOString() };
}
