# Workflow — Secure share page (time-boxed standalone preview)

Share ONE asset (a VOD clip, a live channel, or an event) with someone outside the
platform, via a link to an isolated page that shows only that asset. No login, no
console, no other content. Follows a standard media-management "Share asset" flow.

## Actors
- **Creator** — an account admin, authenticated (JWT session or account secret key).
- **Recipient** — anyone with the link. No account, no sign-in.

## End-to-end steps
1. Creator opens a clip/asset and chooses **Share** (the "Share asset" modal).
   They set: recipients (emails, optional), an optional note/message, an **access
   period** (1/3/7/14/30 days) that becomes the expiry, an **access type**
   (`preview_only` or `allow_download`), which **downloadable elements** are
   allowed (hi-res, metadata), an optional **PIN**, an optional **max views**, and
   whether to **notify on first open**.
2. Backend `POST /api/share-links` validates the asset belongs to the creator's
   account, mints a random token (`shr_…`), stores only its SHA-256 hash, and
   returns the one-time share URL. The raw token is shown once and never again.
3. The link is delivered to recipients (email send is a follow-up; the URL is
   returned to the creator to copy now).
4. Recipient opens `GET /share/:token`. The page is served with `noindex` and
   fetches its data from `POST /api/share/:token/resolve`.
5. Resolve enforces policy in order: revoked → expired → view cap → PIN. If a PIN
   is set, the page prompts for it and re-submits. On pass, resolve runs the
   **same geo/rights gate as normal playback** (blackout → replacement or hidden),
   mints a short-lived (5 min) playback token, increments the view count, stamps
   first-open, and (if enabled and first open) fires a notify to the creator.
6. The page renders: brand header, "expires in N days" bar, shared-by attribution,
   a **watermarked** preview player (hls.js), Metadata / Download-hi-res buttons
   (only when allowed), About, the creator's note, and Details + Your-access cards.
7. Downloads go through `GET /api/share/:token/download/:element` (`hi_res` |
   `metadata`), each gated by the link's allow flags. Hi-res returns a short-lived
   URL (real S3 presign in the deployed env).

## States a link can be in
`active` · `expired` (410) · `revoked` (410) · `view_cap` reached (410) ·
`pin_required` / `pin_wrong` (401) · `not_found` (404).

## Management
`GET /api/share-links` (list this account's links + view stats),
`GET /api/share-links/:id`, `POST /api/share-links/:id/revoke` (kill immediately).

## Security properties
Raw token shown once (hash stored). The public surface returns only the one
resource, never accepts an admin credential, and is cross-tenant isolated (an admin
cannot create a link for another account's asset → 404). Time-box, revoke,
max-views, and optional PIN all enforced. Geo/rights identical to public playback.

## Build state
Backend + standalone page: **built and tested** (test/share-links.check.sh, 20/20).
Interface integration (the "Share asset" modal wired into the console) and real S3
presign + server-side watermark burn-in: **follow-ups** (see build status).
