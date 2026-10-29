---
scope: core
type: added
area: Radio
---
An operator can correct a now-playing log entry that was put in the wrong class: choose Song, Ad or Content in its Class column on the station's page. Volt keeps what it had said and who corrected it, and the API has the same with PATCH /api/radio/{id}/log/{entryId}.
