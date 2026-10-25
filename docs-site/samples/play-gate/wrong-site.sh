VOLT=https://your-volt-host
APP_KEY=pk_live_...
ASSET_ID=<channel, event or VOD id>

# From a site the app does not allow: refused before anything else is looked at
curl -s -w '\nHTTP %{http_code}\n' "$VOLT/api/public/availability?appKey=$APP_KEY&assetId=$ASSET_ID" \
  -H 'Origin: https://elsewhere.example.net'
