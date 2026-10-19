---
title: Key concepts
sidebar_position: 1
description: The building blocks of Volt and how they fit together.
---

# Key concepts

This page explains the words you will see throughout Volt and how the pieces fit together.

## Your account

Everything you create in Volt belongs to your **account**: channels, events, stations, recordings, media, users and apps. Nobody outside your account can see any of it, and every API credential you are given works only on your own account.

Channels and stations are organised into **groups**. A group sets how many channels and stations it can hold, and the kind of processing they use.

## Streams: channels, events and radio stations

| Kind | Use it for | Typical life |
|---|---|---|
| **Channel** | A TV channel, usually running around the clock | Started once, runs for weeks or months |
| **Event** | A match, concert, conference or other one-off | Scheduled, runs for hours, then becomes a replay |
| **Radio station** | Audio-only programming | Runs around the clock, with now-playing metadata |

Each stream has a **source** (where the signal comes from) and **outputs** (what your audience receives).

## Sources and inputs

A **source** is the live signal you send to Volt, for example an SRT, RTMP or HLS feed. A channel can have a **primary source** and an optional **backup source**. If the primary fails, Volt can switch to the backup automatically, then back again when the primary recovers. See [failover](../guides/failover.md).

A channel processes its source in one of two ways:

| Type | You send | Volt does |
|---|---|---|
| **Transcode** | One high-quality source | Builds the full set of output sizes and bitrates (the ladder) for you |
| **Packaging** | A ladder you have already encoded | Packages it as it is, without re-encoding |

## Outputs and going on air

When a channel is started, Volt produces **outputs** in HLS and DASH (and MP3 for radio). At first the output is **private**: you can watch it in the console, but the public URL is closed. When you are happy with it, you **go on air**, which opens the public URL. Taking a channel off air closes the public URL again without stopping the encoder.

## Recordings, clips and on-demand

What a stream sends out is recorded. From a **recording** you can find a moment (by time, or by programme), cut a **clip** and publish it as an **on-demand (VOD) asset**. Programmes in the guide can also be converted to on-demand assets automatically once they have aired.

## The programme guide (EPG)

Each channel, event and station can have a **programme guide**: what is on, and when. The guide drives the now and next information in the player, can restrict where a programme can be watched, can replace the live feed for a slot, and can turn each programme into an on-demand asset. See [the programme guide](../guides/epg.md).

## Apps and keys

An **app** represents a website or application that plays your content. Each app has a **publishable key** (`pk_live_...`) that is safe to put in a web page, and a list of the domains allowed to use it. Your own servers use an **account secret key** (`sk_live_...`), which must never be put in an app. See [authentication](../api/authentication.md).

## Users and roles

People who work in the console are **admin users**. What each person can see and do is decided by their **roles**. People who watch your content through your apps are **public users** (viewers): they never see the console. See [roles and access](roles-and-access.md).
