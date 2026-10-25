VOLT=https://your-volt-host
SECRET_KEY=sk_live_...

# A filter the list does not have: the answer says what it can filter on
curl -s "$VOLT/api/vod?colour=red" -H "authorization: Bearer $SECRET_KEY" \
  | jq '{error, code, parameter: .details.parameter, canFilterOn: (.details.filterable | length)}'
