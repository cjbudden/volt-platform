# Design — pages and embeds

How a customer puts Volt content on their own site, and what a "page" is in this
system. Covers the two embed methods and who each is for, the module catalogue,
the composition templates, how pages are set up and managed, and the iframe
mechanics that quietly go wrong.

Companion to `DESIGN_presentation_framework.md`, which covers the player itself.
Customer-facing snippets live in `EMBEDDING.md`.

---

## 1. The realisation this document exists for

We already have three things that look unrelated:

- a **share page** (a hosted page at a token URL, showing one asset, for
  approval before air)
- an **iframe embed** (a hosted page in someone else's site)
- a **portal page** (a hosted page at a public URL, which we keep almost
  building and then deferring)

They are the same object. A hosted page, bound to some content, composed of a
player plus some modules, themed, with a policy deciding what a viewer may do,
served at a URL.

Building them as three products means three templating systems, three theming
paths, three sets of responsive bugs, and a share page that can never gain an
EPG strip because it is "not that kind of page".

**So: one `Page` object, three framings.** That is the whole design, and it is
also the honest answer to "could this be the base of a portal app builder". Yes,
if the Page is the unit now, even while there are only a handful of templates.
No, if we ship three separate things and try to unify them later.

---

## 2. Two embed methods, and who each is actually for

Both are needed. They are not tiers of the same thing.

### JS embed: for a customer with a developer

One script tag and a div. The player mounts into the host page's own DOM, so it
participates in the host's layout, their CSS, their analytics, their routing.
This is the method to lead with in the documentation, and the one that gets the
full API: custom skins, custom region renderers, headless mode, event callbacks,
imperative control.

It is better in every way that matters to a developer, and it asks for a
developer.

### Iframe embed: for a customer with no developer, and a page to fill

A CMS block, a WordPress page, a Squarespace site, a school's intranet. Paste
one tag, get something finished.

**And here is the part that decides the design.** If an iframe embed were just
the player in a box, the JS embed would strictly dominate it and the iframe
would only exist for people who cannot paste JavaScript. That is a thin reason
to maintain a second surface.

The iframe earns its place because it is **a page, not a player**. It carries
the things the customer would otherwise have to build: the now/next strip, the
schedule, the playlist of past episodes, the session agenda, the speaker list,
the sign-up form. That is real work we do once and they never do at all.

Two smaller reasons that still matter: guaranteed style isolation (their reset
cannot reach our markup, and our CSS cannot reach theirs), and a clean story for
sites with a strict CSP that will not run third-party script.

### What each method costs the customer

| | JS | iframe |
|---|---|---|
| Control over markup and skin | total, including headless | theme tokens and module choice |
| Participates in host layout | yes | fixed box, height negotiated |
| Host page analytics | direct | via postMessage |
| Content is indexable as the host's | yes | **no** |
| Works with a strict CSP | sometimes | yes |
| Needs a developer | yes | no |

The SEO row is the one to be honest about up front. An iframe's content belongs
to the iframe's origin. A customer whose reason for the page is search traffic
needs the JS embed, or a page hosted on their own domain, and should be told so
before they build a season around it.

---

## 3. The Page

```
  Page {
    id, slug
    binding      what content: a station, a channel, an event, a VOD asset,
                 or a collection of them
    template     the composition preset (section 5)
    modules[]    ordered, each with its own config and slot
    theme        the player's token set, extended for page-level surfaces
    policy       resolved from the workflow chain (section 10A of the
                 presentation framework)
    framings     which of the three routes below are enabled
  }
```

Three framings of the same page:

```
  /p/<slug>          public. Indexable, has JSON-LD, has a site chrome option.
  /embed/<id>        iframe. No site chrome, height negotiated, postMessage API.
  /share/<token>     tokenised. Expiry, PIN, watermark, view cap, and a policy
                     that may add review actions.
```

The framing decides **chrome and access**. The template and modules decide
**content**. The policy decides **actions**. Keeping those three separate is
what stops "the review page" from becoming a fourth codebase.

A share link is therefore a Page with the `review` template and a token
framing. Everything built in section 10 of the presentation framework is a page
template, not a separate product.

---

## 4. Module catalogue

Modules are ours, not customer-authored. Same argument as skins in section 5 of
the presentation framework: a module vocabulary can be reviewed, tested,
themed, and made responsive once. Arbitrary customer HTML cannot.

| Module | Shows | Good for |
|---|---|---|
| `player` | the player, at its configured skin and ratio | every page |
| `nowNext` | current and next programme, from the EPG | channel, station |
| `schedule` | a day or week guide, with jump-to-live | channel |
| `playlist` | related VOD, past episodes, clips | channel, station, event replay |
| `sessions` | an agenda: time, title, speakers, room | conference, multi-session event |
| `lineup` | who is on: talkers, panellists, performers | session, show, gig |
| `fixtures` | other matches in the same competition | sport |
| `trackHistory` | recently played, from ICY metadata | station |
| `form` | registration, question submission, vote, sign-up | event, session |
| `richText` | a description, sponsor message, rules | any |
| `sponsor` | a companion slot (the ad seam, section 9) | any |
| `downloads` | files the policy and link allow | share, review |
| `reviewRail` | QC findings, notes, decision controls | review |
| `shareRow` | copy link, social | public pages |

Deferred on purpose: live chat and Q&A threads. Both need realtime
infrastructure and moderation, and moderation is a product, not a feature. The
`form` module covers "submit a question" without any of that, which is what
most events actually need.

**Modules read, they do not write**, with one exception. `form` and `reviewRail`
are the only modules that accept input, and both go through the policy layer.
Everything else is a projection of content we already hold, which is what keeps
a page cheap to serve and safe to cache.

---

## 5. Templates: composition presets

A template is an ordered set of modules with a layout, not a new codebase.

| Template | Modules | For |
|---|---|---|
| `solo` | player | an iframe that wants only the player |
| `channel` | player, nowNext, schedule, playlist | a 24x7 channel |
| `station` | player (audio), trackHistory, schedule, richText | radio |
| `event` | player, countdown/promo, richText, form, sponsor | one live event |
| `session` | player, sessions, lineup, form | a conference or multi-session day |
| `fixture` | player, fixtures, richText, sponsor | sport |
| `review` | player, reviewRail, downloads | approval before air |

Seven, and five of them are the same three modules rearranged. That is the
point: the cost is in the modules, and templates are nearly free once modules
exist.

A customer picks a template, then adds, removes and reorders modules. They never
start from an empty canvas, because an empty canvas is how a page-builder
project spends six months producing worse pages than the presets would have.

---

## 6. Setting them up and managing them

**Where.** A page belongs to the thing it is about, so it is a tab on the
channel, event or station, exactly as the player config is
(section 12.1 of the presentation framework). The account settings hold the
theme library and the page defaults.

**The flow.** Pick a template, which is pre-filled from the binding. Reorder or
toggle modules. Set the theme, or inherit the account's. Preview at all three
framings side by side, because a page that looks right at `/p/` and breaks at
600px in an iframe is the normal failure. Publish, which enables the framings
and mints the embed snippet.

**Versioning.** A page is an edited artefact that other people have embedded,
so it needs the same treatment as anything else in this repo: the existing
`patchEntity` optimistic concurrency and `audit_log` diffs apply unchanged. An
embed points at a page id and always gets the current version, which is the
behaviour customers expect and the reason to keep the page small and reviewable.

**Duplication is the real management feature.** A broadcaster with forty
fixtures a season wants one page design applied to all of them, not forty pages.
So: a page can be bound to a **collection** rather than one item, and rendered
per item from the binding. One `fixture` page, forty URLs, one thing to edit.
This is the single most valuable thing in this document and it is easy to miss,
because with one test event it looks like a needless abstraction.

---

## 7. Iframe mechanics: the five things that go wrong

These are cheap to design in and expensive to retrofit.

**1. An iframe has no automatic height.** The host sets a box and the content
either scrolls inside it or gets clipped. A player-only embed can be handled
with a CSS aspect ratio, but the moment there is a schedule under the player the
height is content-dependent. So the page measures itself and posts its height to
the parent, and we ship a three-line snippet that listens. Without this, every
composed embed is either clipped or has a permanent scrollbar.

**2. `allow` attributes are not optional.** Without
`allow="autoplay; fullscreen; picture-in-picture; encrypted-media"` the
fullscreen button silently does nothing and autoplay is refused, with no error
anybody can see. This belongs in the generated snippet, not in the
documentation's fine print.

**3. The origin check works differently.** For a JS embed the request carries
the host page's `Origin`. An iframe document request carries the parent as
`Referer` and nothing more reliable, and inside the frame `document.referrer`
can be empty under a strict referrer policy. So the embed framing verifies the
parent origin through the postMessage handshake as well as the request headers,
and a page whose parent will not identify itself is served in a degraded mode
rather than refused, because refusing produces a blank rectangle the customer
cannot debug.

**4. Third-party cookies are gone.** The iframe cannot rely on any session. Its
identity is the page id plus the publishable key in the URL, and for a share
framing, the token. This is already how the share page works, so it is a
constraint we have met before rather than a new one.

**5. Deep links out of a frame.** "Watch the replay" or a session link inside an
iframe must open in the top window, not inside a 400px box. Every outbound link
gets `target="_top"` by default, with `_blank` as the configured alternative.

---

## 8. The postMessage contract

This is what keeps the iframe from being a dead end. The host page can listen
and command, using the **same event names as the JS SDK**, so a customer who
starts with an iframe and later moves to JS does not rewrite their analytics.

```
  iframe -> host
    volt:ready      { pageId, height }
    volt:height     { height }              on every content change
    volt:event      { event, at, detail }   the player's own event stream
    volt:action     { id, ... }             a module action (form submitted,
                                            session clicked)

  host -> iframe
    volt:command    { command: 'play' | 'pause' | 'mute' | 'seek', ... }
    volt:theme      { tokens }              live theme change, for a preview
```

Every message carries the page id, and the frame ignores anything whose origin
is not the parent it handshook with.

---

## 9. Theme: pages extend the player's tokens

A page does not get its own theming system. It reuses the player's token set
(`--vp-primary`, `--vp-surface`, computed `--vp-ink`, radius, density, font) and
adds a small number of page-level ones: page background, module card surface,
divider, and maximum content width.

The computed-ink discipline carries over exactly. A module's text colour is
derived from the surface it sits on, and where a module sits over an image, the
scrim rule from section 5.0 applies rather than a configurable text colour.

One consequence worth stating: **a page and the player inside it cannot
disagree**, because they read the same variables from the same place. That is
worth more than it sounds. The usual failure of a portal builder is a page whose
header is on-brand and whose player is not.

---

## 10. What this becomes, and what we must not build yet

The Page object, the module catalogue and the template presets are a portal app
builder in everything but ambition. What separates them from the version that
eats a year:

**Do now:** one Page object, three framings, the module catalogue as a fixed
vocabulary, seven templates, module reorder and toggle, theme inheritance,
collection binding.

**Do next, with evidence:** more modules, driven by what customers ask for
twice. A page-level analytics view. Saved page templates per account.

**Do not do:** a free-form canvas, arbitrary HTML or script in a module, a
per-customer component library, a visual drag-and-drop grid editor. Each of
those turns a shippable feature into a platform project, and the first one also
puts third-party script next to a playback token.

The test for anything proposed later: can it be reviewed, tested and themed once
by us? If yes it can be a module. If it needs the customer to write code, it
belongs in the JS SDK, where they already have more power than a builder would
give them.

---

## 11. Launch cut

1. **`EMBEDDING.md` and the generated snippets.** Both methods, real code, the
   `allow` attributes, the height listener. Documentation is the feature here:
   an embed nobody can paste correctly is not shipped.
2. **The JS path first**, since it already exists. Publish the SDK surface,
   headless mode, and the event names.
3. **`/embed/<id>` with the `solo` template**, plus the height and handshake
   protocol. This is the smallest thing that proves the framing.
4. **Modules `nowNext`, `schedule`, `playlist`.** The three that make an iframe
   worth choosing over a JS player.
5. **Templates `channel`, `station`, `event`.**
6. **The page editor as a tab**, with the three-framing preview.
7. **Collection binding**, so one design serves a season.

Deferred: `sessions`, `lineup`, `fixtures`, `form`, `sponsor`, chat and Q&A,
saved account templates.
