#!/usr/bin/env bash
# CAPTIONS SETTINGS API (Admin > Captions, build queue 1.3).
#   GET   /api/account-settings/captions
#   PATCH /api/account-settings/captions               { provider }   admins and owners
#   PATCH /api/account-settings/captions/profiles/:id  { enabled, sourceLang, targets, offsetSec, modelSize }
# Saving round-trips; another account's profile is 404; an operator can read
# but not change; values outside what the pipeline delivers are refused (422);
# a change is refused with 409 locked_while_running while a stream it would
# affect runs; every change is audited; and what is saved is what the encoder
# job gets (buildEncoderJobConfig).
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8541}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" THUMBS_ENABLED=0
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000c301; ACC2=0000000a-0000-0000-0000-00000000c302
ADM=0000000b-0000-0000-0000-00000000c301; OPR=0000000b-0000-0000-0000-00000000c302
P1=0000000c-0000-0000-0000-00000000c301; P2=0000000c-0000-0000-0000-00000000c302; PX=0000000c-0000-0000-0000-00000000c303
G1=0000000d-0000-0000-0000-00000000c301; G2=0000000d-0000-0000-0000-00000000c302; GX=0000000d-0000-0000-0000-00000000c303
CH=0000000e-0000-0000-0000-00000000c301; EV=00000010-0000-0000-0000-00000000c301
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name,max_channels) VALUES ('$ACC','CaptionsCo',10),('$ACC2','OtherCo',10) ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES
  ('$ADM','$ACC','adm@captions.example','x','admin','active'),
  ('$OPR','$ACC','op@captions.example','x','operator','active') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES
  ('$P1','$ACC','News ladder','[{"height":720,"bitrate_kbps":2500}]','transcode'),
  ('$P2','$ACC','Sport pass-through','[]','package_only'),
  ('$PX','$ACC2','Theirs','[]','package_only') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,is_default) VALUES
  ('$G1','$ACC','News','$P1',5,true),('$G2','$ACC','Sport','$P2',5,false),('$GX','$ACC2','Main','$PX',5,true) ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,kind) VALUES ('$CH','$G1','News 24','ended','tv') ON CONFLICT (id) DO NOTHING;
INSERT INTO events(id,group_id,name,status,scheduled_start,scheduled_end) VALUES
  ('$EV','$G2','Cup Final','ended',now()-interval '2 hours',now()-interval '1 hour') ON CONFLICT (id) DO NOTHING;
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE id IN ('$ADM','$OPR')\",[h]); await pool.end();})()" >/dev/null 2>&1
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
npx tsx src/index.ts >/tmp/captions_settings_api.log 2>&1 & API=$!
trap 'kill $API 2>/dev/null' EXIT
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
login(){ echo "authorization: Bearer $(curl -s -X POST "$B/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')"; }
A=$(login adm@captions.example); O=$(login op@captions.example)
S="$B/account-settings/captions"

echo "-- read"
R=$(curl -s "$S" -H "$A")
ok "starts with captions off for the account" '[ "$(echo "$R" | jget "d[\"provider\"]")" = none ]'
ok "lists the account's two profiles, not another account's" '[ "$(echo "$R" | jget "sorted(p[\"name\"] for p in d[\"profiles\"])")" = "['"'"'News ladder'"'"', '"'"'Sport pass-through'"'"']" ]'
ok "says who uses each profile (group, channel and event counts)" '[ "$(echo "$R" | jget "[(p[\"groups\"][0][\"name\"], p[\"channelCount\"], p[\"eventCount\"]) for p in d[\"profiles\"]]")" = "[('"'"'News'"'"', 1, 0), ('"'"'Sport'"'"', 0, 1)]" ]'
ok "offers the deliverable languages and the whisper sizes" '[ "$(echo "$R" | jget "(len(d[\"languages\"])>=4, d[\"modelSizes\"][0], d[\"modelSizes\"][-1])")" = "(True, '"'"'tiny'"'"', '"'"'large-v3'"'"')" ]'
ok "an admin may change the engine and the profiles" '[ "$(echo "$R" | jget "(d[\"canEditProvider\"], d[\"canEditProfiles\"])")" = "(True, True)" ]'
ok "an operator can read, and is told they cannot change" '[ "$(curl -s "$S" -H "$O" | jget "(d[\"canEditProvider\"], d[\"canEditProfiles\"], bool(d[\"providerReason\"]))")" = "(False, False, True)" ]'
ok "not without signing in (401)" '[ "$(code "$S")" = 401 ]'

echo "-- the engine"
ok "an operator cannot change the engine (403)" '[ "$(code -X PATCH "$S" -H "$O" -H "$J" -d "{\"provider\":\"whisper\"}")" = 403 ]'
ok "an unknown engine is refused (422)" '[ "$(code -X PATCH "$S" -H "$A" -H "$J" -d "{\"provider\":\"aws\"}")" = 422 ]'
ok "an admin turns on whisper" '[ "$(curl -s -X PATCH "$S" -H "$A" -H "$J" -d "{\"provider\":\"whisper\"}" | jget "d[\"provider\"]")" = whisper ]'
ok "it is stored on the account" '[ "$(q "SELECT captions_provider FROM accounts WHERE id='"'"'$ACC'"'"'")" = whisper ]'
ok "and reads back after a reload" '[ "$(curl -s "$S" -H "$A" | jget "d[\"provider\"]")" = whisper ]'
ok "the other account is untouched" '[ "$(q "SELECT captions_provider FROM accounts WHERE id='"'"'$ACC2'"'"'")" = none ]'
ok "the change is in the audit log" '[ "$(q "SELECT count(*) FROM audit_log WHERE account_id='"'"'$ACC'"'"' AND entity_type='"'"'account_captions'"'"'")" = 1 ]'

echo "-- a profile"
PP="$S/profiles/$P1"
R=$(curl -s -X PATCH "$PP" -H "$A" -H "$J" -d '{"enabled":true,"sourceLang":"en","targets":["en","ms","zh"],"offsetSec":4,"modelSize":"base"}')
ok "an admin saves a profile's captions" '[ "$(echo "$R" | jget "[(p[\"enabled\"],p[\"sourceLang\"],p[\"targets\"],p[\"offsetSec\"],p[\"modelSize\"]) for p in d[\"profiles\"] if p[\"name\"]==\"News ladder\"][0]")" = "(True, '"'"'en'"'"', ['"'"'en'"'"', '"'"'ms'"'"', '"'"'zh'"'"'], 4, '"'"'base'"'"')" ]'
ok "it is stored on the profile" '[ "$(q "SELECT captions_enabled||'"'"'|'"'"'||caption_source_lang||'"'"'|'"'"'||caption_targets::text||'"'"'|'"'"'||caption_offset_sec||'"'"'|'"'"'||caption_model_size FROM output_profiles WHERE id='"'"'$P1'"'"'")" = 'true|en|["en", "ms", "zh"]|4|base' ]'
ok "the other profile is untouched" '[ "$(q "SELECT captions_enabled FROM output_profiles WHERE id='"'"'$P2'"'"'")" = f ]'
ok "a partial change leaves the rest alone" '[ "$(curl -s -X PATCH "$PP" -H "$A" -H "$J" -d "{\"offsetSec\":3}" | jget "[(p[\"offsetSec\"],p[\"targets\"]) for p in d[\"profiles\"] if p[\"name\"]==\"News ladder\"][0]")" = "(3, ['"'"'en'"'"', '"'"'ms'"'"', '"'"'zh'"'"'])" ]'
ok "a language Volt cannot deliver is refused (422)" '[ "$(code -X PATCH "$PP" -H "$A" -H "$J" -d "{\"targets\":[\"klingon\"]}")" = 422 ]'
ok "a fractional offset is refused, the encoder takes whole seconds (422)" '[ "$(code -X PATCH "$PP" -H "$A" -H "$J" -d "{\"offsetSec\":2.5}")" = 422 ]'
ok "an offset over 60 seconds is refused (422)" '[ "$(code -X PATCH "$PP" -H "$A" -H "$J" -d "{\"offsetSec\":90}")" = 422 ]'
ok "an unknown model is refused (422)" '[ "$(code -X PATCH "$PP" -H "$A" -H "$J" -d "{\"modelSize\":\"huge\"}")" = 422 ]'
ok "an unknown field is refused, not ignored (422)" '[ "$(code -X PATCH "$PP" -H "$A" -H "$J" -d "{\"engine\":\"gladia\"}")" = 422 ]'
ok "another account's profile is not found (404)" '[ "$(code -X PATCH "$S/profiles/$PX" -H "$A" -H "$J" -d "{\"enabled\":true}")" = 404 ]'
ok "and stays as it was" '[ "$(q "SELECT captions_enabled FROM output_profiles WHERE id='"'"'$PX'"'"'")" = f ]'
ok "a malformed id is not found (404)" '[ "$(code -X PATCH "$S/profiles/nope" -H "$A" -H "$J" -d "{\"enabled\":true}")" = 404 ]'
ok "an operator cannot change a profile (403)" '[ "$(code -X PATCH "$PP" -H "$O" -H "$J" -d "{\"offsetSec\":5}")" = 403 ]'
ok "each profile change is in the audit log" '[ "$(q "SELECT count(*) FROM audit_log WHERE account_id='"'"'$ACC'"'"' AND entity_type='"'"'output_profile'"'"' AND entity_id='"'"'$P1'"'"'")" = 2 ]'

echo "-- what the encoder gets"
JOB=$(npx tsx -e "
import { one, pool } from './src/db'; import { buildEncoderJobConfig } from './src/services/jobConfig';
(async () => {
  const profile = await one<any>(\"SELECT * FROM output_profiles WHERE id='$P1'\");
  const account = await one<any>(\"SELECT captions_provider FROM accounts WHERE id='$ACC'\");
  const cfg: any = buildEncoderJobConfig({ kind: 'channel', owner: { id: '$CH' }, inputs: [{ role: 'primary', rendition_label: null, rendition_bitrate_kbps: null, protocol: 'srt', ingest_url: 'srt://x', stream_key: null }], profile, account } as any);
  console.log(JSON.stringify(cfg.captions ?? null)); await pool.end();
})()" 2>/dev/null | tail -1)
ok "the saved engine, languages and offset reach the encoder job" '[ "$(echo "$JOB" | jget "(d[\"engine\"], d[\"source_lang\"], d[\"targets\"], d[\"offset_sec\"], d[\"model_size\"])")" = "('"'"'whisper'"'"', '"'"'en'"'"', ['"'"'en'"'"', '"'"'ms'"'"', '"'"'zh'"'"'], 3, '"'"'base'"'"')" ]'

echo "-- locked while running"
q "INSERT INTO instances(channel_id,state,lifecycle,role) VALUES ('$CH','running','on_demand','primary')" >/dev/null
ok "a change to a running stream's profile is refused (409)" '[ "$(code -X PATCH "$PP" -H "$A" -H "$J" -d "{\"offsetSec\":6}")" = 409 ]'
ok "naming the stream, with code locked_while_running" '[ "$(curl -s -X PATCH "$PP" -H "$A" -H "$J" -d "{\"offsetSec\":6}" | jget "(d[\"code\"], d[\"running\"][0][\"name\"])")" = "('"'"'locked_while_running'"'"', '"'"'News 24'"'"')" ]'
ok "re-sending the stored values is not a change (200)" '[ "$(code -X PATCH "$PP" -H "$A" -H "$J" -d "{\"offsetSec\":3,\"targets\":[\"en\",\"ms\",\"zh\"]}")" = 200 ]'
ok "the read says which stream is running on the profile" '[ "$(curl -s "$S" -H "$A" | jget "[p[\"running\"][0][\"name\"] for p in d[\"profiles\"] if p[\"name\"]==\"News ladder\"][0]")" = "News 24" ]'
ok "a profile with nothing running can still change" '[ "$(code -X PATCH "$S/profiles/$P2" -H "$A" -H "$J" -d "{\"offsetSec\":2}")" = 200 ]'
ok "the engine cannot change under a captioned running stream (409)" '[ "$(code -X PATCH "$S" -H "$A" -H "$J" -d "{\"provider\":\"gladia\"}")" = 409 ]'
ok "and stays whisper" '[ "$(q "SELECT captions_provider FROM accounts WHERE id='"'"'$ACC'"'"'")" = whisper ]'
q "UPDATE instances SET terminated_at=now() WHERE channel_id='$CH'" >/dev/null
ok "once the stream stops, the engine can change" '[ "$(curl -s -X PATCH "$S" -H "$A" -H "$J" -d "{\"provider\":\"gladia\"}" | jget "d[\"provider\"]")" = gladia ]'
ok "and the profile too" '[ "$(code -X PATCH "$PP" -H "$A" -H "$J" -d "{\"offsetSec\":6}")" = 200 ]'

echo "-- the language list is one list"
ok "GET /api/caption-languages answers the same list the settings validate against" '[ "$(curl -s "$B/caption-languages" -H "$A" | jget "[l[\"code\"] for l in d[\"languages\"]]")" = "$(curl -s "$S" -H "$A" | jget "[l[\"code\"] for l in d[\"languages\"]]")" ]'

echo
echo "$pass passed, $fail failed"
[ $fail -eq 0 ]
