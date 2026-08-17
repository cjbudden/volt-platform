# VOLT Failover and Failback

This document confirms how source failover works in VOLT today, what the construct
we built earlier actually does, where it is wired, and what is not yet built. It is
written to match how you described the feature so we agree on the workflow.

## What failover is

Failover keeps the output live when an input fails. If the primary source stops
arriving, the channel switches to an alternate source so viewers never see a dead
screen. Your description is exactly the design:

1. Primary source is the preferred input and feeds the output normally.
2. If the primary fails and a backup source has been provided, the output switches
   to the backup and stays live.
3. If there is no backup, or the backup is also unavailable or fails, the output
   switches to filler: either a slate image or a short loop.
4. When the primary recovers, the output automatically returns to it (failback),
   after a short stability hold so it does not bounce back onto a still flaky feed.

So the order of precedence is: primary, then backup, then filler (slate or loop).

## The construct that exists (source_selector)

The failover engine is `volt-encoder/bin/source_selector.py`. This is the construct
from the early testing, and it is covered by `test_source_selector.py`. It works like
this.

Every candidate source runs all the time. The primary group and the backup group each
run a lightweight relay per rendition that pulls the feed and writes it to a private
local port. A single filler process (slate or loop) also runs continuously to its own
private ports. On top of these sits one forwarder per rendition. The forwarder copies
whichever group is currently active onto the bus that the packager (Shaka) reads.

Switching sources is just repointing the forwarders from one group to another. That is
a local operation between processes on the same machine, so the switch is sub second,
and because there is only ever one timeline through the packager, the segment numbering
stays continuous no matter which source is live. In other words, the packager is the
single continuity engine and the switch happens upstream of it. A primary to backup
switch is close to seamless when the two feeds are time aligned; a switch to filler may
cost one segment.

## How a failure is detected

Each relay writes an ffmpeg progress stream that we poll. A source counts as alive only
if its playback time is still advancing. A whole group (the full ladder) is considered
alive only when every rendition in it is advancing, so you never end up running one
rendition on primary and another on backup, which would break bitrate alignment.

The raw alive signal is debounced with hysteresis before it is trusted: a source must
look healthy for about three seconds before it is treated as up, and must look dead for
about two seconds before it is treated as down. This stops a momentary network hiccup
from triggering a needless switch.

## How the decision is made

The policy is simple and always favours the best available real source. If the current
source goes down, it immediately moves to the best remaining option in priority order:
primary, then backup, then filler. Filler is never a resting choice while any real
source is up, so the moment a real source returns the output leaves the slate or loop.

## Failback and its value

Failback is the automatic return to the primary once it is healthy again. Its value is
that after an outage you go back to your preferred, highest quality path without anyone
having to intervene, while a hold prevents flapping.

Concretely: when the output is running on backup and the primary comes back, the system
waits until the primary has been continuously healthy for a hold period (about ten
seconds) and then switches back to it. If the primary is still unstable and keeps
dropping, the hold is never satisfied, so you stay safely on backup rather than bouncing
between the two. Failback is governed by an auto failback setting. With auto failback on
you return to primary automatically; with it off you stay on the backup you failed over
to until an operator decides to move, which some broadcasters prefer so a recovered but
unproven primary is not trusted automatically.

## The filler: slate and loop

The filler is what covers the output on total input loss, when neither primary nor
backup is available.

A slate is a still image. At failover it is encoded on the fly into the same ladder as
the live output, matching each rendition's height, bitrate and GOP structure, with
silent audio, so the packager segments it exactly like a live source.

A loop is a short video. It is looped forever and paced to real time, and it is also
scaled to match the ladder. This is the graceful option you described: instead of a
static card, the output shows moving content until a real source returns.

Today the slate image and the loop video are assets that are uploaded and registered
(filler assets, of kind slate or loop) and a channel points its redundancy filler at
one of them. The matching to the output bitrate happens at failover time, because the
filler command scales and re encodes to the current ladder when it runs.

## The idea of generating and storing a loop from the output

You described a nicer version of the loop: once the required bitrate outputs are known,
a short loop is generated automatically and stored, ready to use as the replacement.

That automatic generation is not built yet. Today the loop is an asset you provide, and
it is conformed to the ladder at the moment of failover. The enhancement you have in
mind would, at channel start (or on a schedule), capture a short window of the real
output, which is already at the correct ladder and bitrate, and store it as the loop
filler for that channel. On total loss the output would then replay recent real content
that already matches the outputs exactly, with no on the fly re encode needed. This is a
clean improvement and it fits the existing filler slot directly: it would just populate
the loop asset automatically instead of requiring an upload. I can build this if you
want it.

## Where failover is wired today

The selector currently runs for package only channels that have input failover enabled.
On that path the inputs are already encoded renditions, so the selector relays the
chosen group straight to the bus and the packager wraps it. Failover there is exactly
the forwarder repoint described above.

On transcode channels the selector is not yet wired. A transcode channel has a single
mezzanine input that must be decoded and re encoded into the ladder, so failover needs
the selector to choose the active source and feed that one chosen source into the
transcoder, which is an extra hop that is not built. Right now a transcode channel with
input failover requested simply runs on the primary mezzanine and logs that mezzanine
failover is not wired. This is a wiring gap, not a design gap: the same selector logic
applies, it just needs to feed the transcoder's input rather than the bus directly.

This is what my earlier note meant when it said your Test Channel, which is a transcode
workflow, has no encoder level failover today. It was not saying transcode cannot have
failover; it was saying the selector is not currently attached on that path. Wiring it
is a contained piece of work and I can do it so failover behaves identically on both
workflows.

## The pre-flight failover test

To let you validate failover before going on air, there is now a Pre-flight Failover
test panel on the channel page. On a redundancy enabled package channel it drives the
real selector: it forces a simulated primary loss, or forces slate, loop or backup, and
you watch the real output switch, then you resume normal health driven behaviour. It
does this through a small control file that the running encoder's selector polls, since
until now the control plane only spoke to the encoder at start and stop.

On a transcode or non redundancy channel, where the selector is not attached, the same
buttons drive a labelled on screen preview of each failover state so the sequence can
still be shown to a client. The panel clearly marks which of the two it is doing.

## Configuration summary

Per channel, the relevant settings are the backup source (a second input with the backup
role), whether input failover is enabled, whether auto failback is on, the input loss
behaviour (none, slate, loop, freeze last frame, or black), and which slate image or loop
asset the filler points at. Filler assets are managed separately and referenced by the
channel.

## What I recommend next

Two things would make this fully match your vision. First, wire the selector into the
transcode path so failover works the same on transcode and package channels. Second,
add automatic loop generation from the live output so the loop filler is populated for
you at the correct bitrate rather than uploaded. Say the word and I will build either or
both.
