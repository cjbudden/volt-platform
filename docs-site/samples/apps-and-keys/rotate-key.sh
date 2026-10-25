VOLT=https://your-volt-host
SECRET_KEY=sk_live_...
APP_ID=<app id>
OLD_KEY_ID=<old key id>

# 1. Issue a new publishable key for the app. The old one keeps working.
curl -s -X POST "$VOLT/api/apps/$APP_ID/keys" -H "authorization: Bearer $SECRET_KEY" | jq '{newKey: .key, newKeyId: .id}'

# 2. Once every copy of your app uses the new key, revoke the old one
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$VOLT/api/apps/keys/$OLD_KEY_ID" -H "authorization: Bearer $SECRET_KEY"
