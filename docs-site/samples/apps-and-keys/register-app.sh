VOLT=https://your-volt-host

# Sign in as an admin user who can manage apps
TOKEN=$(curl -s -X POST "$VOLT/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"your-password"}' | jq -r .access)

# Register a web player that may only be used on your own site
curl -s -X POST "$VOLT/api/apps" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Website player","type":"web","restrictions":{"referrers":["https://www.example.com"]}}' \
  | jq '{appId: .id, publishableKey: .publishableKey.key, keyId: .publishableKey.id}'
