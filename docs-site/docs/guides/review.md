---
title: Review
sidebar_position: 3.8
description: Decide on clips waiting for review, with what QC measured in each one already attached.
guide: section
---

# Review

Review is the queue of clips waiting for a decision. Each clip arrives with what QC already measured in it (silence, black frames, a length that does not match, gaps in the source), so the person deciding can see the evidence, approve or send it back, and leave a note for whoever reads it next.

![The Review page: the queue of clips with their source, length, QC result and review state, one clip opened to show what was measured and the decision buttons](/img/screens/review.png)

## What it is for

- **A place of work.** Only clips that are waiting are listed: those **In review** and those with **Changes requested**, oldest first.
- **What was measured.** QC runs on every clip as it is cut. Its findings are listed with their severity, the check that found them, the time in the clip and the measurement.
- **What somebody decided.** Approve, request changes or reject, with your name and a note recorded against each decision.
- **A soft gate.** Approving a clip that QC flagged is allowed, and it is written down. Whether publishing needs an approval is set in the publishing rules.

Editors, producers and whoever signs clips off before they go out use it.

## Before you start

- Clips to review: they are cut in [Recordings](recordings.md) and appear in the [Media Library](media-library.md). A clip comes into this queue when it is sent for review: open it in the Media Library and choose **Send for review** beside its **Review** state (see [Send a clip for review](#send-a-clip-for-review)).
- If approval should be required before publishing, set **Require an approved review before publishing** under **Publish gate** in [Publishing Rules](publishing-rules.md).
- The right access: see [Who can do it](#who-can-do-it).

## Step by step

### Send a clip for review

1. Open the clip in the [Media Library](media-library.md). Under **Facts**, its **Review** row shows where it stands.
2. Choose **Send for review** beside a **Draft** or **Rejected** clip. It now reads **In review** and is in the queue.
3. For a clip already waiting, the button reads **Open in Review** and opens this page with that clip open.
4. An **Approved** clip offers **Send back for review**, for example after a re-cut, so it goes round again.

### Work through the queue

1. Open **Review** in the sidebar. The table lists each waiting clip with its **Clip** title, **Source**, **Length**, **QC** result (with the number of errors and warnings), **State** and when it was **Cut**.
2. Choose **Open** on a clip, or click its row, to see its findings and decide.
3. **Source** opens the recording the clip was cut from, so you can see the material around it.
4. Choose **Refresh** to pick up clips sent for review since you opened the page.

### Read what QC found

1. In the open clip, the line at the top shows its review state, its QC result (**QC pass**, **QC warnings** or **QC failed**) and what that means for publishing, for example **Ready to publish.** or **Publishing is allowed, but QC has outstanding findings on this clip.**
2. **What was measured** lists each finding: **error**, **warning** or **info**, the check, the time in the clip, and what was measured against what was expected. **Every check ran and found nothing.** means a clean pass.
3. **Not checked** names any check that did not run. That is different from a check that ran and found nothing.
4. Choose **Re-run QC** after a re-cut, or when a check was added. **QC is running again. The findings below update in a few seconds.** confirms it started; if it could not start, the reason is shown instead.

### Decide

1. Type a note in **A note for whoever reads this next…**. The line under it says when a note is needed: to request changes or reject. Choosing either without one says so before anything is sent.
2. Choose one. The buttons offered follow the clip's state:

   | Button | Shown for | Does | Afterwards |
   |---|---|---|---|
   | **Approve** | **In review** | Approves the clip. It reads **Approve anyway** when QC has findings, and a line warns that the approval is recorded against your name | The clip leaves the queue |
   | **Request changes** | **In review** | Sends it back for changes | It stays in the queue as **Changes requested** |
   | **Send back for review** | **Changes requested** | Puts it back into review once the changes are made. A clip with changes requested is not approved directly | It reads **In review**, and can be approved |
   | **Reject** | Any state but **Rejected** | Rejects the clip | The clip leaves the queue |

   A role with View only sees the findings and the decisions, with **Your role can see this review but not decide it.** in place of the buttons.

3. **Who decided what** lists every decision on the clip: **When**, **Who**, the **Decision** and the **Note**. A decision made over QC findings is marked **over QC** with the QC result at the time.

### Publish an approved clip

If the clip's [publishing rule](publishing-rules.md) has **Auto-publish**, approving it publishes it straight away (a clip still being built is published when its build finishes). Otherwise publishing is not done here: open the clip in the [Media Library](media-library.md), go to its **Availability** tab and choose **Publish**. Its **Review** column there shows **Approved**.

## How it connects

| Section | How it relates |
|---|---|
| [Recordings](recordings.md) | Clips are cut there; **Source** opens the recording a clip came from |
| [Media Library](media-library.md) | Every clip lives there, with its review state in the **Review** column; publish from its **Availability** tab |
| [Publishing Rules](publishing-rules.md) | **Publish gate** decides whether a clip must be approved, or pass QC, before it can be published |
| [Share links](share-links.md) | Private previews for reviewers outside your organisation |
| [Audit log](audit-log.md) | Changes across the account, alongside the decisions recorded here |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the queue, the findings and the decisions | Media library & publishing: View |
| Send for review, approve, request changes, reject, re-run QC | Media library & publishing: Manage |
| Open the source recording | Recordings & clips: View |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Nothing waiting** | No clip is in review or has changes requested | Expected; send one from the [Media Library](media-library.md) with **Send for review** |
| **Nothing measured yet. Run QC to see what is in this clip.** | QC has not run on this clip, or has not finished | Choose **Re-run QC**, wait a few seconds, then **Refresh** |
| **Add a note saying what needs to change first.** or **Add a note saying why before rejecting.** | Requesting changes and rejecting need a note | Type a note, then choose the button again |
| No **Approve** on a clip with **Changes requested** | It has to go back into review before it can be approved | Choose **Send back for review**, then **Approve** |
| **This account requires review before publishing, and this clip is…** | Publishing waits for an approval | Approve the clip |
| **This account blocks publishing when QC has failed.** | Publishing waits for a clean QC | Re-cut the clip, then **Re-run QC** |
| **Couldn't load the review queue.** or **Couldn't load this review.** | The page could not be read | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/vod/review/queue` | The clips waiting: in review or with changes requested, oldest first |
| `GET /api/vod/{id}/review` | One clip's state, QC findings, decisions and whether it may be published |
| `POST /api/vod/{id}/review` | Moves it on: `{"to": "in_review"}`, `"approved"`, `"changes_requested"`, `"rejected"` or `"draft"`, with a `note` (required for anything but `in_review` and `approved`). An approval answers with `autoPublish`: `published` or `scheduled` when the rule published it, `skipped` when it waits for someone |
| `POST /api/vod/{id}/qc` | Runs QC again |

This sends a clip for review, as **Send for review** does, which puts it in the queue:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to": "in_review"}' \
  "https://your-volt-host/api/vod/$ASSET_ID/review"
```

Every route is in the [API reference](/api-reference).
