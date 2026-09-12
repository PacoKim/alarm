#!/bin/sh
# Cloudflare 최초 배포 자동 설정
#   1) D1 데이터베이스 생성 + wrangler.jsonc에 database_id 기록
#   2) 원격 DB에 마이그레이션 적용
#   3) AUTH_SECRET 시크릿 생성/등록
#   4) 배포
set -e

cd "$(dirname "$0")/.."
WRANGLER="./node_modules/.bin/wrangler"
DB_NAME="family-reminder"

echo "==> Cloudflare 로그인 상태 확인"
if ! $WRANGLER whoami >/dev/null 2>&1; then
  echo "   로그인이 필요합니다. 브라우저가 열립니다."
  $WRANGLER login
fi
$WRANGLER whoami | grep -i "account" || true

CURRENT_ID=$(node -e "
const s=require('fs').readFileSync('wrangler.jsonc','utf8');
const m=s.match(/\"database_id\":\s*\"([^\"]+)\"/);
console.log(m ? m[1] : '');
")

if [ "$CURRENT_ID" = "REPLACE_AFTER_CREATE" ] || [ -z "$CURRENT_ID" ]; then
  echo "==> D1 데이터베이스 생성: $DB_NAME"
  CREATE_OUT=$($WRANGLER d1 create "$DB_NAME" 2>&1 || true)
  echo "$CREATE_OUT"

  DB_ID=$(printf '%s' "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)

  if [ -z "$DB_ID" ]; then
    echo "   (이미 존재하는 것 같습니다. 목록에서 찾아봅니다)"
    DB_ID=$($WRANGLER d1 list --json 2>/dev/null | node -e "
      let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        try {
          const list=JSON.parse(s);
          const hit=list.find(d=>d.name===process.argv[1]);
          console.log(hit ? (hit.uuid || hit.database_id || '') : '');
        } catch { console.log(''); }
      });
    " "$DB_NAME")
  fi

  if [ -z "$DB_ID" ]; then
    echo "!! database_id를 찾지 못했습니다. 아래를 직접 실행한 뒤 wrangler.jsonc의"
    echo "   \"database_id\" 값을 채워 주세요:"
    echo "     npx wrangler d1 create $DB_NAME"
    exit 1
  fi

  echo "==> wrangler.jsonc에 database_id 기록: $DB_ID"
  node -e "
    const fs=require('fs');
    const p='wrangler.jsonc';
    const s=fs.readFileSync(p,'utf8');
    fs.writeFileSync(p, s.replace(/(\"database_id\":\s*\")[^\"]+(\")/, '\$1' + process.argv[1] + '\$2'));
  " "$DB_ID"
else
  echo "==> database_id 이미 설정됨 ($CURRENT_ID)"
fi

echo "==> 원격 D1에 마이그레이션 적용"
$WRANGLER d1 migrations apply "$DB_NAME" --remote

echo "==> AUTH_SECRET 등록"
if $WRANGLER secret list 2>/dev/null | grep -q AUTH_SECRET; then
  echo "   이미 등록되어 있어 건너뜁니다. (다시 만들려면: npx wrangler secret put AUTH_SECRET)"
else
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
  printf '%s' "$SECRET" | $WRANGLER secret put AUTH_SECRET
  echo "   등록 완료 (값은 Cloudflare에만 저장됩니다)"
fi

echo "==> 배포"
$WRANGLER deploy

echo ""
echo "완료! 위에 표시된 https://family-reminder.<계정>.workers.dev 주소를"
echo "아이폰 Safari로 열어 '가족 공간 만들기'부터 시작하세요."
