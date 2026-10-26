VOLT=https://your-volt-host
SECRET_KEY=sk_live_...

# The newest view of the last day, then everything that happened in it, in order
SID=$(curl -s "$VOLT/api/analytics/qoe/sessions?days=1&problem=all&limit=5" \
  -H "authorization: Bearer $SECRET_KEY" | jq -r '.items[0].sid')
curl -s "$VOLT/api/analytics/qoe/sessions/$SID" -H "authorization: Bearer $SECRET_KEY" \
  | jq '{sid, reports, missingSequence, spans: [.spans[] | {state, ms}], events: [.events[] | .label]}'
