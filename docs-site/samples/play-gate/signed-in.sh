VOLT=https://your-volt-host
APP_KEY=pk_live_...
ASSET_ID=<channel, event or VOD id>
VIEWER_SESSION=<the viewer's access token>

curl -s -X POST "$VOLT/api/public/availability" \
  -H "authorization: Bearer $VIEWER_SESSION" -H 'Origin: https://www.example.com' \
  -H 'content-type: application/json' \
  -d "{\"appKey\":\"$APP_KEY\",\"assetId\":\"$ASSET_ID\"}" \
  | jq '{available, mode, token: (.playbackToken != null), expiresIn}'
