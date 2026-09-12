/**
 * D1 기반 고정 시간창(fixed window) 요청 제한.
 *
 * Cloudflare의 Rate Limiting 바인딩 대신 D1을 쓰는 이유는 로컬 개발에서도
 * 동일하게 동작하고, 제한 상태를 직접 조회·초기화할 수 있어서다.
 * 인증 관련 호출은 빈도가 낮으므로 쓰기 비용도 문제되지 않는다.
 */

export interface LimitResult {
  ok: boolean;
  /** 이번 시간창에서 지금까지 쓴 횟수 */
  count: number;
  /** 제한에 걸렸을 때 몇 초 뒤에 풀리는지 */
  retryAfter: number;
}

export async function rateLimit(
  db: D1Database,
  scope: string,
  ip: string,
  limit: number,
  windowSec: number,
): Promise<LimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const key = `${scope}:${ip}`;

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE
                   WHEN rate_limits.window_start = excluded.window_start
                   THEN rate_limits.count + 1
                   ELSE 1
                 END,
         window_start = excluded.window_start
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();

  const count = row?.count ?? 1;
  return {
    ok: count <= limit,
    count,
    retryAfter: windowStart + windowSec - now,
  };
}

/** 오래된 카운터를 이따금 정리한다 (별도 cron 없이 운영하기 위함) */
export async function sweepRateLimits(db: D1Database, olderThanSec = 3600): Promise<void> {
  if (Math.random() > 0.02) return; // 약 2% 확률로만 실행
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSec;
  try {
    await db.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).bind(cutoff).run();
  } catch {
    // 정리 실패는 요청 처리에 영향을 주지 않는다
  }
}
