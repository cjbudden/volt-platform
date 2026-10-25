VOLT=https://your-volt-host
APP_KEY=pk_live_...
ASSET_ID=<channel, event or VOD id>

# Only for a player that is not the Volt player: that one reports by itself.
# One CMCD v2 event report per line. sid is one play attempt; sn counts its reports;
# com.volt-app and com.volt-appv name your app and its version for the reports.
SID="attempt-$(date +%s)-$RANDOM"
NOW=$(($(date +%s) * 1000))
# A batch covering the last 31 seconds: starting, playing 850 ms later, then the first heartbeat
cat > reports.cmcd <<CMCD
v=2,e=ps,sta=s,sid="$SID",sn=0,ts=$((NOW - 31000)),cid="$ASSET_ID",st=l,com.volt-app="Example TV app",com.volt-appv="2.1.0"
v=2,e=ps,sta=p,sid="$SID",sn=1,ts=$((NOW - 30150)),cid="$ASSET_ID",st=l
v=2,e=t,sid="$SID",sn=2,ts=$NOW,cid="$ASSET_ID",st=l,br=(3200),bl=(9000)
CMCD

curl -s -w 'HTTP %{http_code}\n' -X POST "$VOLT/api/public/cmcd?appKey=$APP_KEY" \
  -H 'content-type: application/cmcd' --data-binary @reports.cmcd
