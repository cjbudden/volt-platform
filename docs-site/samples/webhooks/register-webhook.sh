VOLT=https://your-volt-host
SECRET_KEY=sk_live_...

# Call your system whenever a file is ingested. The signing secret is shown once: keep it.
curl -s -X POST "$VOLT/api/ingest/webhooks" -H "authorization: Bearer $SECRET_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"Our MAM","url":"https://hooks.example.com/volt","events":["ingested","quarantined"]}' \
  | jq '{id, url, events, secret}'
