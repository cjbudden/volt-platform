---
title: <Topic>
sidebar_position: <n>
description: <One sentence: what a developer can build with this.>
guide: developer
---

<!--
DEVELOPER GUIDE TEMPLATE (build queue 1.14-G0). For customer developers.
Code samples live as files in samples/ that a check suite runs against a
real API (item 1.14-G6), so they cannot drift from the product. Show one
with an EMPTY code block that names the file; the build fills it in. Never
paste code into a developer guide: the coverage suite fails on it. Hosts are
your-volt-host or example.com, keys pk_live_... .
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

```bash file=<topic>/<first-call>.sh
```

<What comes back, and the fields that matter.>

## Troubleshooting

| Response | Means | Do |
|---|---|---|
| <401 ...> | <...> | <...> |
