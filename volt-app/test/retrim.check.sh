#!/usr/bin/env bash
# Non-destructive clip re-trim: create a clip, change its in/out, confirm the
# range/duration/manifest key update and the source recording is untouched.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret} JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh} INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${PORT:-8103} ORCH_LAUNCHER=mock
A=00000000-0000-0000-0000-0000000000a1; U=00000000-0000-0000-0000-0000000000f1; G=00000000-0000-0000-0000-0000000000b1; C=00000000-0000-0000-0000-0000000000c1; D=00000000-0000-0000-0000-0000000000d1; R=00000000-0000-0000-0000-0000000000e1
pass=0; fail=0; ok(){ echo "  ✓ $1"; pass=$((pass+1)); }; no(){ echo "  ✗ $1"; fail=$((fail+1)); }
jf(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(eval('JSON.parse(s)'+process.argv[1]))}catch(e){console.log('ERR')}})" "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

# A CLIP NEEDS MEDIA, AND THIS SUITE MAKES ITS OWN.
#
# It used to invent a recording with nothing behind it, which broke once clips
# started resolving against real segments. The fix then was to BORROW whatever
# stream on the box happened to have segments, which is worse in a quieter way:
# it made the suite depend on another run's leftovers, so it skipped entirely on
# a clean machine, and when it did find media it might find media written faster
# than realtime, whose measurable span is about a second however many segments
# it holds. Both failure modes end in "0 passed, 0 failed" while the runner
# still reports ok.
#
# So: one dedicated channel, generated fresh, in realtime, every run.
export ORIGIN_DIR="${ORIGIN_DIR:-$PWD/origin}"
ORIGIN="$ORIGIN_DIR"
C=0000000f-0000-0000-0000-0000000000c9
rm -rf "$ORIGIN/$C"
if ! bash "$(dirname "$0")/lib/make-fixture-runs.sh" "$ORIGIN/$C" 1 24; then
  echo "SKIP could not generate fixture media (needs ffmpeg)"
  echo ""
  echo "== RESULT: 0 passed, 0 failed =="
  exit 0
fi
echo "using stream $C (real segments on disk)"

psql "$DATABASE_URL" -q -f migrations/0001_init.sql
psql "$DATABASE_URL" -q -c "
DELETE FROM accounts WHERE id = '$A';
DELETE FROM channels WHERE id = '$C';
INSERT INTO accounts(id,name) VALUES ('$A','RTM');
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$U','$A','a@x','x','owner','active');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D','$A','p','[]','package_only');
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('$G','$A','g','$D');
INSERT INTO channels(id,group_id,name,status) VALUES ('$C','$G','n','live');
INSERT INTO recordings(id,kind,channel_id,day_utc,status,start_epoch_ms,master_key,hi_res_rendition) VALUES ('$R','channel_day','$C','2026-07-30','recording',0,'channel/$C','1080p');"

fuser -k "$PORT"/tcp 2>/dev/null || true; sleep 1
npx tsx src/index.ts >/tmp/volt-retrim.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 1; done
T=$(node -e "console.log(require('jsonwebtoken').sign({sub:'$U',account_id:'$A',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))")
BASE="http://localhost:$PORT"; JS="Content-Type: application/json"; AUTH="Authorization: Bearer $T"

# The range must land inside the run's REAL recorded span. The old fixture used
# 1000..9000, which is nine seconds after the epoch — fine when a clip was a
# row, meaningless once a clip resolves against segments that exist.
SPAN=$(npx tsx -e "
  import { recordingSpans } from './src/services/localRecordingIndex';
  const s = recordingSpans('$C').filter(x => x.segments >= 4).pop();
  if (!s) { console.log('0 0'); } else {
    // Off the segment grid on purpose: a snapping implementation would show.
    const a = Math.round(s.startMs) + 3400;
    const b = Math.min(Math.round(s.endMs) - 1200, a + 8000);
    console.log(a + ' ' + b);
  }" 2>/dev/null | tail -1)
S1=$(echo "$SPAN" | cut -d' ' -f1); E1=$(echo "$SPAN" | cut -d' ' -f2)
# We generated this media ourselves, so an unusable span is a real failure and
# not something to shrug at: either the generator or the index is wrong.
[ "$S1" != "0" ] && [ "$E1" -gt "$S1" ] || {
  echo "  ✗ could not measure a usable span on the freshly generated $C"
  echo; echo "== RESULT: 0 passed, 1 failed =="; exit 1; }
# Re-trim inwards: later start, earlier end, so it is unambiguously a narrowing.
S2=$((S1 + 2000)); E2=$((E1 - 2000)); DUR2=$((E2 - S2))

echo "== create a clip $S1..$E1 =="
CLIP=$(curl -s -X POST -H "$AUTH" -H "$JS" $BASE/api/recordings/$R/clip -d "{\"title\":\"Highlight\",\"startMs\":$S1,\"endMs\":$E1,\"outputKind\":\"both\"}")
VID=$(echo "$CLIP" | jf '.id')
echo "$CLIP" | grep -q "clip-$S1-$E1" && ok "clip created with its range in its key" || no "clip create: $(echo "$CLIP"|head -c140)"

echo "== re-trim to $S2..$E2 (non-destructive) =="
TR=$(curl -s -X PATCH -H "$AUTH" -H "$JS" $BASE/api/vod/$VID/trim -d "{\"startMs\":$S2,\"endMs\":$E2}")
[ "$(echo "$TR" | jf '.start_epoch_ms')" = "$S2" ] && ok "start updated" || no "start: $(echo "$TR"|head -c140)"
[ "$(echo "$TR" | jf '.end_epoch_ms')" = "$E2" ] && ok "end updated" || no "end wrong"
[ "$(echo "$TR" | jf '.duration_ms')" = "$DUR2" ] && ok "duration recomputed" || no "duration wrong"
echo "$TR" | grep -q "clip-$S2-$E2" && ok "manifest key re-pointed to the new range" || no "master_key not updated"
[ "$(echo "$TR" | jf '.thumb_status')" = "processing" ] && ok "marked for re-derivation (thumb_status=processing)" || no "not re-queued"

echo "== a re-cut is unreviewed media =="
# An approved clip that is then re-trimmed to a different range is showing
# footage nobody looked at. These four columns used to be left alone, so it kept
# its approval and its QC pass and could publish straight over the new cut.
psql "$DATABASE_URL" -q -c "
  UPDATE vod_assets SET review_state='approved', qc_state='pass', qc_at=now(), reviewed_at=now() WHERE id='$VID';
  INSERT INTO qc_events(vod_asset_id, check_name, severity, message)
    VALUES ('$VID','silence','warning','left over from the previous cut');
  INSERT INTO publications(vod_asset_id, platform, status, stale)
    VALUES ('$VID','portal','published', false);"
S3=$((S1 + 3000)); E3=$((E1 - 500))
TR2=$(curl -s -X PATCH -H "$AUTH" -H "$JS" $BASE/api/vod/$VID/trim -d "{\"startMs\":$S3,\"endMs\":$E3}")
[ "$(echo "$TR2" | jf '.review_state')" = "draft" ] && ok "approval is dropped by a re-cut" || no "review_state kept: $(echo "$TR2"|head -c140)"
[ "$(echo "$TR2" | jf '.qc_state')" = "null" ] && ok "and so is the QC verdict" || no "qc_state kept"
QCN=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM qc_events WHERE vod_asset_id='$VID'")
[ "$QCN" = "0" ] && ok "findings about the old media are cleared" || no "stale qc_events kept ($QCN)"
STALE=$(psql "$DATABASE_URL" -tAc "SELECT stale FROM publications WHERE vod_asset_id='$VID'")
[ "$STALE" = "t" ] && ok "anywhere it was published is marked stale" || no "publication not marked stale ($STALE)"
# Matched on the NEW RANGE, not just on the asset. Creating the clip already
# enqueues a clip.extract for this asset, so "a job exists" was true before the
# re-trim ever ran and would have gone on being true with the re-enqueue
# removed. The job that matters is the one that builds THIS cut.
JOBN=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM jobs WHERE type='clip.extract' AND payload->>'vodAssetId'='$VID' AND (payload->>'fromMs')::bigint = $S3 AND (payload->>'toMs')::bigint = $E3")
[ "$JOBN" -ge 1 ] && ok "and the rebuild of the NEW range is actually queued" || no "no extract job enqueued for $S3..$E3 ($JOBN)"
KEY=$(psql "$DATABASE_URL" -tAc "SELECT master_key FROM vod_assets WHERE id='$VID'")
echo "$KEY" | grep -q "clip-$S3-$E3" && ok "the key names the new range" || no "master_key wrong: $KEY"

echo "== source recording untouched =="
# What "non-destructive" claims is that clipping does not consume or re-cut the
# SOURCE — its media and its extent are exactly as they were. It never claimed
# the recording's lifecycle stands still: the orchestrator closes an open
# recording whose channel is not running, correctly, and asserting on `status`
# was really asserting that the scheduler had not ticked yet.
RECNOW=$(psql "$DATABASE_URL" -tAc "SELECT master_key||'|'||start_epoch_ms||'|'||hi_res_rendition FROM recordings WHERE id='$R'")
[ "$RECNOW" = "channel/$C|0|1080p" ] && ok "source recording's media and extent are unchanged" || no "source recording was mutated: $RECNOW"

echo "== invalid range rejected =="
[ "$(code -X PATCH -H "$AUTH" -H "$JS" $BASE/api/vod/$VID/trim -d "{\"startMs\":$E1,\"endMs\":$S1}")" = "400" ] && ok "endMs<=startMs → 400" || no "bad range not rejected"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
