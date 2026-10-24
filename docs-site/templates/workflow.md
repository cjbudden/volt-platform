---
title: <The outcome, for example "A live event from start to finish">
sidebar_position: <n>
description: <One sentence: what the reader will have running at the end.>
guide: workflow
---

<!--
WORKFLOW GUIDE TEMPLATE (build queue 1.14-G0). A workflow crosses sections:
it says which sections take part, in what order, and what passes between
them, and links to each section's own guide for the detail instead of
repeating it. Copy to docs/workflows/<name>.md, fill every heading, delete
these comments, and list it in coverage.json under workflows.
scripts/check-coverage.mjs checks `guide: workflow` and the headings below.
Walk the whole flow in the seeded app before publishing; where a step needs
real hardware or the cloud, say so on the page.
-->

# <Outcome>

<Two sentences: the situation and what this workflow gets you.>

## What it is for

<Who needs this and when. What it saves them from doing by hand.>

## Before you start

- <Each thing that must exist, linked to its section guide.>

## The flow

<A diagram (an image in static/img/flows/) and one line per arrow saying what
moves between the sections: a schedule, a recording, a clip, a rule.>

| Step | Section | What happens |
|---|---|---|
| 1 | [<Section>](../guides/<guide>.md) | <...> |

## Step by step

### 1. <First stage>

1. <...>

### 2. <Next stage>

1. <...>

## Who can do it

<Which roles can run each stage; one person or several.>

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| <...> | <...> | <...> |

## Through the API

<The same flow from code, step by step, with links to the API reference.>
