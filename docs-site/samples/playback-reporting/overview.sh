VOLT=https://your-volt-host
SECRET_KEY=sk_live_...

# The last day: did people get to watch, how fast did it start, how much did it stall
curl -s "$VOLT/api/analytics/qoe/overview?days=1" -H "authorization: Bearer $SECRET_KEY" | jq '{
  attempts: .success.attempts,
  startupFailureRate: .success.startupFailureRate,
  startupP95ms: .startup.startup.p95,
  rebufferRatio: .buffering.rebufferRatio
}'
