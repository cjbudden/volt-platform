VOLT=https://your-volt-host
SECRET_KEY=sk_live_...
FILE=evening-news.mp4

SIZE=$(wc -c < "$FILE" | tr -d ' ')

# 1. Open an upload session: it says how big each chunk is and gives a token for this upload only
SESSION=$(curl -s -X POST "$VOLT/api/uploads" -H "authorization: Bearer $SECRET_KEY" -H 'content-type: application/json' \
  -d "{\"purpose\":\"vod\",\"name\":\"Evening news\",\"filename\":\"$FILE\",\"contentType\":\"video/mp4\",\"totalBytes\":$SIZE}")
ID=$(echo "$SESSION" | jq -r .id)
TOKEN=$(echo "$SESSION" | jq -r .token)
CHUNK=$(echo "$SESSION" | jq -r .chunkSize)
COUNT=$(echo "$SESSION" | jq -r .chunkCount)

# 2. Send the chunks, in any order, with the upload's own token
for ((i = 0; i < COUNT; i++)); do
  dd if="$FILE" bs="$CHUNK" skip="$i" count=1 2>/dev/null \
    | curl -s -X PUT "$VOLT/api/uploads/$ID/chunks/$i" -H "authorization: Bearer $TOKEN" \
        -H 'content-type: application/octet-stream' --data-binary @- | jq -c '{index, received, chunkCount, complete}'
done

# 3. Finish: Volt checks every chunk arrived, then the ingest rules take over
ASSET=$(curl -s -X POST "$VOLT/api/uploads/$ID/finish" -H "authorization: Bearer $TOKEN" \
  | tee finish.json | jq -r .assetId)
jq '{assetId, bytes, sha256, ingest: .ingest.status, title: .ingest.title}' finish.json

# 4. The asset is named after the file: give it its real title
curl -s -X PUT "$VOLT/api/vod/$ASSET" -H "authorization: Bearer $SECRET_KEY" -H 'content-type: application/json' \
  -d '{"title":"Evening news, 24 October"}' | jq -c '{id, title}'
