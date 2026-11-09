VOLT=https://your-volt-host
APP_KEY=pk_live_...
ASSET_ID=<channel, event or VOD id>

# The viewer pressed "Notify me" on a title the gate answered 451 (or 403
# scheduled) with "notify": true. Kept once per title and person; a title that
# already plays for this viewer answers 409.
curl -s -w '\nHTTP %{http_code}\n' -X POST "$VOLT/api/public/availability/notify" -H 'Origin: https://www.example.com' \
  -H 'content-type: application/json' \
  -d "{\"appKey\":\"$APP_KEY\",\"assetId\":\"$ASSET_ID\",\"email\":\"viewer@example.com\"}"
