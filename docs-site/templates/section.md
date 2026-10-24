---
title: <Section name as it appears in the console>
sidebar_position: <n>
description: <One sentence: what a customer does here.>
guide: section
---

<!--
SECTION GUIDE TEMPLATE (build queue 1.14-G0). Copy to docs/guides/<name>.md,
fill every heading, delete these comments, and list the page against its
section in coverage.json. scripts/check-coverage.mjs checks the frontmatter
`guide: section` and the seven level-two headings below; keep their wording.

House style (MAINTAINING.md): customer staff are the reader; say what Volt
does and how to use it, never how it is built. Plain sentences, Australian
spelling, sentence-case headings, button and field names in bold exactly as
the console shows them. No internal names, source paths or infrastructure.
Check every step in the app (the seeded demo, see MAINTAINING.md) before
writing it down.
-->

# <Section name>

<Two or three sentences: what this section is and the one thing most people come here to do.>

![<What the picture shows, in words>](/img/screens/<shot-name>.png)

## What it is for

<The jobs this section does, as a short list or two short paragraphs. Name the
kind of person who uses it day to day.>

## Before you start

- <What must exist first, with a link to its guide (for example a channel group, a source, an app).>
- <The plan or add-on it needs, if any.>
- <The access level it needs: see Who can do it.>

## Step by step

### <The most common task, as a verb phrase>

1. Open **<Section>** in the sidebar.
2. <One action per step, naming the button or field in bold.>
3. <What you should see when it worked.>

### <The next task>

1. <...>

## How it connects

| Section | How it relates |
|---|---|
| [<Other section>](<other-guide>.md) | <What flows between them, in one line> |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| <View> | <for example Channels: view> |
| <Change> | <for example Channels: operate> |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| <A message or state shown in the console> | <Why> | <The fix> |

## Through the API

<The routes that do the same as the console, with one short example, and a
link to the API reference. If there is no API for this section, say so.>
