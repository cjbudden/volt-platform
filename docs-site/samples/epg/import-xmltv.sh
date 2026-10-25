VOLT=https://your-volt-host
SECRET_KEY=sk_live_...
CHANNEL_ID=<channel id>

# 1. Tell Volt which XMLTV channel id is this channel, so the import maps it by itself
curl -s -X PUT "$VOLT/api/epg/channels/$CHANNEL_ID/xmltv-id" -H "authorization: Bearer $SECRET_KEY" \
  -H 'content-type: application/json' -d '{"xmltvId":"news.example.com"}' | jq -c .

# 2. A source that takes uploaded files (kind "url" fetches a feed on a schedule instead)
SOURCE=$(curl -s -X POST "$VOLT/api/epg/import/sources" -H "authorization: Bearer $SECRET_KEY" \
  -H 'content-type: application/json' -d '{"name":"Partner guide","kind":"upload"}' | jq -r .id)

# 3. Upload the file itself as the body
curl -s -X POST "$VOLT/api/epg/import/sources/$SOURCE/upload" -H "authorization: Bearer $SECRET_KEY" \
  -H 'content-type: application/xml' --data-binary @guide.xml \
  | jq -c '{status, programmes: .counts.programmesInFile, inserted: .counts.inserted, unmapped: .counts.unmappedChannels, warnings}'

# 4. How each channel in the file was mapped
curl -s "$VOLT/api/epg/import/sources/$SOURCE/channels" -H "authorization: Bearer $SECRET_KEY" \
  | jq -c '[.[] | {externalId, state, channelName, mappedBy}]'
