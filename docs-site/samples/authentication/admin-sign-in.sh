VOLT=https://your-volt-host

LOGIN=$(curl -s -X POST "$VOLT/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"your-password"}')
TOKEN=$(echo "$LOGIN" | jq -r .access)
REFRESH=$(echo "$LOGIN" | jq -r .refresh)

# Use the session
curl -s "$VOLT/api/channels?limit=5" -H "authorization: Bearer $TOKEN" | jq '[.[] | .name]'

# Before it expires (15 minutes), swap the refresh token for a new pair
curl -s -X POST "$VOLT/api/auth/refresh" -H 'content-type: application/json' \
  -d "{\"refresh\":\"$REFRESH\"}" | jq '{newSession: (.access != null), expiresIn}'
