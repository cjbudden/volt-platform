VOLT=https://your-volt-host
SECRET_KEY=sk_live_...
SOURCE_ID=<import source id>
CHANNEL_ID=<channel id>

# A channel in the file that Volt could not match: map it by hand
ALIAS=$(curl -s "$VOLT/api/epg/import/sources/$SOURCE_ID/channels" -H "authorization: Bearer $SECRET_KEY" \
  | jq -r '[.[] | select(.externalId == "radio.example.com")][0].id')
curl -s -X PUT "$VOLT/api/epg/import/aliases/$ALIAS" -H "authorization: Bearer $SECRET_KEY" \
  -H 'content-type: application/json' -d "{\"channelId\":\"$CHANNEL_ID\"}" | jq -c '{state, channelId}'

# Upload the file again: this time its programmes come in too
curl -s -X POST "$VOLT/api/epg/import/sources/$SOURCE_ID/upload" -H "authorization: Bearer $SECRET_KEY" \
  -H 'content-type: application/xml' --data-binary @guide.xml | jq -c '{status, inserted: .counts.inserted, unmapped: .counts.unmappedChannels}'
