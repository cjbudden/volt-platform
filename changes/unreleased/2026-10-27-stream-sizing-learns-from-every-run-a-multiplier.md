---
scope: internal
type: added
area: Fleet
---
Stream sizing learns from every run: a multiplier per component and instance family is fitted from servers' measurements (bounded, outliers set aside), storage is projected from the bitrates, projection against actual is reported per class in the platform fleet plan, and placement can refuse a server whose task disk would run short (FLEET_TASK_DISK_GIB).
