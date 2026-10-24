---
title: <Topic>
sidebar_position: <n>
description: <One sentence: what a developer can build with this.>
guide: developer
---

<!--
DEVELOPER GUIDE TEMPLATE (build queue 1.14-G0). For customer developers.
Code samples live as files a check suite runs against the local API (item
1.14-G6), so they cannot drift from the product; include them rather than
pasting. Hosts are your-volt-host or example.com, keys pk_live_... .
scripts/check-coverage.mjs checks `guide: developer` and the headings below.
-->

# <Topic>

<What it is, in two sentences.>

## What it is for

<The integrations this makes possible.>

## Before you start

- <An app and key (link to the apps and keys guide), the access the key needs.>

## Step by step

### 1. <First call>

```bash
curl https://your-volt-host/api/... -H 'Authorization: Bearer pk_live_...'
```

<What comes back, and the fields that matter.>

## Troubleshooting

| Response | Means | Do |
|---|---|---|
| <401 ...> | <...> | <...> |
