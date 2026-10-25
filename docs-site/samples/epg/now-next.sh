VOLT=https://your-volt-host
SECRET_KEY=sk_live_...
CHANNEL_ID=<channel id>

curl -s "$VOLT/api/epg/now-next?channelId=$CHANNEL_ID" -H "authorization: Bearer $SECRET_KEY" \
  | jq '{now: .now.title, next: .next.title, nextStarts: .next.starts_at}'
