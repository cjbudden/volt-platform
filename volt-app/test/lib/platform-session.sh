# ============================================================================
#  A PLATFORM SESSION FOR A SHELL SUITE.
#
#  /api/platform only accepts a token minted after the authenticator step
#  (auth/platform.ts, code platform_mfa_required). Suites written before that
#  sent an ordinary owner token and were refused, which read like a product
#  fault. This takes the console's own route: step-up from a signed-in session,
#  enrol an authenticator, answer with a real TOTP code.
#
#    . test/lib/platform-session.sh
#    PT=$(platform_session "$B" "$USER_TOKEN")    # B is http://host:port/api
#
#  The user must have platform_role set and no authenticator yet (a fresh
#  fixture). Prints nothing and returns 1 when the step-up is refused.
# ============================================================================
platform_session(){
  local base="$1" tok="$2" r secret code
  r=$(curl -s -X POST "$base/platform/auth/step-up" -H "authorization: Bearer $tok" \
        -H 'content-type:application/json' -d '{}')
  secret=$(python3 -c 'import json,sys
try: print(json.loads(sys.argv[1]).get("secret",""))
except Exception: print("")' "$r")
  [ -n "$secret" ] || return 1
  code=$(npx tsx test/gen-totp.ts "$secret")
  r=$(curl -s -X POST "$base/platform/auth/step-up" -H "authorization: Bearer $tok" \
        -H 'content-type:application/json' -d "{\"code\":\"$code\"}")
  python3 -c 'import json,sys
try: print(json.loads(sys.argv[1]).get("accessToken",""))
except Exception: print("")' "$r"
}
