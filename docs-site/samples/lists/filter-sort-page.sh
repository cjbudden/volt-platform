VOLT=https://your-volt-host
SECRET_KEY=sk_live_...

# The first page: published on-demand assets, newest change first, two at a time
curl -s "$VOLT/api/vod?published=true&sort=-updated_at&limit=2&count=true" \
  -H "authorization: Bearer $SECRET_KEY" -D headers.txt | jq '[.[] | {id, title, updated_at}]'
grep -i -E '^(x-total-count|x-next-cursor):' headers.txt | tr -d '\r'

# The next page: the same request with the cursor added
NEXT=$(grep -i '^x-next-cursor:' headers.txt | cut -d' ' -f2 | tr -d '\r')
curl -s "$VOLT/api/vod?published=true&sort=-updated_at&limit=2&count=true&cursor=$NEXT" \
  -H "authorization: Bearer $SECRET_KEY" | jq '[.[] | {id, title, updated_at}]'
