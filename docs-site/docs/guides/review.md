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

- Clips to review: they are cut in [Recordings](recordings.md) and appear in the [Media Library](media-library.md). A clip comes into this queue when it is sent for review. The console does not have a button for that yet: send it with the API (see [Through the API](#through-the-api)).
- If approval should be required before publishing, set **Require an approved review before publishing** under **Publish gate** in [Publishing Rules](publishing-rules.md).
- The right access: see [Who can do it](#who-can-do-it).

## Step by step

### Work through the queue

1. Open **Review** in the sidebar. The table lists each waiting clip with its **Clip** title, **Source**, **Length**, **QC** result (with the number of errors and warnings), **State** and when it was **Cut**.
2. Choose **Open** on a clip, or click its row, to see its findings and decide.
3. **Source** opens the recording the clip was cut from, so you can see the material around it.
4. Choose **Refresh** to pick up clips sent for review since you opened the page.

### Read what QC found

1. In the open clip, the line at the top shows its review state, its QC result (**QC pass**, **QC warnings** or **QC failed**) and what that means for publishing, for example **Ready to publish.** or **Publishing is allowed, but QC has outstanding findings on this clip.**
2. **What was measured** lists each finding: **error**, **warning** or **info**, the check, the time in the clip, and what was measured against what was expected. **Every check ran and found nothing.** means a clean pass.
3. **Not checked** names any check that did not run. That is different from a check that ran and found nothing.
4. Choose **Re-run QC** after a re-cut, or when a check was added. The result appears after a few seconds.

### Decide

1. Type a note in **A note for whoever reads this next…**. A note is required to request changes or reject.
2. Choose one:

   | Button | Does | Afterwards |
   |---|---|---|
   | **Approve** | Approves the clip. It reads **Approve anyway** when QC has findings, and a line warns that the approval is recorded against your name | The clip leaves the queue |
   | **Request changes** | Sends it back for changes (shown only for a clip **In review**) | It stays in the queue as **Changes requested** |
   | **Reject** | Rejects the clip | The clip leaves the queue |

3. **Who decided what** lists every decision on the clip: **When**, **Who**, the **Decision** and the **Note**. A decision made over QC findings is marked **over QC** with the QC result at the time.

### Publish an approved clip

Publishing is not done here. Open the clip in the [Media Library](media-library.md), go to its **Availability** tab and choose **Publish**. Its **Review** column there shows **Approved**.

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
| Approve, request changes, reject, re-run QC | Media library & publishing: Manage |
| Open the source recording | Recordings & clips: View |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Nothing waiting** | No clip is in review or has changes requested | Expected; clips appear once they are sent for review |
| **Nothing measured yet. Run QC to see what is in this clip.** | QC has not run on this clip, or has not finished | Choose **Re-run QC**, wait a few seconds, then **Refresh** |
| "Say why: a decision of "changes requested" needs a note." (or "rejected") | Requesting changes and rejecting need a note | Type a note, then choose the button again |
| "A clip cannot go from changes_requested to approved." | A clip with changes requested has to go back into review before it can be approved | Send it for review again with the API, then approve it; or **Reject** it |
| **This account requires review before publishing, and this clip is…** | Publishing waits for an approval | Approve the clip |
| **This account blocks publishing when QC has failed.** | Publishing waits for a clean QC | Re-cut the clip, then **Re-run QC** |
| **Couldn't load the review queue.** or **Couldn't load this review.** | The page could not be read | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/vod/review/queue` | The clips waiting: in review or with changes requested, oldest first |
| `GET /api/vod/{id}/review` | One clip's state, QC findings, decisions and whether it may be published |
| `POST /api/vod/{id}/review` | Moves it on: `{"to": "in_review"}`, `"approved"`, `"changes_requested"`, `"rejected"` or `"draft"`, with a `note` (required for anything but `in_review` and `approved`) |
| `POST /api/vod/{id}/qc` | Runs QC again |

This sends a clip for review, which puts it in the queue:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to": "in_review"}' \
  "https://your-volt-host/api/vod/$ASSET_ID/review"
```

Every route is in the [API reference](/api-reference).
