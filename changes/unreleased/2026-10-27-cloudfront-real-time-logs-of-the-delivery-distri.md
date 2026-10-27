---
scope: internal
type: added
area: Deploy
---
CloudFront real-time logs of the delivery distribution go to an on-demand Kinesis stream (cdn_logs.tf, on by default); the scheduler's leader reads them into the analytics database and keeps the sampling rate near 1,000 lines a second. Settings CDN_LOG_*.
