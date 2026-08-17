# VOLT Playout and Source Replacement

This captures the direction you have described so we are aligned before building. It
is about one core capability: keeping the viewer's playback alive and seamless by
replacing the live source with other content in the delivered manifest, for both HLS
and DASH, without the viewer's player ever stopping or needing a refresh. Failover is
the first use of it. The same engine then does deliberate manual switching, then
rule driven replacement by geo and access, and ultimately whole channels built from
VOD playlists with an automatic EPG, delivered as live.

## The goal in your words

Keep the stream from faltering from the viewer's point of view. Fall back and fill a
live stream with a looping VOD asset. Do it without running an encoder the whole time,
to reduce running cost while still giving a solid experience. Make it easy and
automatic for both HLS and DASH. Then expand the same playout method to dynamic
replacement of the live feed based on access rules and geo location, where the trigger
differs but the playout is the same: a looping VOD replaces the live source. Then reach
the point where a whole live channel is built from VOD assets: a playlist plus an
automatically generated EPG that matches it, delivered to the audience as a live HLS
and DASH stream, with the encoder only ever producing the required bitrate renditions
for the ladder rather than running continuously.

You proved the concept already with HLS manifest manipulation. It mostly worked but was
HLS only and needed some fiddly manual steps. The goal now is to make it robust,
automatic, and identical across HLS and DASH.

## Two ways to replace a source, and why manifest level is the strategic one

There are two mechanisms, and the current build uses the first while your vision needs
the second.

Encoder level, which is what exists today. The source selector switches which input
feeds the packager, upstream of one continuous timeline. It is real and correct for
input failover, but it requires the encoder and packager to run continuously, including
while showing filler, and it does not by itself give you manifest driven replacement or
the cost saving of not encoding filler.

Manifest level playout, which is what you want. The looping VOD asset is packaged once
to the channel's ladder and segment format, then stored. Delivery is a manifest that
points at the live segments while live, and at the loop's segments when replacing, with
a clean discontinuity between them. The viewer's player follows the same manifest URL
the whole time, so new segments simply appear and playback continues with no stall and
no refresh. Because the loop is pre packaged, no encoder needs to run to show it, which
is the cost saving. And because the decision is just which segments the manifest points
at, the same engine serves failover, manual switching, and geo or access replacement.

So manifest level playout is the unifying primitive. Failover is one trigger for it.

## What changes in the panel

The separate simulation window goes away. When you force a path, or switch on purpose,
the change happens in the real delivered manifest and you watch it in the OUTPUT player,
seamlessly. The status reflects what is actually being broadcast and records the reason:
failover, manual switch, test, or a geo or access rule. Same control, honest result.

## The unifying model

A playout decision for a channel answers one question continuously: what should the
delivered manifest point at right now. Inputs to that decision:

  * source health, for automatic failover
  * an operator override, for manual switch and for pre on air testing
  * access and geo rules, for dynamic replacement
  * a schedule or playlist, for VOD built channels

The output of the decision is always the same shape: point the manifest at the live
source, or at a named looping VOD asset, with a discontinuity at the join and program
date time kept continuous so HLS and DASH players stay seamless. Every change is logged
with its reason and surfaced in the status and the output preview.

## Phased plan

Phase 1, seamless manifest level fallback and switch. Package the filler loop (an
uploaded loop, or the motion slate loop) once to the channel ladder and segment format.
Build the delivered HLS and DASH manifests so they can splice between live and the loop
with a discontinuity, keeping PDT continuous. Drive it from the panel as both a pre on
air test and a live manual switch, with the result shown in the OUTPUT player and the
status showing what is broadcast and why. Success is proven when the output switches to
the loop and back with no viewer refresh and no stall, on both HLS and DASH.

Phase 2, rule driven dynamic replacement. Feed access and geo rules into the same
playout decision, so a viewer in a blacked out region is served the loop while others
get live, using the identical splice engine. Different trigger, same playout.

Phase 3, VOD playlist channels. Compose a channel from a playlist of VOD assets, each
pre encoded to the ladder, looped and sequenced by the playout engine, with an EPG
generated automatically to match the playlist, delivered as a live HLS and DASH stream.
The encoder only produces ladder renditions of assets as needed, never runs
continuously for delivery.

## Why this is worth it

Most playout platforms offer only a fallback to another live source. Seamless manifest
level replacement with looping VOD, unified across failover, manual control, and geo or
access rules, and extended to fully VOD built live channels, is a distinctive capability
and a real cost and resilience advantage. It is the core of a service that does not
falter for the viewer.

## Open decisions for Phase 1

  * Start with HLS and DASH together, or prove HLS first then add DASH.
  * Filler for Phase 1: use the motion slate loop we already build, or require an
    uploaded loop asset, or support both from the start.
  * Where the splice is performed: extend the companion manifest writer we already have
    (it already manipulates the Shaka manifest for captions), or a dedicated playout
    manifest service. My recommendation is to extend the companion writer first, since
    it already owns manifest rewriting, then factor it into its own service in Phase 3.
