# Embedding the Volt player

Two ways to put Volt content on your own site. Both are supported, both are
first class, and they are for different people.

- **[JavaScript embed](#javascript-embed)** — one script tag, mounts into your
  own page. Full control of the skin, the controls, and the data. Choose this if
  you have a developer.
- **[iframe embed](#iframe-embed)** — one tag, gives you a finished page with a
  player and whatever modules you configured (schedule, playlist, sessions, a
  form). Choose this if you do not.

If you are not sure, use the JavaScript embed. It does everything the iframe
does and more, and it is the one that lets your page own its own layout.

**One thing to decide before you build a season around either.** Content inside
an iframe belongs to the iframe, not to your page, so it will not appear in your
site's search results. If search traffic is the reason the page exists, use the
JavaScript embed.

---

## JavaScript embed

### The whole thing

```html
<div data-volt-player
     data-app-key="pk_live_xxxxxxxxxxxx"
     data-channel-id="00000000-0000-0000-0000-000000000000"></div>

<script src="https://your-volt-host/player/volt-player.js"></script>
```

One `<div>` and one `<script>`. No build step, no module loader, no second
request for a player library, and no JavaScript for you to write. The script
takes the control plane's address from the origin it was served from, so there
is nothing else to configure.

The key is a **publishable** key (`pk_live_…`). It is meant to be public, it
only works on the domains you allow-list against the app it belongs to, and it
cannot be used to change anything.

### Attributes

| Attribute | Values | |
|---|---|---|
| `data-app-key` | `pk_live_…` | **required** |
| `data-channel-id` | uuid | **required** |
| `data-layout` | `card` `bar` `hero` `stage` | `stage` for video, `card` for audio |
| `data-primary-color` | `#rrggbb` | your brand. Controls, badges, focus rings |
| `data-secondary-color` | `#rrggbb` | the surface behind panels |
| `data-aspect` | `16:9` `4:3` `1:1` `21:9` `9:16` `auto` | reserves the box |
| `data-countdown` | `digits` `relative` `datetime` `none` | before an event starts |
| `data-scrim` | `light` `medium` `heavy` | legibility of controls over the picture |
| `data-density` | `comfortable` `compact` | spacing and control size |
| `data-logo-url` | url | your bug, top corner of a video stage |
| `data-logo-position` | `top-left` `top-right` | |
| `data-poster-url` | url | shown until the first frame paints |
| `data-autoplay` | `true` | browsers block this unless muted; see below |
| `data-preferred` | `auto` `mp3` `hls` `dash` | delivery preference |
| `data-options` | JSON | anything above, plus anything newer, as one attribute |

Text colour is not on that list, and will not be. Over a moving picture there is
no background to measure against, so the player computes readable ink from the
surface colour you give it and constructs contrast with a scrim. That is why a
pale brand colour gets dark glyphs without you choosing them, and why your
player cannot be made unreadable by a setting.

### More than one player on a page

Works without ceremony. Every `[data-volt-player]` on the page is mounted once.
If your page injects markup later, in a tab or a modal or an infinite scroll,
call `VoltPlayer.scan()` and the new ones mount. Existing players are never
mounted twice, so calling it repeatedly is safe.

```html
<script>
  document.querySelector('#tab-2').addEventListener('shown', () => {
    window.VoltPlayer.scan();
  });
</script>
```

### The API

For anything the attributes do not cover, create players yourself.

```html
<script src="https://your-volt-host/player/volt-player.js"></script>
<script>
  const player = await window.VoltPlayer.create({
    el: '#stage',
    appKey: 'pk_live_xxxxxxxxxxxx',
    channelId: '0000…',
    preferred: 'auto',
    config: {
      layout: 'stage',
      primaryColor: '#0b2545',
      secondaryColor: '#f6f3ee',
      options: { aspect: '16:9', countdown: 'digits', scrim: 'medium' },
    },
    onEvent: (e) => {
      // Every reportable event, before it is batched and sent to us.
      if (e.event === 'play') myAnalytics.track('video_play');
    },
  });

  player.play();
  player.pause();
  await player.destroy();
</script>
```

### Events

The same names arrive through `onEvent`, through the iframe's `postMessage`, and
in your Volt reports, so you only learn them once.

| Event | Means |
|---|---|
| `player.load` | the bundle initialised |
| `player.render` | it mounted into the page |
| `player.view` | it was actually on screen: half the box, for a second |
| `player.ready` | a source was selected and attached |
| `manifest.ok` / `manifest.error` | the manifest parsed, or did not |
| `play` `pause` `stop` | playback |
| `stall` `recover` | buffering |
| `error` | with a `stage` telling you where it failed |

`player.render` and `player.view` are different numbers on purpose. Render is
"it mounted", view is "somebody could have seen it". The second is the one to
divide your plays by.

### Autoplay

Browsers block sound that starts by itself, and there is nothing a player can do
about that. If you set `data-autoplay="true"` and the browser refuses, the
player reports `error` with `stage: 'autoplay-blocked'` and waits for a click,
which is the correct behaviour rather than a fault. If you need something to
start on its own, start it muted and let the viewer unmute.

### Building your own player: headless mode

If you want your own markup entirely, take the data and the commands and render
whatever you like. You still get transport, source selection with fallback,
error handling, reconnection, event states and reporting.

```js
const player = await window.VoltPlayer.create({
  el: '#anything',
  appKey: 'pk_live_…',
  channelId: '0000…',
  render: false,
  onState: (s) => {
    // s.playing, s.loading, s.error
    // s.presentation: pre | live | ended | replay | offline | postponed | cancelled
    // s.msToStart, s.event, s.nowPlaying
    myUI.update(s);
  },
});
```

For video, put the picture where you want it. The element is yours to position
and size, and nothing else about it is yours to touch:

```js
const el = player.mediaElement;   // null for audio, which needs no placing
if (el) document.querySelector('#my-stage').appendChild(el);
```

This is the answer to "we need a completely custom player". It gives you more
control than any visual builder could, and you never inherit our markup.

---

## iframe embed

### The whole thing

```html
<iframe
  src="https://your-volt-host/embed/PAGE_ID"
  title="Coastal Cup Final"
  style="width:100%;aspect-ratio:16/9;border:0"
  allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
  referrerpolicy="strict-origin-when-cross-origin"
  loading="lazy"></iframe>
```

**Keep the `allow` attribute.** Without it the fullscreen button does nothing
and autoplay is refused, with no error message anywhere. This is the single most
common reason an embed "does not work".

### If your page has modules under the player

`aspect-ratio` is only right for a player on its own. As soon as the page also
has a schedule or a playlist, its height depends on its content, and an iframe
has no way to size itself. The page tells you how tall it is; add this once,
anywhere on your page:

```html
<script>
  window.addEventListener('message', (e) => {
    if (e.origin !== 'https://your-volt-host') return;
    const d = e.data;
    if (d && d.type === 'volt:height' && d.pageId) {
      const f = document.querySelector(`iframe[data-volt-page="${d.pageId}"]`);
      if (f) f.style.height = d.height + 'px';
    }
  });
</script>
```

and put `data-volt-page="PAGE_ID"` on the iframe, with `height:auto` instead of
`aspect-ratio`.

### Talking to the embed

Same event names as the JavaScript embed, so moving between the two later costs
you nothing.

```js
// listen
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://your-volt-host') return;
  if (e.data?.type === 'volt:event') myAnalytics.track(e.data.event);
});

// command
frame.contentWindow.postMessage(
  { type: 'volt:command', command: 'pause' },
  'https://your-volt-host'
);
```

Always check `e.origin`. Never use `'*'` as the target origin.

### Links out of the frame

Anything the viewer clicks that leaves the page, a replay, a session, a
schedule item, opens in the top window rather than inside the frame. If you want
a new tab instead, set that on the page in the Volt console.

---

## Allowed domains

A publishable key works only on the domains listed against its app. Add yours in
**API Keys & Apps** before you paste the snippet, including any staging domain.

The commonest failure with a key-gated embed is pasting it onto a domain nobody
added, so the player will tell you exactly that rather than showing a generic
error:

> This site is not on the app's allowed origins. Add its domain in API Keys &
> Apps.

For an iframe the domain we check is the **page containing the iframe**, not the
iframe's own address.

---

## When something is wrong

The player reports its own faults, so before reading any code, open the player's
report in the Volt console. It answers the question that is otherwise very hard
to answer from the outside: whether the embed loaded at all, on which domain,
and what it failed on.

| What you see | Usually |
|---|---|
| Nothing renders | the script tag is above the div, or the div is missing `data-app-key` |
| "This site is not on the app's allowed origins" | the domain is not allow-listed |
| "This player key is not valid" | a secret key (`sk_live_…`) was pasted instead of `pk_live_…` |
| Fullscreen button does nothing | the iframe is missing `allow="fullscreen"` |
| The embed is clipped or scrolls | height listener not installed, see above |
| Plays on one of your sites and not another | check the report's origin column first |
