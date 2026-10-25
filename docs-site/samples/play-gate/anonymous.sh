VOLT=https://your-volt-host
APP_KEY=pk_live_...
ASSET_ID=<channel, event or VOD id>

# A browser sends Origin itself. The key only works from the sites its app allows.
curl -s "$VOLT/api/public/availability?appKey=$APP_KEY&assetId=$ASSET_ID" \
  -H 'Origin: https://www.example.com' \
  | jq '{available, mode, expiresIn, title: .meta.title, live: .meta.live, delivery}'
