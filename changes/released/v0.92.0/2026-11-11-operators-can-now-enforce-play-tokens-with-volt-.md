---
scope: core
type: added
area: Playback
---
Operators can now enforce play tokens: with VOLT_EDGE_TOKENS=enforce (edge_tokens = "enforce" on AWS), a plain on-demand address with no token is refused at the CDN, the staging edge and the API, so the play gate's address is the only one that plays.
