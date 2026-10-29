---
scope: core
type: fixed
area: Platform
---
The API no longer stops when the database drops an idle connection (a restart or failover): the connection is replaced and requests carry on.
