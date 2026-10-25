VOLT=https://your-volt-host
SECRET_KEY=sk_live_...
LD=(-H 'Accept: application/ld+json' -H "authorization: Bearer $SECRET_KEY")

# Start at the entry point: it links to every collection
CHANNELS=$(curl -s "$VOLT/api" "${LD[@]}" | jq -r .channels)

# Follow the link to the channels, then to the first channel, without building an address
FIRST=$(curl -s "$CHANNELS?limit=1" "${LD[@]}" | jq -r '."hydra:member"[0]."@id"')
curl -s "$FIRST" "${LD[@]}" | jq '{id: ."@id", type: ."@type", name, status}'
