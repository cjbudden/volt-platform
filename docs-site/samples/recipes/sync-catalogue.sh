VOLT=https://your-volt-host
SECRET_KEY=sk_live_...
SINCE=2026-01-01T00:00:00Z

# Keep your own catalogue in step: everything changed since your last sync, page by page
URL="/api/vod?updated_at[gte]=$SINCE&sort=updated_at&limit=200"
while [ -n "$URL" ]; do
  curl -s -g "$VOLT$URL" -H "authorization: Bearer $SECRET_KEY" -D page-headers.txt \
    | jq -c '.[] | {id, title, published, updated_at}'
  # The next page's address, from the Link header; none means that was the last page
  URL=$(grep -i '^link:.*rel="next"' page-headers.txt | sed -E 's/.*<([^>]+)>.*/\1/' | tr -d '\r' || true)
done
