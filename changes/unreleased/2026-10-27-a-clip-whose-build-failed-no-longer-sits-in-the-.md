---
scope: core
type: fixed
area: VOD
---
A clip whose build failed no longer sits in the library looking normal: the failure is written to the asset. Automatic VOD from the guide and scheduled clips now accept up to 60 s of missing recording (QC flags the gap) instead of failing outright, and a clip that skips a gap no longer fails at the last step.
