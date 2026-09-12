# 우리가족 알림

가족이 일정과 메모를 한곳에 모으고, **아이폰 잠금화면 / 홈화면 위젯**으로 바로 확인하는 앱.
백엔드와 웹앱은 **Cloudflare Workers + D1**에 배포된다.

```
아이폰 잠금화면 위젯  ─┐
아이폰 홈화면 위젯    ─┼─→  Cloudflare Worker (API)  ──→  D1 (SQLite)
웹앱 / PWA (iOS·안드로이드) ─┘
```

| 구성 | 위치 | 역할 |
|---|---|---|
| API + 정적 호스팅 | [src/index.ts](src/index.ts) | 일정·메모 CRUD, 가족 인증, 위젯 전용 읽기 엔드포인트 |
| 반복 일정·날짜 처리 | [src/dates.ts](src/dates.ts) | 한국시간 기준 날짜 계산, 반복 일정 전개 |
| 인증 | [src/auth.ts](src/auth.ts) | PIN 해싱(PBKDF2), 세션 토큰(HMAC) |
| 웹앱 | [public/](public/) | 일정·메모 입력 화면 (PWA, 오프라인 지원) |
| 아이폰 위젯 | [scriptable/우리가족위젯.js](scriptable/우리가족위젯.js) | 잠금화면·홈화면 위젯 |
| DB 스키마 | [migrations/0001_init.sql](migrations/0001_init.sql) | families / members / events / memos |

---

## 1. 배포 (한 번만)

```bash
cd ~/family-reminder && npm run setup
```

이 명령이 순서대로 처리한다.

1. Cloudflare 로그인 (브라우저가 열림)
2. D1 데이터베이스 `family-reminder` 생성 후 `wrangler.jsonc`에 ID 기록
3. 원격 DB에 테이블 생성
4. `AUTH_SECRET` 시크릿 자동 생성·등록
5. 배포

끝나면 `https://family-reminder.<계정>.workers.dev` 주소가 출력된다.

<details>
<summary>수동으로 하려면</summary>

```bash
npx wrangler login
npx wrangler d1 create family-reminder          # 출력된 database_id를 wrangler.jsonc에 붙여넣기
npx wrangler d1 migrations apply family-reminder --remote
npx wrangler secret put AUTH_SECRET             # 32바이트 랜덤 문자열
npx wrangler deploy
```
</details>

**내 도메인을 쓰려면** — Cloudflare 대시보드 → Workers & Pages → `family-reminder` →
Settings → Domains & Routes에서 `family.example.com` 같은 주소를 연결한다.
(도메인이 Cloudflare에 등록되어 있어야 한다.)

---

## 2. 가족 공간 만들기

1. 배포된 주소를 **아이폰 Safari**로 열기
2. **가족 공간 만들기** → 가족 이름 / 구성원 이름 / 공용 PIN(숫자 4~8자리) 입력
3. 화면에 뜨는 **초대 코드**(6자리)와 PIN을 가족에게 알려준다
4. 가족은 같은 주소에서 **초대 코드로 참여하기** → 코드 + PIN 입력

### 홈화면에 앱처럼 추가
- **아이폰**: Safari에서 열고 공유 버튼 → `홈 화면에 추가`
- **안드로이드**: Chrome에서 열고 메뉴 → `앱 설치` 또는 `홈 화면에 추가`

---

## 3. 아이폰 위젯 설치

### 준비
1. App Store에서 **Scriptable**(무료) 설치
2. 웹앱 → 우측 상단 **⚙ 설정** → **위젯 주소 복사**
3. Scriptable 앱 → 우측 상단 **+** → [scriptable/우리가족위젯.js](scriptable/우리가족위젯.js) 내용을 전체 붙여넣기
4. 스크립트 이름을 **우리가족위젯**으로 지정하고, 한 번 실행(▶)해서 복사한 위젯 주소를 붙여넣기

> 위젯 주소는 **읽기 전용**이다. 이 주소로는 일정을 보거나 가져갈 수만 있고 수정·삭제는 불가능하다.

### 잠금화면 위젯
잠금화면 길게 누르기 → **사용자화** → **잠금화면** → 시계 아래 위젯 영역 탭
→ **Scriptable** 선택 → 추가된 위젯을 한 번 더 탭 → Script에 **우리가족위젯** 지정

| 위젯 모양 | 표시 내용 |
|---|---|
| 한 줄 (시계 위) | 다음 일정 하나 — `내일 18:00 지훈이 치과 예약` |
| 원형 | 오늘 남은 일정 개수 |
| 사각형 | 다음 일정 2개 + 고정한 메모 1개 |

### 홈화면 위젯
홈화면 빈 곳 길게 누르기 → **+** → **Scriptable** → 크기 선택 → 위젯 길게 누르기
→ **위젯 편집** → Script에 **우리가족위젯** 지정

| 크기 | 표시 내용 |
|---|---|
| 소 | 다음 일정 3개 (또는 일정 2개 + 메모) |
| 중 | 다음 일정 4개 + 메모 2개 |
| 대 | 오늘 일정 · 다가오는 일정 6개 · 메모 5개 |

### 위젯 내용 바꾸기 (선택)
위젯 편집 화면의 **Parameter** 칸에 입력한다.

| 입력값 | 결과 |
|---|---|
| (비움) | 일정 + 메모 함께 |
| `memo` | 메모만 |
| `event` | 일정만 |

메모 전용 위젯과 일정 전용 위젯을 따로 두고 싶을 때 쓴다.

### 위젯 갱신 주기
iOS가 위젯 갱신 시점을 직접 정하기 때문에 보통 **15분~1시간** 간격으로 반영된다.
바로 확인하려면 위젯을 탭해서 웹앱을 열면 된다. 네트워크가 끊기면 마지막으로 받은 내용을
그대로 보여주고 `오프라인`으로 표시한다.

---

## 4. 안드로이드

안드로이드는 웹앱(PWA)으로 쓴다. 홈화면에 추가하면 아이콘·전체화면으로 앱처럼 동작하고,
같은 초대 코드로 아이폰 가족과 동일한 일정·메모를 본다.

안드로이드 **홈화면 위젯**은 별도 작업이 필요하다. 필요해지면 두 가지 길이 있다.
- 간단: KWGT 같은 위젯 앱에서 위젯 주소(JSON)를 불러 표시
- 제대로: 작은 네이티브 위젯 앱 제작 (같은 API를 그대로 사용)

---

## 5. 개발

```bash
npm run dev          # http://localhost:8788 (로컬 D1 사용)
npm run db:local     # 로컬 DB에 마이그레이션 적용
npm run typecheck    # 타입 검사
npm run icons        # 아이콘 재생성
npm run logs         # 배포된 Worker 실시간 로그
npm run deploy       # 재배포
```

로컬 개발용 `AUTH_SECRET`은 `.dev.vars`에 들어 있다(git 제외).

### 날짜를 문자열로 다루는 이유
일정은 `date`(`2026-09-12`)와 `time`(`18:00`)을 **한국시간 기준 문자열**로 저장한다.
타임스탬프를 쓰면 서버·기기·위젯의 타임존이 어긋날 때 "하루 밀린 일정"이 생기는데,
가족 전원이 한국에 있으므로 문자열 저장이 그 문제를 원천적으로 없앤다.
문자열 비교가 곧 날짜 순서라서 정렬과 범위 조회도 단순해진다.

### 반복 일정
`repeat`은 `none|daily|weekly|monthly|yearly`. 저장은 원본 1건만 하고,
조회 시점에 [src/dates.ts](src/dates.ts)의 `expandOccurrences()`가 필요한 구간만 펼친다.
매월 31일처럼 없는 날짜는 그 달을 건너뛴다.

---

## 6. 보안

- 가족 공간은 **초대 코드 + 공용 PIN**으로 들어간다. PIN은 PBKDF2(12만 회)로 해싱해 저장한다.
- PIN을 5회 연속 틀리면 해당 가족 공간이 **5분간 잠긴다**.
- 로그인하면 180일짜리 HMAC 서명 토큰이 기기에 저장된다.
- 위젯 주소는 읽기 전용이며, 유출되면 웹앱 설정에서 가족 공간을 다시 만들어 교체한다.
- 가족끼리 공유하는 공간이라 구성원 개별 계정·권한 구분은 없다. 모두 같은 일정·메모를 보고 수정한다.

---

## 앞으로 붙일 수 있는 것

- **시간 맞춰 알림 보내기** — Worker Cron + 웹 푸시(안드로이드·PC)와 iOS 알림
- **아이폰 기본 캘린더 동기화** — Scriptable에서 `CalendarEvent` API로 양방향 반영
- 사진·파일 첨부 (Cloudflare R2)
- 구성원별 위젯 (내 일정만 보이는 위젯)
