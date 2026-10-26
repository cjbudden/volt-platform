VOLT=https://your-volt-host
SECRET_KEY=sk_live_...

# The last day: how many app sessions got from opening the app to each step
curl -s "$VOLT/api/analytics/qoe/journeys?days=1" -H "authorization: Bearer $SECRET_KEY" | jq '{
  sessions,
  steps: [.steps[] | {step, sessions}]
}'

# Where the plays came from, per row, search, deep link or push campaign
curl -s "$VOLT/api/analytics/qoe/discovery?days=1&by=detail" -H "authorization: Bearer $SECRET_KEY" | jq '{
  rows: [.rows[] | {entry, detail, journeys, plays, watchMs}]
}'
