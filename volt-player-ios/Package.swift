// swift-tools-version:5.9
// ============================================================================
//  VOLT PLAYER SDK FOR iOS, iPadOS AND tvOS.
//
//  Two targets, split on purpose:
//
//    VoltPlayerCore   Pure Swift (Foundation only). The contract (state,
//                     commands, theme tokens), the player's arithmetic (guide,
//                     up next, start over, qualities, playlists), in-stream
//                     triggers, the control plane client and the beacons.
//                     Ported line for line from the web SDK
//                     (volt-player/src/sdk), and tested on any machine with a
//                     Swift toolchain, Linux included.
//
//    VoltPlayer       The Apple half: AVPlayer engine, AirPlay, picture in
//                     picture, lock screen, FairPlay, and the SwiftUI skins.
//                     Only compiles where AVFoundation and SwiftUI exist.
//
//  An app adds the package and imports VoltPlayer (which re-exports the core).
// ============================================================================
import PackageDescription

let package = Package(
    name: "VoltPlayer",
    platforms: [.iOS(.v15), .tvOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "VoltPlayer", targets: ["VoltPlayer"]),
        .library(name: "VoltPlayerCore", targets: ["VoltPlayerCore"]),
    ],
    targets: [
        .target(name: "VoltPlayerCore"),
        .target(name: "VoltPlayer", dependencies: ["VoltPlayerCore"]),
        .testTarget(name: "VoltPlayerCoreTests", dependencies: ["VoltPlayerCore"]),
    ]
)
