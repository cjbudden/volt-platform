---
title: Graphics
sidebar_position: 3.2
description: "HTML graphics on video channels and events: templates, setups, where each runs, live control and event rundowns."
guide: section
---

# Graphics

Graphics puts HTML graphics on your video channels and events: scorebugs, lower thirds, tickers, logos and full-frame panels. You start from a **template** (Volt's own, or one you bring), save a **setup** with its text, data and position, and **assign** it to a channel or event. From there it runs on its own (always, by a rule or from the guide), or an operator takes it on and off in **live control**.

![The Graphics page: counts of templates, setups and what is on air, the four tabs, and the template library with a preview of each](/img/screens/graphics.png)

## What it is for

- **A library of templates.** Volt ships ready-made graphics (clock and weather, corner bug, locator, name super, news L-bar, ticker, scorebug, countdown, weather panel). You can add your own HTML graphics, including packages built for CasparCG, SPX or Loopic and EBU OGraf packages.
- **Setups.** A template plus its saved content: fixed text, an image, a value from a data feed, the current or next programme from the guide, or a value an operator or your own system sets live.
- **Where and how it runs.** Drawn by Volt players on top of the picture, burned into the video itself, or both; always on, by rule, on a trigger at programme start or end, or by hand.
- **Live control and rundowns.** Operators take graphics on and off and change scores and names while on air; an event can have a full graphics rundown, run with **TAKE NEXT**.

Graphics designers prepare templates and setups; presentation and match-day operators run them live.

## Before you start

- A video channel or event to put graphics on. Radio stations are not offered: there is no picture to draw on.
- To burn graphics into the video, the channel or event must use a transcode workflow. A packaging channel's graphics are drawn by the player.
- For your own template: an HTML page or a .zip package of up to 25 MB, with every font, image and script inside it. Graphics run sandboxed: no network, no access to Volt.
- **Graphics: Manage** to build and assign, **Graphics: Operate** to run them live (see [Who can do it](#who-can-do-it)).

## Step by step

### Look at a template

1. Open **Graphics** in the sidebar. The **Templates** tab lists every template; filter by kind (**Scorebug**, **Lower third**, **Ticker**, **Bug**, **Full frame**), **Status** and **Source**, or search by name.
2. Choose **Preview** on a template. It plays on a stage the size of the picture; **Play**, **Next** and **Stop** run it, and **Sample data** lets you try values (nothing is saved).
3. **Checks** shows what Volt found: the canvas size, the fields it can fill, and that it is self-contained and sandboxed. **Versions** lists its published versions; setups stay on their version until you move them.

### Add your own template

1. On **Graphics**, choose **Add template**.
2. Choose **Upload a package** (a .zip with an index page, fonts and images, or a single .html file), **Paste HTML**, or **Start from a template** to copy one and change it (Volt's own templates are read-only; **Customise a copy** does the same from a Volt template's page).
3. Give it a **Name** and **Kind**, then **Check and save draft**. Volt checks it and shows any problems under **Checks**.
4. When the draft is ready, publish it from the template's page (**Publish v1**). A published version never changes; later drafts become new versions. Nothing on air changes until a setup is moved to the new version.

### Build a setup

1. On a template, choose **New setup** (or **New setup from this** on its page).
2. Give the setup a name. Under **Where each field gets its content**, choose for each field what it **Comes from**:

   | Comes from | Means |
   |---|---|
   | **Fixed text** | The value you type here |
   | **Data feed** | A value from one of your data sources, picked by a path such as `score.home` |
   | **Channel guide** | The current or next programme's title, subtitle or start time |
   | **Operator** | A starting value, changed live in live control |
   | **API** | A starting value your own system changes through the API |

3. Under **Position and size**, choose the **Anchor** corner, nudge it with **Move right (px)** and **Move down (px)**, and set **Size** and **Layer** (5 is on top). The preview follows.
4. Choose **Save**, or **Save and assign** to assign it straight away.

### Assign a setup to a channel or event

1. In the setup, choose **Assign** (or **Save and assign**; or **Assign** on the **Setups** tab).
2. Pick the **Channel or event**.
3. Under **Shown in**, choose **Player overlay** (drawn by Volt players; not in downloads or partner feeds), **Burned into output** (in every rendition, recording and clip; transcode only) or **Both**.
4. Under **How it runs**, choose:

   | Choice | Runs |
   |---|---|
   | **Always** | Whenever the stream is on air. Logos, bugs, sponsors |
   | **By rule** | While the programme matches: **Genre is**, **Title contains**, **Days**, **From** and **To** |
   | **On a trigger** | For a set time after each programme starts or before it ends |
   | **By hand** | Only when an operator takes it on in live control (events default to this) |

5. Leave **Clear for ad breaks** on to take it off during ad items in the guide, then choose **Assign**.

The **On channels and events** tab lists every assignment by stream, with **Taken on**, **Standby** or **Switched off**. **Rules and day** opens a channel's graphics: switch each one on or off, edit how it runs, and see **Today, from the guide**, when each will be on.

### Run graphics live

1. Choose **Live control** on a channel or event (from its graphics, or the **On channels and events** tab). It opens in a window of its own, beside the stream. If your browser blocks the window, the page offers **Open in its own window**.
2. Pick the **Channel or event**. Each graphic shows whether it is **On air** or on **Standby**.
3. **TAKE ON** puts a graphic on screen; **On for 10 s**, **On for 15 s** or **On for 30 s** take it off again by themselves. For one that runs by rule, **Hold on screen** keeps it on until you take it off.
4. Change values: **−** and **+** on a number take effect at once; after typing in a text field, choose **Update on air** (or **Discard**).
5. **TAKE OFF** takes it off. **Changes** lists every action and who made it.

**Output** shows what the graphics look like now. Viewers see them a few seconds later, in step with the stream.

### Prepare and run an event rundown

1. On the **On channels and events** tab, choose an event under **Events without graphics yet**, or **Rundown** on an event that has some.
2. In **Prepare**, choose **Add graphic**: a **Title**, a **Segment**, the **Setup**, its **Content**, and the **Cue**: **Manual: Take next**, **At a clock time**, **After the event starts**, **On a data feed event** or **Repeat while live**, and how long it **Stays on**. **Copy from another event** and **Import CSV** fill a rundown quickly.
3. During the event, switch to **Run**: **TAKE NEXT** puts the next manual item on air in order, **TAKE OFF** clears it, and timed cues fire on their own (shown as armed, so you can **Skip** one). **Pop out** opens the rundown in its own window.

### Feed graphics from data

1. On the **Data sources** tab, choose **Add data source**.
2. Choose the **Kind**: **JSON URL** or **RSS or Atom** (Volt checks it every few seconds), or **Pushed to Volt** (your system sends JSON to Volt with an API key).
3. Set **Check every (seconds)**, **Stale after (seconds without an answer)** and, **If it goes stale**, **Keep the last values on screen** or **Hide the graphics that read it**. Save, then **Test now** to see what the source sent.
4. In a setup, set a field to **Data feed**, pick the source and a dotted path such as `score.home` or `items.0.title`.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Events](events.md) | Graphics are assigned to them; burned graphics need a transcode workflow |
| [EPG](epg.md) | Rules and triggers follow the guide, and fields can show the current or next programme |
| Image Library | Images for a setup's image fields |
| [API Keys & Apps](api-keys-and-apps.md) | A pushed data source and **API** fields are driven with an API key |
| [Live Streams](live-streams.md), [Multiview](multiview.md) | Where you watch the result with everything else on air |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See templates, setups, assignments, rundowns and data sources | Graphics: View |
| Take graphics on and off, change their values, run event rundowns, push data | Graphics: Operate |
| Add and publish templates, build setups, assign them, build rundowns, add data sources | Graphics: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| A template marked **In development** or with errors | Its draft has not passed the checks, or nothing is published yet | Open it, read **Checks**, fix the package and upload it again |
| **v2 available** on a setup | A newer version of its template was published | Open the setup and move it to the new version when you are ready |
| "…is packaging only, so its graphics come from the source encoder" when assigning | **Burned into output** needs a transcode workflow | Choose **Player overlay** |
| A graphic on **Standby** that should be on | It runs by rule or trigger and the guide does not match now, or there is no guide for the day | Check the channel's **Today, from the guide**, or **Hold on screen** in live control |
| A data source shows **Stale** or **Error** | The feed has not answered in time, or answered something unreadable | Open it, **Test now**, and check the URL or what your system pushes |
| Viewers see the change a few seconds after live control | Graphics follow the stream, which plays a few seconds behind live | Expected |

## Through the API

| Request | Does |
|---|---|
| `GET /api/graphics/templates`, `GET /api/graphics/setups` | The library and the setups |
| `POST /api/graphics/assignments` | Assigns a setup to a channel or event |
| `POST /api/graphics/assignments/{id}/air` | Takes it on or off |
| `PATCH /api/graphics/assignments/{id}/state` | Changes its values on air (for **Operator** and **API** fields) |
| `POST /api/graphics/sources/{id}/push` | Pushes new data to a **Pushed to Volt** source |
| `POST /api/graphics/rundowns/{eventId}/take`, `/take-off` | Runs an event rundown |

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"values": {"homeScore": 2}}' \
  "https://your-volt-host/api/graphics/assignments/$ASSIGNMENT_ID/state"
```

Every route is in the [API reference](/api-reference).
