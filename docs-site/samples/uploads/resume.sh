VOLT=https://your-volt-host
UPLOAD_ID=<upload id>
UPLOAD_TOKEN=<the upload's token>

# After a dropped connection: which chunks still need sending?
curl -s "$VOLT/api/uploads/$UPLOAD_ID/state" -H "authorization: Bearer $UPLOAD_TOKEN" \
  | jq '{state, chunkCount, missing}'
