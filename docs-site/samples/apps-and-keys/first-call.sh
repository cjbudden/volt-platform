VOLT=https://your-volt-host
SECRET_KEY=sk_live_...

# Your server, with the secret key: the channels in your account
curl -s "$VOLT/api/channels?limit=5" -H "authorization: Bearer $SECRET_KEY" | jq '[.[] | {id, name, kind}]'
