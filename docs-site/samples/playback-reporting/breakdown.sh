VOLT=https://your-volt-host
SECRET_KEY=sk_live_...

# Which app versions fail most (only versions with at least one view)
curl -s "$VOLT/api/analytics/qoe/breakdown?days=1&by=app_version&measure=failure&minViews=1" \
  -H "authorization: Bearer $SECRET_KEY" | jq '.'
