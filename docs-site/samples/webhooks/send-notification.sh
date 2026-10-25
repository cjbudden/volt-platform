VOLT=https://your-volt-host
SECRET_KEY=sk_live_...

# 1. A template, made once. {{title}} and {{at}} are filled from each message's payload.
curl -s -X POST "$VOLT/api/notification-templates" -H "authorization: Bearer $SECRET_KEY" \
  -H 'content-type: application/json' \
  -d '{"key":"rights-closing","subject":"Rights close tonight: {{title}}","body":"{{title}} comes down at {{at}}."}' \
  | jq -c '{key, subject}'

# 2. Tell your operators, in the console inbox and by email
ID=$(curl -s -X POST "$VOLT/api/notifications" -H "authorization: Bearer $SECRET_KEY" \
  -H 'content-type: application/json' \
  -d '{"topic":"rights","recipients":["admin@example.com"],"channels":["in_app","email"],
       "templateKey":"rights-closing","payload":{"title":"The match replay","at":"midnight"}}' | jq -r .id)

# 3. What happened to each copy
curl -s "$VOLT/api/notifications/$ID" -H "authorization: Bearer $SECRET_KEY" \
  | jq -c '{subject, deliveries: [.deliveries[] | {recipient, channel, status, last_error}]}'
