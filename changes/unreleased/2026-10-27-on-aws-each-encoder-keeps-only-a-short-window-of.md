---
scope: internal
type: improved
area: Fleet
---
On AWS each encoder keeps only a short window of its run on its server's disk once the segments are in S3 (30 minutes by default, never less than the DVR window plus two minutes), the encoder servers get a sized gp3 root volume, and placement's disk check is on and counts that window instead of the whole run. The Mac keeps every run locally as before.
