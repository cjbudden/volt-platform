---
title: iOS requirements
sidebar_label: iOS requirements
description: Everything an iPhone or iPad app needs before it uses the Volt player SDK, in one checklist.
---

# iOS requirements

A checklist for the app team. Each line is something the [Player SDK for iOS](./player-sdk-ios.md) needs, or something an App Store review will ask about.

## Tools and versions

| Requirement | Detail |
|---|---|
| Xcode | 16 or later |
| Minimum iOS | iOS 15 and iPadOS 15 |
| Minimum tvOS | tvOS 15 (Apple TV HD and Apple TV 4K) |
| Language | Swift. The package is a Swift package. An Objective-C app can use it from a Swift view |
| Install | Swift Package Manager: the **VoltPlayer** library |
| Dependencies | None: Apple frameworks only (AVFoundation, AVKit, SwiftUI, MediaPlayer) |

## In Volt

| Requirement | Where |
|---|---|
| An app of type **iOS** (Apple TV apps use one too) | API Keys & Apps > New app |
| A publishable key for that app | The app's page > Create key. Only the publishable key goes in the app. Never put a secret key in an app |
| The ids of what the app plays | Each channel, event, station or title's page in Volt |
| A saved Player setup (optional) | Radio stations today. The app uses the station's theme automatically |

## In the app's Xcode project

| Requirement | Why |
|---|---|
| **Background Modes > Audio, AirPlay, and Picture in Picture** | Radio keeps playing with the screen locked, and picture in picture works |
| HTTPS addresses for Volt and the CDN | iOS blocks plain http by default (App Transport Security). A local test server on http needs an exception in the test build only |
| A purchase flow, when events or titles are paid | Apple requires in-app purchase for digital content sold in an app. The player hands Buy to the app (`.purchase`), and the app calls `setViewerToken` afterwards |
| Sign in, when titles are for members | The player hands Sign in to the app (`.signin`). The app signs the viewer in to Volt and calls `setViewerToken` |

## Content

| Requirement | Detail |
|---|---|
| HLS for video | Apple devices don't play DASH. Every Volt channel, event and title has HLS, so nothing extra is needed |
| Wall clock in the stream | Volt streams carry `PROGRAM-DATE-TIME`. Start over, the programme on air and Up next timing depend on it |
| Subtitles | WebVTT tracks in the HLS stream. They appear in the subtitles menu automatically |

## DRM (only for protected content)

| Requirement | Detail |
|---|---|
| FairPlay Streaming | Your DRM provider's FairPlay certificate address and licence server address, set in `fairPlay` |
| Licence request headers | The entitlement token or authorisation header your licence server needs, in `fairPlay.headers` |
| Testing | FairPlay plays only on a real device, not in the Simulator |

## Privacy and App Store

| Requirement | Detail |
|---|---|
| Privacy manifest: data collected | The player reports viewing (start, watched seconds, end, bitrate) to Volt Analytics with a random session id. It sends no advertising identifier and no personal data unless the app passes a viewer token |
| App Tracking Transparency | Not needed by the player itself. If your ad server needs the advertising identifier, the app must ask for permission |
| Kids apps | Turn off targeting on the ad server for kids titles; the player sends nothing extra |

## On Apple TV

| Requirement | Detail |
|---|---|
| Purchases | Buy comes to the app as a `purchase` event: use in-app purchase (StoreKit), then `setViewerToken` |
| Sign in | Sign in comes to the app as a `signin` event: show a code on screen and confirm it on a phone, then `setViewerToken` |
| Trick-play | Turn on **Trick-play for Apple and smart-TV players** in the output profile so scrubbing shows pictures |
| Not on Apple TV | AirPlay sending, picture in picture, Chromecast, Add to calendar |

## Not available yet

- Chromecast from the app (needs the Google Cast SDK; planned)
- The "Ad 1 of 2" label and Learn more on guided ads
- Device-level testing of the whole SDK: version 0.1 is a preview
