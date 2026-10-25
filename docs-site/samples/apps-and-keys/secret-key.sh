VOLT=https://your-volt-host

# Only an Owner or Administrator can make a secret key
TOKEN=$(curl -s -X POST "$VOLT/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"your-password"}' | jq -r .access)

curl -s -X POST "$VOLT/api/apps/secret-keys" -H "authorization: Bearer $TOKEN" | jq '{secretKey: .key, prefix: .key_prefix}'
