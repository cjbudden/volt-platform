#!/usr/bin/env bash
# SaaS-admin 2-step login: password → enrol authenticator → TOTP → platform session.
# Also: wrong password 401, non-platform user 401, wrong code 401, session reaches
# the platform dashboard. Needs DATABASE_URL -> empty Postgres.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret} JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh} INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${PORT:-8100} ORCH_LAUNCHER=mock
A=00000000-0000-0000-0000-0000000000a1; SA=00000000-0000-0000-0000-0000000000f1; CL=00000000-0000-0000-0000-0000000000f2
pass=0; fail=0; ok(){ echo "  ✓ $1"; pass=$((pass+1)); }; no(){ echo "  ✗ $1"; fail=$((fail+1)); }
jf(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(eval('JSON.parse(s)'+process.argv[1]))}catch(e){console.log('ERR')}})" "$1"; }

# password hash for 'secret123' (argon2id) via the app's own lib
PW=$(node -e "require('argon2').hash('secret123',{type:require('argon2').argon2id}).then(h=>process.stdout.write(h))")
psql "$DATABASE_URL" -q -f migrations/0001_init.sql
psql "$DATABASE_URL" -q -c "
INSERT INTO accounts(id,name) VALUES ('$A','RTM');
INSERT INTO users(id,account_id,email,password_hash,role,status,platform_role) VALUES
 ('$SA','$A','saas@volt.example','$PW','owner','active','saas_admin'),
 ('$CL','$A','client@volt.example','$PW','owner','active',NULL);"

fuser -k "$PORT"/tcp 2>/dev/null || true; sleep 1
npx tsx src/index.ts >/tmp/volt-mfa.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 1; done
BASE="http://localhost:$PORT"; JS="Content-Type: application/json"
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== step 1: password =="
[ "$(code -X POST -H "$JS" $BASE/api/platform/auth/login -d '{"email":"saas@volt.example","password":"wrong"}')" = "401" ] && ok "wrong password → 401" || no "wrong password not rejected"
[ "$(code -X POST -H "$JS" $BASE/api/platform/auth/login -d '{"email":"client@volt.example","password":"secret123"}')" = "401" ] && ok "non-platform user → 401 (separate SaaS-admin surface)" || no "client reached platform auth"
L1=$(curl -s -X POST -H "$JS" $BASE/api/platform/auth/login -d '{"email":"saas@volt.example","password":"secret123"}')
echo "$L1" | grep -q '"enroll":true' && ok "first login → enrol authenticator" || no "no enrol: $L1"
SECRET=$(echo "$L1" | jf '.secret'); MFAT=$(echo "$L1" | jf '.mfaToken')
echo "$SECRET" | grep -qE '^[A-Z2-7]+$' && ok "TOTP secret issued (base32)" || no "no secret"

echo "== step 2: TOTP → platform session =="
[ "$(code -X POST -H "$JS" $BASE/api/platform/auth/mfa -d "{\"mfaToken\":\"$MFAT\",\"code\":\"000000\"}")" = "401" ] && ok "wrong TOTP code → 401" || no "wrong code accepted"
CODE=$(npx tsx test/gen-totp.ts "$SECRET")
M=$(curl -s -X POST -H "$JS" $BASE/api/platform/auth/mfa -d "{\"mfaToken\":\"$MFAT\",\"code\":\"$CODE\"}")
AT=$(echo "$M" | jf '.accessToken')
[ -n "$AT" ] && [ "$AT" != "ERR" ] && ok "valid TOTP → platform session issued" || no "no session: $M"

echo "== session reaches the SaaS dashboard =="
[ "$(code -H "Authorization: Bearer $AT" $BASE/api/platform/overview)" = "200" ] && ok "platform session → /api/platform/overview 200" || no "session cannot reach dashboard"

echo "== second login is now mfa_required (enrolled) =="
L2=$(curl -s -X POST -H "$JS" $BASE/api/platform/auth/login -d '{"email":"saas@volt.example","password":"secret123"}')
echo "$L2" | grep -q '"mfa_required":true' && ok "enrolled user → mfa_required (no re-enrol)" || no "second login wrong: $L2"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
