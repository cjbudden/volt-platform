---
scope: core
type: changed
area: VOD
---
Content can be created and saved with required metadata fields still empty, through the console or the API, and filled in along the way. Publishing checks them instead: it is refused until every required field is filled, and says which ones are missing.
