VOLT=https://your-volt-host
SECRET_KEY=sk_live_...
CHANNEL_ID=<channel id>

# Send a programme from your scheduling system. sourceRef is your own id for it:
# send the same sourceRef again and Volt updates that programme instead of adding one.
add() {
  curl -s -X POST "$VOLT/api/epg" -H "authorization: Bearer $SECRET_KEY" -H 'content-type: application/json' \
    -d "{\"channelId\":\"$CHANNEL_ID\",\"title\":\"$1\",\"startsAt\":\"2027-03-01T07:00:00Z\",\"endsAt\":\"$2\",\"sourceRef\":\"sched-1001\"}" \
    | jq -c '{id, title, ends_at, conflicts: (.conflicts | length)}'
}
add "Morning News" "2027-03-01T08:00:00Z"
add "Morning News (extended)" "2027-03-01T08:30:00Z"

# The day's guide for the channel
curl -s "$VOLT/api/epg?channelId=$CHANNEL_ID&from=2027-03-01T00:00:00Z&to=2027-03-02T00:00:00Z" \
  -H "authorization: Bearer $SECRET_KEY" | jq -c '[.[] | {title, starts_at, ends_at}]'
