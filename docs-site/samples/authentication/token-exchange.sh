VOLT=https://your-volt-host
SECRET_KEY=sk_live_...

# Your server vouches for a member who signed in to your own site
curl -s -X POST "$VOLT/api/public/auth/token-exchange" -H "authorization: Bearer $SECRET_KEY" \
  -H 'content-type: application/json' \
  -d '{"externalId":"crm-123","email":"member@example.com","groups":["members"]}' \
  | jq '{viewer: .viewer.id, groups: .viewer.groups, access: (.access != null), refresh: (.refresh != null)}'
# Hand access and refresh to your app: it uses them like any viewer session
