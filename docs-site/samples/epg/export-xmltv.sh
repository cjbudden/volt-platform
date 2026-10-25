VOLT=https://your-volt-host
SECRET_KEY=sk_live_...
CHANNEL_ID=<channel id>

# Your guide as XMLTV, for a set-top box, a guide partner or your website
curl -s "$VOLT/api/epg/xmltv?channelId=$CHANNEL_ID&from=2027-03-01T00:00:00Z&to=2027-03-03T00:00:00Z&download=0" \
  -H "authorization: Bearer $SECRET_KEY" -o guide-out.xml
grep -c '<programme ' guide-out.xml
