---
scope: core
type: fixed
area: API
---
Renaming or moving an image with PATCH /api/files/{id} now updates everything that uses it and keeps its old address working, and renames all files of a video item together.
