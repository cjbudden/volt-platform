# Console feedback, actions and layout standard

Where errors, warnings and results appear in the Volt console, what they look
like, and how list rows and forms offer their actions. The code is
`volt-web/src/notices.tsx` (feedback) and `volt-web/src/listActions.tsx`
(row menus, selection, bulk actions). A new page follows this; an old page
moves to it when touched.

## 1. Four places, one look

| Place | Where on screen | What goes there | Component |
|---|---|---|---|
| **Global** | Full width, directly under the top bar, on every page | States of the whole app: can't reach the server, the session is ending, the account is suspended or over a limit that blocks work everywhere, maintenance | `showGlobal(id, notice)` / `dismissGlobal(id)`, rendered by `<GlobalNotices/>` in the shell |
| **Page** | Top of the page content, above the title, stacked | This page could not load (with **Retry**); something on this page is unavailable and why (a full group); what the role allows here; the result of an action taken on this page | `usePageNotice(id, notice \| null)` while a condition holds; `useNotify()(notice)` for a one-off result. Rendered once by the shell and cleared when you leave the page |
| **Form** | Drawer or dialog footer, left of the buttons | The last attempt's error; otherwise why the main button is disabled | `<FormStatus error blocked/>` |
| **Field / row** | Under the field, or inside the row | A field's own problem; an item's own state (a failed upload, a publish error) | `<FieldError/>`, or `className="err"` text / a status tag in the row |

A page that cannot show anything at all renders `<PageError message onRetry/>`
in place of its content.

**Live samples:** open `/ui-samples` in the console (any signed-in user; it
calls no API). It shows every kind in its place, with buttons to raise the
global notices, a page result, and the stop and remove confirmations.

Never:
* text floating beside a button to explain why it is disabled (the reason goes
  in the page region, the button keeps it as a tooltip);
* an error at the bottom of a long form, where it is off screen;
* a banner per table row;
* a coloured edge bar on a notice. A notice is a tinted panel with an even
  hairline border and a leading icon.

## 2. Kinds

| Kind | Colour token | Use | Clears |
|---|---|---|---|
| `error` | `--down` | Something failed or cannot load | When fixed, or dismissed. Never by itself |
| `warn` | `--warn` | Something is unavailable or at risk, and why | When the condition clears |
| `info` | `--sched` | Context: what the role allows, what will happen | When the condition clears |
| `ok` | `--live` | A result: "Removed 3 channels" | By itself after 8 s, or dismissed |

A notice has an optional bold **title** (a short sentence ending in a full
stop: "Couldn't load channels."), a **message** (the server's words, or ours),
and up to two **actions** (Retry, View radio stations). Results raised with
`useNotify` replace the previous result rather than stacking.

Order in the page region: errors, then warnings, then info, then results.

## 3. Forms (drawers and dialogs)

* Submit errors and the reason the primary button is disabled go in the
  footer through `<FormStatus/>`, so they are seen whichever tab or scroll
  position the form is at.
* A field's own problem goes under the field (`<FieldError/>`), and the
  field gets `has-err`. On submit, open the tab holding the first problem.
* Every submit is wrapped so that anything thrown, before or after the
  request, ends in `FormStatus`. Nothing fails silently.
* A server 422 already reads as a sentence ("Check these fields: name:
  Required"); show `error` as it is.
* Disabled buttons look disabled (`.btn:disabled`).
* Every dropdown uses the same chevron, 14px in from the right edge, with
  40px kept clear so a long label never runs under it. Compact dropdowns in
  toolbars and players use `className="inp sel-sm"`. Set width inline if
  needed, never padding or background, which would undo this.

## 4. List rows

* A row has **one primary action** as a button (Start / Stop, or Open when the
  role cannot run it), then a **"⋯"** button of the same height beside it.
  `<div className="row-actions">` keeps them aligned and equal in height.
* The "⋯" menu (`<RowMenu/>`) holds the rest, in this order: **View**,
  **Edit settings**, then, after a separator, **Remove** (destructive, red).
  An item that cannot be used now stays in the menu, disabled, with the
  reason under its label ("Stop the channel first"). Items the role does not
  allow are left out.
* Clicking the row opens it (View).

## 5. Selection and bulk actions

* A checkbox column on the left (`<SelectAllHead/>`, `<SelectCell/>`);
  ticking does not open the row. The header box selects what is shown.
* While rows are ticked, the bulk bar (`<BulkBar/>`) sits above the table:
  "3 channels selected", then the actions, then Clear.
* Each action says how many of the selection it applies to when that is fewer
  than all, e.g. "Stop (1)", and explains on hover ("Running channels are left
  out: stop them first"). An action that applies to none is disabled.
* Bulk actions run one request per item (`runBulk`), a few at a time, with
  progress in the bar, and report the outcome as a page result: "Stopped 3.
  RTM Sport: not permitted."

## 6. Filters, sort and views (Channels, Radio, Events)

One toolbar above every list (`listFilters.tsx`): filter chips on the left,
pickers on the right, wrapping on a narrow screen.

| List | Chips | Group | Sort (default first) | Views |
|---|---|---|---|---|
| Channels | Type: All, Transcode, Packaging. Status: All, Running, Stopped / idle, Problems (shown when there are any) | yes | Name A to Z, Name Z to A, Status (running first), Group, Newest first | List |
| Radio | Status: All, On air, Running off air, Stopped / idle | yes | Name A to Z, Name Z to A, Status (on air first), Group, Newest first | List |
| Events | Status: All, Live, Upcoming, Ended | yes | Date (live, then upcoming soonest, then ended most recent), Date earliest first, Date latest first, Name A to Z, Name Z to A | List, Calendar |

* Each chip's count is what that chip would show with the other filters
  applied, so the numbers always match the result.
* The Group picker appears when the account has more than one group.
* Names sort naturally and ignore case ("Channel 2" before "Channel 10").
* Choices (filters, sort, view, calendar mode) are remembered per list in this
  browser. "Clear filters" appears when anything is filtered, and a filter
  that hides every row says so with a Clear button instead of an empty table.

**Create buttons.** A list's own create button (New channel, New station,
New event) is the last item at the right end of the toolbar, after the
pickers and a divider, not in the page title row. When the list is empty the
empty state carries the create button instead. A blocked create button is
disabled and its reason is a warning in the page region (section 1).

**New Stream** in the top bar asks what is being set up first
(`NewStreamChooser.tsx`): 24x7 channel, Event, Radio station, and FAST channel
(shown as coming soon). Choosing one opens that kind's own form on its page.
A kind the role cannot create, or with every group full, is shown disabled
with the reason rather than hidden. Arrow keys move between kinds, Escape
closes.

**Event calendar** (`EventCalendar.tsx`), laid out like a mail calendar, in
the browser's local time, weeks starting Monday, with the same filters:

* **Day / Week:** a time grid; each event is a block from its start to its
  end, overlapping events side by side, a red line at now. Opens scrolled to
  now (or the first event).
* **Month:** six weeks of days, up to three events per day with their start
  time, then "+N more". Clicking a day opens it in Day.
* **Year:** twelve small months, days with events tinted (green when one is
  live), a count per month. Clicking a month opens Month, a day opens Day.
* Today, previous and next move through the period; colour shows live,
  upcoming and ended.

## 7. Confirmation

| Action | Confirmation |
|---|---|
| Start one or many | None |
| Stop one | None from a row (the detail page asks) |
| Stop many | `ConfirmDialog` listing them |
| Remove one | Dialog showing what goes with it; type the **name** |
| Remove many | Dialog listing what will go and what will be skipped and why, the combined impact, type **remove N** |

Every removal is a separate request and a separate audit row
([AUDIT_LOG.md](AUDIT_LOG.md)).

## 8. Channel source forms: packaging and transcode

The New channel form and Channel settings show the same source form for the
same kind of channel (`volt-web/src/PackageRenditions.tsx` for packaging).

| Channel | Source section (create and settings) |
|---|---|
| **Transcode** | Primary source and optional backup, each with **Check source**; the output ladder (rungs we encode) |
| **Packaging** | One row per sent rendition: label (1080p), bitrate (kbps), protocol (HLS or DASH), URL with **Check source**; add and remove renditions. Fallback on source loss: none, a matching backup URL per rendition (each with **Check backup**), or one fallback source transcoded to every bitrate |

* **HLS masters.** Paste a master playlist into a rendition (or its backup)
  and its variants are listed to choose from, as on every other source
  field. Choosing one puts the variant's address in the row and fills the
  label and bitrate from what the master declares. **Use every variant as a
  rendition** makes one row per video variant, highest first; on a backup
  master, **Match every rendition to its backup variant** pairs them by
  height. A new master with no choice made stops the save once and asks.
* **Check source** shows the source's **bitrate** everywhere (transcode and
  radio too): measured from the latest segments for an HLS media playlist,
  plus what the master declared when the variant was picked from one; the
  range and each variant for a master; what the stream reports otherwise. On
  a rendition it warns when the stream's height is not the label's, or the
  bitrate is more than 30% off the row's.
* The packaging ladder is the renditions: saving settings replaces the inputs
  and the ladder together. A packaging channel saved with one input before
  this form shows it as the top rendition, ready to split out.
* Choosing a fallback turns on input failover, since the backups do nothing
  without it.
* While the channel runs, the source section is locked (shown, copyable, not
  editable), as for transcode.

## 9. Channel page: the Source pane

Source on the left, output on the right. The Source pane shows the input
itself, and every input's health, so a problem with any rendition is seen
without opening Settings (`ChannelDetail.tsx` SourcePlayer, `sourceInputs.tsx`).

**What it plays.**

| Input | Channel stopped | Channel running |
|---|---|---|
| HLS | The source itself, straight from its address. If the browser may not play it (the source's server allows no playback from other sites), Volt relays it, unchanged, and says "relayed by Volt" | Same; if neither works, what Volt's ingest received |
| DASH | The source itself (dash.js) | Same, else what Volt's ingest received |
| SRT, RTMP, RTSP, NDI, ST 2110 | Nothing: a browser cannot play them. The pane says so | What Volt's ingest received, labelled "via Volt ingest" (for packaging, the matching rendition of the packaged output, before it is public) |

The corner label always says which: "direct from the source", "relayed by
Volt", or "via Volt ingest". When nothing can play, the pane says whether the
source is unreachable (Volt cannot read it either) or only this browser is
refused.

**Every input at a glance.** Below the picture, one chip per input (each
rendition, then the backups) with a status dot; click one to preview it. The
footer gives one line for all of them ("1 of 6 inputs not working", "6
inputs · all OK"); **All inputs** lists each with protocol, bitrate, what it
carries and its verdict, with **Check** per input and **Check all**. Inputs
with a problem are listed without asking.

A verdict comes from the ingest while the channel runs (receiving, no
signal), otherwise from Check source, which runs automatically for pull
inputs when the page opens: not reachable; a master playlist where one
rendition is expected; a picture height that is not the label's; a bitrate
more than 30% from the rendition's. Push inputs (RTMP, listener SRT) wait for
the sender.

**The relay** (`modules/sourcePreview.ts`, `test/source-preview.check.sh`):
`GET /api/channels/:id/inputs/:inputId/preview` gives a two-hour address for
one http(s) input of a channel in the caller's account. The relay rewrites
every address in the playlists back through itself, signed, so it fetches
only what the configured source's own playlists name; segments pass through
byte for byte.

## 10. Channel page: header actions, Clear QC, Remove, audio meter

**Header.** The name, type and status on the left; on the right the everyday
actions. Secondary actions are icons, named in a tooltip on hover (and to
screen readers): **QC** (shield with a tick; red when something failed),
**Clear QC** (circular arrow), **Share**, **Settings** (cog). The run actions
(Start channel, Go on air, Take off air, Stop channel) stay as labelled
buttons. **Remove is not in the header**: it sits at the foot of the page in
its own panel, away from the buttons pressed every day, and still opens the
dialog that shows what goes and asks for the name.

**Clear QC** (`POST /api/channels/:id/reset-health`, operate). A crash or a
source fault from an earlier run keeps a channel red ("SERVER ERROR") until
it runs cleanly again. Clear QC records a `qc.reset` event and the health
model judges the channel only on what happens after it; it also clears an
auto connect give-up (and stands a stopped channel down, so no retry starts
by itself). Nothing is deleted: the faults stay in the event log, followed by
"QC cleared by <who>: was Server error (...)", and the audit log has a row. A
fault that is still real comes back from its next event or from the output
ground truth, and the notice says so. `test/qc-reset.check.ts` (8 checks).

**Audio meter.** Lower right of each player: one bar of lit segments per
audio channel, bouncing with the audio: one for mono, two for stereo, six for
5.1, up to eight. No channel letters (with more than two channels they would
be guesses about the layout). dBFS scale from -48 to 0, green to -18, yellow,
amber from -9, red from -3, with a peak marker that holds for a second and a
half. Two identical channels count as one (mono sent as stereo). Mute, volume
and the audio track picker appear beside it on hover; separate language
tracks are switched there, and the meter follows the track playing.

**Gate words and readings.** Each gate shows what its state means for that
gate (a stopped Server is NO SERVER, UNASSIGNED or NOT CONNECTED, never just
"stopped"), and live readings in its lower right: the encoder's CPU on
Server, data received per second and in total on Input. Every status and
word is in [STATUS_MAP.md](STATUS_MAP.md). Stopping on purpose raises no
errors until the next Start; the log shows both commands.

**Subtitles (CC).** The CC button and its language list appear only when
there is a transcription: subtitle tracks in the output manifest (or the test
stream's side captions while it runs). The list holds the languages actually
there; one language means no list.

**View as a viewer in…** Under the output player: pick a country and who the
viewer is (not signed in, signed in, has paid). The play gate answers, and a
refusal covers the picture with the reason and the layer that decided
(account geo, channel geo, access rule, programme blackout). See
[ACCOUNT_SETTINGS.md](ACCOUNT_SETTINGS.md).

**Isolate a channel.** Click a bar to mute that channel: the bar becomes a
plain panel with a muted-speaker mark. Click it again to bring it back.
Double-click a bar to hear only that channel; double-click it again to hear
them all. The sound is downmixed to your speakers the standard way, so muting
the left channel of a 5.1 source leaves the centre in both ears. Muting a
channel is only for listening here: it changes nothing in the channel's
output. Available once the meter reads the element's own audio (after the
first click on the page).

How every channel is measured: the browser's stream capture only gives a
stereo downmix, and the element's own audio (all channels) is silent while
the element is muted, which the page needs for autoplay. So the meter starts
on the stereo capture and moves to the element's own audio at the first click
or tap on the page; from then on the sound goes through a gain node that does
the muting, so nothing becomes audible by itself. Flat and grey when the
browser cannot measure.

## 11. Status of the move

Done across the console: the shell (global and page regions,
server-unreachable global notice, role hint) and every page, drawer and
dialog. What remains as `className="err"` is an item's own state inside a row
(a failed publish, a source error), which the standard keeps inline.
