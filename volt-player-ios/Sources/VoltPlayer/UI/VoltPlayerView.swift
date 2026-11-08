#if os(iOS) || os(tvOS)
// ============================================================================
//  THE VIEW: the picture, and the skin over it.
//
//      VoltPlayerView(player: player)                     the skin the player names
//      VoltPlayerView(player: player) { ctx in MySkin(ctx) }   a custom skin
//
//  A skin is any SwiftUI view built from a SkinContext: the state, the
//  commands, the theme and the translator. It never sees the AVPlayer. The
//  picture is a separate layer the skin places with ctx.picture.
// ============================================================================
import AVFoundation
import AVKit
import SwiftUI
import VoltPlayerCore

/// What a skin is handed. The same parts as the web SDK's SkinContext.
@MainActor
public struct SkinContext {
    public let state: PlayerState
    public let commands: VoltCommands
    public let theme: ResolvedTheme
    public let t: Translator
    /// The picture. Place it; never look inside it.
    public let picture: AnyView
    /// The player's options (watermark, brand mark), for skins that draw them.
    public let watermark: String?
    /// The player itself, for built-in skins that host a system player (tv). Custom skins use commands.
    let host: VoltPlayer?
    /// Demo mode: a state to draw, no stream.
    public var isDemo: Bool { host?.options.demo != nil }
}

/// Built-in and registered skins by name.
@MainActor
public enum VoltSkins {
    public typealias Factory = (SkinContext) -> AnyView
    private static var registry: [String: Factory] = [:]

    /// Register a skin so `options.skin = "acme"` (or a saved setup) uses it.
    public static func register(_ id: String, _ factory: @escaping Factory) { registry[id] = factory }

    static func make(_ id: String, _ ctx: SkinContext) -> AnyView {
        if let f = registry[id] { return f(ctx) }
        #if os(tvOS)
        // On Apple TV every built-in name has a ten-foot layout: the touch skins have no use there.
        switch id {
        case "event": return AnyView(EventSkin(ctx: ctx))
        case "audio_square", "audio_nowplaying", "audio_wave", "audio_radio": return AnyView(TVAudioSkin(ctx: ctx))
        // "tv", "video" and any unknown name: the tv skin.
        default: return AnyView(TVSkin(ctx: ctx))
        }
        #else
        switch id {
        case "event": return AnyView(EventSkin(ctx: ctx))
        case "audio_square": return AnyView(AudioSquareSkin(ctx: ctx))
        case "audio_nowplaying", "audio_wave": return AnyView(AudioNowPlayingSkin(ctx: ctx))
        case "audio_radio": return AnyView(AudioRadioSkin(ctx: ctx))
        // An unknown name plays in the video skin rather than a blank box. "tv" is meant for
        // Apple TV; on a phone or tablet it is the video skin.
        default: return AnyView(VideoSkin(ctx: ctx))
        }
        #endif
    }
}

public struct VoltPlayerView: View {
    @ObservedObject var player: VoltPlayer
    let custom: ((SkinContext) -> AnyView)?
    @State private var fullscreen = false

    public init(player: VoltPlayer) { self.player = player; self.custom = nil }
    public init<V: View>(player: VoltPlayer, @ViewBuilder skin: @escaping (SkinContext) -> V) {
        self.player = player; self.custom = { AnyView(skin($0)) }
    }

    func context() -> SkinContext {
        SkinContext(state: player.state, commands: player, theme: player.theme, t: player.t,
                    picture: AnyView(PlayerLayerView(player: player)), watermark: player.options.watermark, host: player)
    }

    var skin: AnyView {
        let ctx = context()
        return custom?(ctx) ?? VoltSkins.make(player.skinId, ctx)
    }

    public var body: some View {
        #if os(tvOS)
        // A TV is always full screen: no cover to present.
        skin
            .environment(\.voltStyle, VoltStyle(theme: player.theme))
            .environment(\.voltT, player.t)
            .environment(\.voltBase, player.options.apiBase)
        #else
        skin
            .environment(\.voltStyle, VoltStyle(theme: player.theme))
            .environment(\.voltT, player.t)
            .environment(\.voltBase, player.options.apiBase)
            .onChange(of: player.state.fullscreen) { fullscreen = $0 }
            .fullScreenCover(isPresented: $fullscreen, onDismiss: { if player.state.fullscreen { player.toggleFullscreen() } }) {
                skin
                    .environment(\.voltStyle, VoltStyle(theme: player.theme))
                    .environment(\.voltT, player.t)
                    .environment(\.voltBase, player.options.apiBase)
                    .background(Color.black.ignoresSafeArea())
                    .statusBarHidden()
            }
        #endif
    }
}

/// The AVPlayerLayer, in a UIView, handed to the player for picture in picture.
struct PlayerLayerView: UIViewRepresentable {
    let player: VoltPlayer

    final class LayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> LayerView {
        let v = LayerView()
        v.backgroundColor = .black
        v.playerLayer.player = player.avPlayer
        v.playerLayer.videoGravity = .resizeAspect
        player.attachLayer(v.playerLayer)
        return v
    }

    func updateUIView(_ v: LayerView, context: Context) {
        // Only the most recently attached layer shows the picture. When the full-screen
        // copy closes, the inline view takes the picture (and picture in picture) back.
        if player.playerLayer !== v.playerLayer && v.window != nil {
            v.playerLayer.player = nil
            v.playerLayer.player = player.avPlayer
            player.attachLayer(v.playerLayer)
        } else if v.playerLayer.player !== player.avPlayer {
            v.playerLayer.player = player.avPlayer
        }
    }

    static func dismantleUIView(_ v: LayerView, coordinator: ()) {
        v.playerLayer.player = nil
    }
}
#endif
