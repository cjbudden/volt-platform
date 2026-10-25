VOLT=https://your-volt-host
APP_KEY=pk_live_...
ASSET_ID=<channel, event or VOD id>

# For a catalogue screen: may this be played, without minting a token?
curl -s -X POST "$VOLT/api/public/access/check" -H 'Origin: https://www.example.com' \
  -H 'content-type: application/json' -d "{\"appKey\":\"$APP_KEY\",\"assetId\":\"$ASSET_ID\"}" \
  | jq '{allowed, mode, reasons}'
