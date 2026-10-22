---
scope: internal
type: fixed
area: Tests
---
Baseline of all 179 check suites, each on its own database: 178 pass. Suites that drifted from the product were brought up to date (10 character passwords, roles model, platform sign-in with an authenticator code, plan allocation, kept metadata keys, smart render, the audio_radio skin). Fixture faults fixed: a docs test user and clashing fixture ids in the check seed, invited test users, and test media that suites now make themselves (smart render, ingest extract). New helpers test/lib/platform-session.sh and test/lib/react-global.ts.
