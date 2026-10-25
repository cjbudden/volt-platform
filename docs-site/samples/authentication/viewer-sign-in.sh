VOLT=https://your-volt-host
APP_KEY=pk_live_...
ASSET_ID=<channel, event or VOD id>

# A viewer makes an account in your app (or signs in with /login)
VIEWER=$(curl -s -X POST "$VOLT/api/public/auth/register" -H 'content-type: application/json' \
  -H 'Origin: https://www.example.com' \
  -d "{\"appKey\":\"$APP_KEY\",\"email\":\"fan@example.com\",\"password\":\"Correct-Horse-27\"}" | jq -r .access)

# The play gate decides with who they are, their groups and their purchases
curl -s -X POST "$VOLT/api/public/availability" -H "authorization: Bearer $VIEWER" \
  -H 'Origin: https://www.example.com' -H 'content-type: application/json' \
  -d "{\"appKey\":\"$APP_KEY\",\"assetId\":\"$ASSET_ID\"}" | jq '{available, mode, expiresIn}'
