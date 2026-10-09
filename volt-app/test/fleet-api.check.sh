#!/usr/bin/env bash
# ============================================================================
#  THE FLEET API — and the one thing it must never get wrong.
#
#  A compute host is SHARED INFRASTRUCTURE. It is not owned by a tenant, so it
#  cannot simply be filtered by account the way a channel can, and that makes
#  /api/fleet/hosts the only endpoint in this codebase where the tenant
#  boundary is not a straight WHERE account_id = $1.
#
#  What a tenant may see is:
#    - the hosts carrying THEIR work, and no others;
#    - those hosts' TRUE capacity figures, including work belonging to other
#      tenants, because a machine at 94% is your problem even when only one of
#      its nine streams is yours;
#    - only their OWN streams named on it.
#
#  Getting that wrong in either direction is bad in a different way. Too
#  strict, and a shared host looks idle to the tenant about to be affected by
#  it. Too loose, and one customer reads another customer's channel names off
#  a capacity screen. This suite asserts both directions with two accounts on
#  one machine, which is the only arrangement that can tell them apart.
#
#  It also covers the boring-but-load-bearing parts: usage is scoped, the
#  endpoints refuse an anonymous caller, and a bad period is rejected rather
#  than interpolated into date_trunc.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
. "$(dirname "$0")/lib/portable.sh"   # setsid/timeout/stat differ on macOS; see that file
: "${DATABASE_URL:?set DATABASE_URL}"

PORT=8143
WORK=$(mktemp -d)
# NOTE the guard on SRV. `kill -TERM -0` is not a no-op: 0 means "my own
# process group", so an unguarded cleanup on an early exit -- a seed that
# failed, a port already in use -- signals the test runner itself, and the
# suite looks like it hung rather than like it bailed out.
cleanup(){ [ -n "${SRV:-}" ] && kill -TERM -"$SRV" 2>/dev/null; rm -rf "$WORK"; return 0; }
trap cleanup EXIT

pass=0; fail=0
ok(){ if eval "$2"; then echo "  PASS $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

# Two accounts, two channels, ONE shared host.
A1=00000000-0000-0000-0000-00000994a001
A2=00000000-0000-0000-0000-00000994a002
U1=00000000-0000-0000-0000-00000994f001
U2=00000000-0000-0000-0000-00000994f002
G1=00000000-0000-0000-0000-00000994b001
G2=00000000-0000-0000-0000-00000994b002
C1=00000000-0000-0000-0000-00000994c001
C2=00000000-0000-0000-0000-00000994c002
H=00000000-0000-0000-0000-00000994e001
I1=00000000-0000-0000-0000-00000994d001
I2=00000000-0000-0000-0000-00000994d002

psql "$DATABASE_URL" -q -c "
DELETE FROM accounts WHERE id IN ('$A1','$A2');
DELETE FROM compute_hosts WHERE id='$H';
INSERT INTO accounts(id,name) VALUES ('$A1','Alpha'),('$A2','Beta');
INSERT INTO users(id,account_id,email,password_hash,role,status)
  VALUES ('$U1','$A1','a@x','x','owner','active'),('$U2','$A2','b@x','x','owner','active');
INSERT INTO groups(id,account_id,name) VALUES ('$G1','$A1','g1'),('$G2','$A2','g2');
INSERT INTO channels(id,group_id,name,status,kind)
  VALUES ('$C1','$G1','Alpha News','live','tv'),('$C2','$G2','Beta Secret Channel','live','tv');
INSERT INTO compute_hosts(id,kind,external_id,instance_type,availability_zone,region,lifecycle,vcpus,memory_mib)
  VALUES ('$H','ec2','i-fleetapi000001','c6i.2xlarge','ap-southeast-1a','ap-southeast-1','on_demand',8,16384);
" >/dev/null 2>&1 || { echo "FATAL could not seed"; echo; echo "== RESULT: 0 passed, 1 failed =="; exit 1; }

if curl -fsS --max-time 1 "localhost:$PORT/health" >/dev/null 2>&1; then
  echo "SKIP something is already listening on :$PORT"
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0
fi

export PORT JWT_ACCESS_SECRET=fleetsecret JWT_REFRESH_SECRET=y INGEST_TOKEN=z
# A LONG TICK, ON PURPOSE. The orchestrator reaps instance rows the launcher
# does not vouch for, and a mock launcher vouches for nothing it did not itself
# issue in this process -- which is correct, and is the fix for stations that
# showed as recording forever. It also means fixture rows written straight into
# the table are, correctly, dead. They are inserted AFTER boot and the tick is
# pushed out of the way so the fixture survives long enough to be queried.
#
# AUTO CONNECT IS OFF for the same reason: its pass runs on its own twenty
# second interval and would try to restart the fixture channels out from under
# the assertions.
export ORCH_TICK_SECONDS=3600 AUTO_CONNECT=false
export ORCH_LAUNCHER=mock WEB_DIST_DIR=
vsetsid npx tsx src/index.ts >"$WORK/api.log" 2>&1 &
SRV=$!
# WAIT FOR RECONCILED, NOT MERELY FOR HEALTHY. The process starts listening
# well before boot reconciliation finishes, and that pass closes exactly the
# kind of unvouched-for instance row this fixture is about to write. Seeding on
# `ok` alone is a race the fixture loses: the rows go in, the reaper closes them
# a beat later, and every host assertion then sees an empty fleet.
for i in $(seq 1 80); do
  curl -fsS --max-time 2 "localhost:$PORT/health" 2>/dev/null | grep -q '"reconciled":true' && break
  sleep 0.5
done
if ! curl -fsS --max-time 2 "localhost:$PORT/health" 2>/dev/null | grep -q '"reconciled":true'; then
  echo "FATAL the control plane did not finish boot reconciliation:"; tail -8 "$WORK/api.log"
  echo; echo "== RESULT: 0 passed, 1 failed =="; exit 1
fi

# The task rows and their telemetry, written now that boot reconciliation has
# finished. See the ORCH_TICK_SECONDS note above.
psql "$DATABASE_URL" -q -c "
INSERT INTO instances(id,channel_id,task_arn,is_gpu,lifecycle,role,task_kind,state,launched_at,host_id)
  VALUES ('$I1','$C1','mock:a',false,'on_demand','primary','transcode','running',now()-interval '2 hours','$H'),
         ('$I2','$C2','mock:b',false,'on_demand','primary','radio','running',now()-interval '2 hours','$H');
INSERT INTO host_samples(host_id,source,cpu_pct,mem_pct,net_in_bps,net_out_bps,tasks_on_host)
  VALUES ('$H','cloudwatch',94.25,61.00,120000000,340000000,2);
" >/dev/null 2>&1 || { echo "FATAL could not seed tasks"; echo; echo "== RESULT: 0 passed, 1 failed =="; exit 1; }

B="http://localhost:$PORT"
T1=$(node -e "console.log(require('jsonwebtoken').sign({sub:'$U1',account_id:'$A1',role:'owner'},'fleetsecret',{expiresIn:3600}))")
T2=$(node -e "console.log(require('jsonwebtoken').sign({sub:'$U2',account_id:'$A2',role:'owner'},'fleetsecret',{expiresIn:3600}))")
H1="Authorization: Bearer $T1"
H2="Authorization: Bearer $T2"

echo "== the fleet is not public =="
ok "hosts needs a session" '[ "$(code $B/api/fleet/hosts)" = "401" ]'
ok "usage needs a session" '[ "$(code $B/api/fleet/usage)" = "401" ]'

echo "== both tenants see the shared machine =="
A1H=$(curl -s -H "$H1" $B/api/fleet/hosts)
A2H=$(curl -s -H "$H2" $B/api/fleet/hosts)
ALPHA_N=$(echo "$A1H" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).hosts.length))")
BETA_N=$(echo "$A2H" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).hosts.length))")
ok "Alpha is shown the host carrying its work" '[ "$ALPHA_N" = "1" ]'
ok "and so is Beta, because the machine carries theirs too" '[ "$BETA_N" = "1" ]'

echo "== the MACHINE's load is honest, even when most of it is not yours =="
# This is the direction that fails "safe" and is wrong: a host at 94% with two
# streams must not look like a host with one stream to either tenant.
TOT=$(echo "$A1H" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).hosts[0].streamsTotal))")
YOURS=$(echo "$A1H" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).hosts[0].streamsYours))")
ok "the host reports both streams" '[ "$TOT" = "2" ]'
ok "and Alpha owns one of them" '[ "$YOURS" = "1" ]'
CPU=$(echo "$A1H" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).hosts[0].metrics.cpuPct))")
ok "the real CPU reading is shown, not a per-tenant share of it" '[ "$CPU" = "94.25" ]'
ok "with its source named" 'echo "$A1H" | grep -q cloudwatch'

echo "== but you only see YOUR streams on it =="
# The direction that leaks. Beta's channel name must not appear in Alpha's
# response at all, in any field.
ok "Alpha sees its own channel named" 'echo "$A1H" | grep -q "Alpha News"'
ok "and CANNOT see the other tenant's channel name" '! echo "$A1H" | grep -q "Beta Secret Channel"'
ok "nor its channel id" '! echo "$A1H" | grep -qi "00000994c002"'
ok "the reverse holds too" 'echo "$A2H" | grep -q "Beta Secret Channel" && ! echo "$A2H" | grep -q "Alpha News"'
LIST1=$(echo "$A1H" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).hosts[0].streams.length))")
ok "the per-host stream list holds one entry, not two" '[ "$LIST1" = "1" ]'

echo "== telemetry follows the same boundary =="
ok "a tenant on the host may read its samples" '[ "$(code -H "$H1" $B/api/fleet/hosts/'$H'/samples)" = "200" ]'
SAMP=$(curl -s -H "$H1" $B/api/fleet/hosts/$H/samples | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).samples.length))")
ok "and gets the reading" '[ "$SAMP" -ge 1 ]'

echo "== usage is scoped and is measured in TIME =="
U1J=$(curl -s -H "$H1" "$B/api/fleet/usage?period=day")
ok "the unit is stated outright" 'echo "$U1J" | grep -q "\"unit\":\"seconds\""'
ok "no dollar figure is returned at all" '! echo "$U1J" | grep -qiE "\"(estUsd|usdPerHour|costUsd)\""'
ok "totals are present" 'echo "$U1J" | grep -q monthSeconds'
ok "an unknown period is refused, not interpolated" '[ "$(code -H "$H1" "$B/api/fleet/usage?period=day;DROP")" = "400" ]'
ok "week is accepted" '[ "$(code -H "$H1" "$B/api/fleet/usage?period=week")" = "200" ]'
ok "year is accepted" '[ "$(code -H "$H1" "$B/api/fleet/usage?period=year")" = "200" ]'

echo "== a stream that has never run reports zero, not an error =="
Z=$(curl -s -H "$H1" $B/api/fleet/usage/stream/$C1)
ok "the endpoint answers" 'echo "$Z" | grep -q allTimeSeconds'
ok "with zeros rather than a 404" 'echo "$Z" | grep -q "\"allTimeSeconds\":0"'

psql "$DATABASE_URL" -q -c "DELETE FROM accounts WHERE id IN ('$A1','$A2'); DELETE FROM compute_hosts WHERE id='$H';" >/dev/null 2>&1

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
