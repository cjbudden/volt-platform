# Workflow — Publish / share a clip to social media

Push a clip (or any VOD asset) out to a social platform as a public post:
YouTube, Facebook, X, TikTok, Dailymotion (plus the built-in `portal`). Distinct
from share links: a share link is a private, time-boxed preview; publishing is a
public post on an external platform.

## Actors
- **Account admin** — connects the social accounts and triggers a publish.
- **Platform** — the external service the video is uploaded to via its API.

## One-time setup (per account)
1. Admin links a social account: `POST /api/publish-targets` with the platform and
   a display name. The OAuth token is exchanged and stored in Secrets Manager; the
   row keeps only a `credentials_ref`, never the raw token.
2. Targets are listed/edited/removed via `/api/publish-targets` (enable/disable per
   destination).

## Publish flow
1. Admin opens a clip and chooses **Publish to…**, picks one or more connected
   targets, and edits the caption (title/description/thumbnail default from the
   clip's metadata).
2. `POST /api/publications` creates a `publications` row per (asset × target) in
   `pending` and hands the job to the platform **adapter**.
3. The adapter uploads the clip's progressive MP4 with the mapped title,
   description, and thumbnail, then stores the returned external URL and flips the
   row to `published` (or `failed` with a reason).
4. View counts are synced back periodically per platform and stored on the
   publication (`sync-views`), feeding the same analytics surface.

## Interface integration
A **"Publish to…"** action on a clip: target picker (only connected + enabled
platforms), caption editor, per-target status chips (pending / published / failed),
and a link to the live post. Plus a **Connected accounts** settings screen for
linking/unlinking platforms.

## Build state
- **Built:** data model (`publish_targets`, `publications`), config + publish +
  view-tracking APIs, the six-platform enum, publication state machine.
- **To deliver:** per-platform OAuth app + token exchange, the real upload adapter
  per platform (currently stubbed), the "Publish to…" UI + Connected-accounts
  screen, and real per-platform view-count sync.
- **Blocker:** each platform's developer app credentials (client id/secret) are
  needed from the account owner before the adapters can go live.
