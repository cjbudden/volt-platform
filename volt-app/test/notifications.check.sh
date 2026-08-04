#!/usr/bin/env bash
# Notification API: templated send fans out to recipient×channel deliveries;
# a failing recipient is recorded + retried; in-app inbox lists deliveries.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret} JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh} INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${PORT:-8102} ORCH_LAUNCHER=mock
A=00000000-0000-0000-0000-0000000000a1; U=00000000-0000-0000-0000-0000000000f1
pass=0; fail=0; ok(){ echo "  ✓ $1"; pass=$((pass+1)); }; no(){ echo "  ✗ $1"; fail=$((fail+1)); }
jf(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(eval('JSON.parse(s)'+process.argv[1]))}catch(e){console.log('ERR')}})" "$1"; }

psql "$DATABASE_URL" -q -f migrations/0001_init.sql
psql "$DATABASE_URL" -q -c "
INSERT INTO accounts(id,name) VALUES ('$A','RTM');
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$U','$A','ops@rtm.example','x','owner','active');"

fuser -k "$PORT"/tcp 2>/dev/null || true; sleep 1
npx tsx src/index.ts >/tmp/volt-notif.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 1; done
T=$(node -e "console.log(require('jsonwebtoken').sign({sub:'$U',account_id:'$A',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))")
BASE="http://localhost:$PORT"; JS="Content-Type: application/json"; AUTH="Authorization: Bearer $T"

echo "== template + templated send =="
curl -s -X POST -H "$AUTH" -H "$JS" $BASE/api/notification-templates -d '{"key":"event.reminder","subject":"Reminder: {{name}}","body":"{{name}} starts at {{time}}"}' >/dev/null
SEND=$(curl -s -X POST -H "$AUTH" -H "$JS" $BASE/api/notifications -d '{"topic":"event.reminder","templateKey":"event.reminder","payload":{"name":"Grand Final","time":"8pm"},"recipients":["ops@rtm.example","fail@rtm.example"],"channels":["email","in_app"]}')
NID=$(echo "$SEND" | jf '.id')
[ "$(echo "$SEND" | jf '.deliveries')" = "4" ] && ok "send fanned out to 4 deliveries (2 recipients × 2 channels)" || no "delivery count: $SEND"

echo "== per-delivery status + template render =="
DET=$(curl -s -H "$AUTH" $BASE/api/notifications/$NID)
echo "$DET" | grep -q 'Reminder: Grand Final' && ok "subject rendered from template + payload" || no "template not rendered: $(echo "$DET"|head -c120)"
SENT=$(echo "$DET" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).deliveries.filter(d=>d.status==='sent').length))")
FAILED=$(echo "$DET" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).deliveries.filter(d=>d.status==='failed').length))")
[ "$SENT" = "3" ] && ok "3 deliveries sent (good×2 + fail's in_app)" || no "sent count=$SENT"
[ "$FAILED" = "1" ] && ok "1 delivery failed (fail@ email) + recorded" || no "failed count=$FAILED"
echo "$DET" | grep -q 'smtp rejected' && ok "failure reason recorded on the delivery" || no "no last_error"

echo "== in-app inbox =="
INBOX=$(curl -s -H "$AUTH" "$BASE/api/notifications/inbox?recipient=ops@rtm.example")
[ "$(echo "$INBOX" | jf '.items.length')" = "1" ] && ok "inbox shows the in-app delivery" || no "inbox count: $INBOX"
[ "$(echo "$INBOX" | jf '.unread')" = "1" ] && ok "inbox unread count = 1" || no "unread wrong"

echo "== retry failed =="
R=$(curl -s -X POST -H "$AUTH" -H "$JS" $BASE/api/notifications/retry -d '{}')
[ "$(echo "$R" | jf '.retried')" = "1" ] && ok "retry re-attempted the 1 failed delivery" || no "retry count: $R"
ATT=$(curl -s -H "$AUTH" $BASE/api/notifications/$NID | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(Math.max(...JSON.parse(s).deliveries.map(d=>d.attempts)))) ")
[ "$ATT" = "2" ] && ok "failed delivery attempts incremented to 2" || no "attempts=$ATT"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
