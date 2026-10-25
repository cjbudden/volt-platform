VOLT=https://your-volt-host
APP_KEY=pk_live_...
CHANNEL_ID=<channel id>

# An app's guide screen: the programmes around now, with only the publishable key
curl -s "$VOLT/api/public/player/epg?appKey=$APP_KEY&channelId=$CHANNEL_ID" -H 'Origin: https://www.example.com' \
  | jq -c '{channelId, programmes: [.programmes[] | {title, startsAt, endsAt}]}'
