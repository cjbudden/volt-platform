VOLT=https://your-volt-host
SECRET_KEY=sk_live_...
APP_KEY=pk_live_...
ASSET_ID=<channel, event or VOD id>

# On your server, after your own sign-in: a Volt viewer session for this member
VIEWER=$(curl -s -X POST "$VOLT/api/public/auth/token-exchange" -H "authorization: Bearer $SECRET_KEY" \
  -H 'content-type: application/json' -d '{"externalId":"crm-123","groups":["members"]}' | jq -r .access)

# In the browser, the player is given that session (player.setViewerToken) and asks the gate:
curl -s -X POST "$VOLT/api/public/availability" -H "authorization: Bearer $VIEWER" \
  -H 'Origin: https://www.example.com' -H 'content-type: application/json' \
  -d "{\"appKey\":\"$APP_KEY\",\"assetId\":\"$ASSET_ID\"}" | jq '{available, mode}'
