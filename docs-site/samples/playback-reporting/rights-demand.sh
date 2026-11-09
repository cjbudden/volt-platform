VOLT=https://your-volt-host
SECRET_KEY=sk_live_...

# Who was refused where in the last 30 days, beside the plays where the titles are licensed
curl -s "$VOLT/api/analytics/rights-demand" \
  -H "authorization: Bearer $SECRET_KEY" | jq '{from, to, totals, byCountry: .byCountry[:5]}'
