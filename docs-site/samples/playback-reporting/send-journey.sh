VOLT=https://your-volt-host
APP_KEY=pk_live_...

# Only for an app that does not use the Volt SDK's VoltJourney: that one sends these by itself.
# One JSON event per line. asid is the app session; jid the journey that starts when the
# viewer picks a title; play_intent carries the play attempt's sid (the CMCD sid), which is
# how Volt joins the journey to what happened after the play.
ASID="app-$(date +%s)-$RANDOM"
JID="journey-$(date +%s)-$RANDOM"
SID="attempt-$(date +%s)-$RANDOM"
NOW=$(($(date +%s) * 1000))
cat > journey.ndjson <<NDJSON
{"v":1,"e":"app_open","ts":$((NOW - 9000)),"asid":"$ASID","sn":1,"app":"Example TV app","appv":"2.1.0","launch":"icon"}
{"v":1,"e":"screen","ts":$((NOW - 8000)),"asid":"$ASID","sn":2,"name":"Home","type":"home"}
{"v":1,"e":"content_select","ts":$((NOW - 5000)),"asid":"$ASID","sn":3,"jid":"$JID","cid":"film-1","entry":"row","ed":"Trending","pos":3}
{"v":1,"e":"screen","ts":$((NOW - 4500)),"asid":"$ASID","sn":4,"jid":"$JID","name":"Detail","type":"detail","cid":"film-1"}
{"v":1,"e":"play_intent","ts":$((NOW - 3000)),"asid":"$ASID","sn":5,"jid":"$JID","sid":"$SID","cid":"film-1"}
NDJSON

curl -s -w 'HTTP %{http_code}\n' -X POST "$VOLT/api/public/journey?appKey=$APP_KEY" \
  -H 'content-type: application/x-ndjson' --data-binary @journey.ndjson
