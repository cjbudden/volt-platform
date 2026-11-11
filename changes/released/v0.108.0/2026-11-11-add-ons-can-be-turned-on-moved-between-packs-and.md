---
scope: core
type: added
area: Billing
---
Add-ons can be turned on, moved between packs and turned off through the API (GET, PUT and DELETE /api/billing/addons). Turning one on or moving to a bigger pack charges the full monthly price for the month; a smaller pack or off is at once with no refund; the included quantity starts again on the 1st. Add-on charges appear on your monthly invoice.
