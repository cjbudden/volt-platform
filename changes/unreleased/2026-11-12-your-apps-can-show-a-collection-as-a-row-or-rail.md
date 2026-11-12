---
scope: core
type: added
area: Collections
---
Your apps can show a collection as a row or rail: GET /api/public/collections/{id} with the app's publishable key lists the collection's public titles in its order, each marked free, members or premium for that app and the viewer's country, and leaves out what the viewer's country or app may not see. Answers are cached by country group and update as soon as the collection or a title changes.
