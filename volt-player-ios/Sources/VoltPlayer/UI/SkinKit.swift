#if os(iOS) || os(tvOS)
// ============================================================================
//  THE SKIN KIT: the parts every built-in skin is made of, and what a custom
//  skin should use so it follows the console's theme for free.
//
//  The SwiftUI counterpart of volt-player/src/sdk/skins/kit.ts. Colours,
//  corners and fonts come only from the ResolvedTheme in the environment
//  (VoltTheme), never from literals, so a theme saved in Player setup
//  restyles every skin on every platform the same way.
// ============================================================================
import AVKit
import SwiftUI
import VoltPlayerCore

// MARK: - Platform

/// Sizes for ten-foot viewing: everything a built-in skin draws is this much larger on a TV.
#if os(tvOS)
public let voltUIScale: CGFloat = 1.8
#else
public let voltUIScale: CGFloat = 1
#endif

#if os(tvOS)
/// The focus look on Apple TV: the theme's focus colour as a ring, a slight lift. Used by every
/// built-in button so focus is always visible and always in the account's colours.
public struct VoltTVButtonStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View { FocusLabel(configuration: configuration) }

    struct FocusLabel: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isFocused) var focused
        @Environment(\.voltStyle) var s
        var body: some View {
            configuration.label
                .padding(6)
                .overlay(RoundedRectangle(cornerRadius: max(6, s.radius)).stroke(focused ? s.focus : .clear, lineWidth: 4))
                .scaleEffect(configuration.isPressed ? 0.97 : focused ? 1.06 : 1)
                .shadow(color: .black.opacity(focused ? 0.45 : 0), radius: 12, y: 6)
                .animation(.easeOut(duration: 0.15), value: focused)
        }
    }
}
#endif

public extension View {
    /// On Apple TV, the themed focus style; on iPhone and iPad, unchanged.
    @ViewBuilder func voltTVFocus() -> some View {
        #if os(tvOS)
        self.buttonStyle(VoltTVButtonStyle())
        #else
        self
        #endif
    }

    /// The plain style on iPhone and iPad, the themed focus style on Apple TV.
    @ViewBuilder func voltPlainButton() -> some View {
        #if os(tvOS)
        self.buttonStyle(VoltTVButtonStyle())
        #else
        self.buttonStyle(.plain)
        #endif
    }
}

// MARK: - Theme in SwiftUI

public extension Color {
    /// "#rrggbb" to a Color; anything else is clear.
    init(voltHex hex: String, opacity: Double = 1) {
        guard ThemeTokens.isHex(hex) else { self = .clear; return }
        let (r, g, b) = ThemeTokens.rgb(hex)
        self = Color(.sRGB, red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255, opacity: opacity)
    }
}

/// The theme as SwiftUI values.
public struct VoltStyle {
    public let theme: ResolvedTheme
    public var primary: Color { Color(voltHex: theme.primary) }
    public var primaryInk: Color { Color(voltHex: theme.primaryInk) }
    public var secondary: Color { Color(voltHex: theme.secondary) }
    public var secondaryInk: Color { Color(voltHex: theme.secondaryInk) }
    public var background: Color { Color(voltHex: theme.background) }
    public var text: Color { Color(voltHex: theme.text) }
    public var muted: Color { Color(voltHex: theme.muted, opacity: theme.mutedOpacity) }
    public var radius: CGFloat { CGFloat(theme.radius) }
    /// The focus ring (TV and keyboard): always readable on the background.
    public var focus: Color { Color(voltHex: theme.focusColor) }
    public func font(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        if let f = theme.font { return .custom(f, size: size).weight(weight) }
        return .system(size: size, weight: weight)
    }
}

private struct StyleKey: EnvironmentKey { static let defaultValue = VoltStyle(theme: ThemeTokens.resolve()) }
private struct TKey: EnvironmentKey { static let defaultValue = Translator() }
private struct BaseKey: EnvironmentKey { static let defaultValue: URL? = nil }

public extension EnvironmentValues {
    var voltStyle: VoltStyle { get { self[StyleKey.self] } set { self[StyleKey.self] = newValue } }
    var voltT: Translator { get { self[TKey.self] } set { self[TKey.self] = newValue } }
    /// The API base, to resolve "/path" logos and artwork.
    var voltBase: URL? { get { self[BaseKey.self] } set { self[BaseKey.self] = newValue } }
}

/// An image URL from the API: absolute, or a path on the Volt site.
func voltURL(_ s: String?, base: URL?) -> URL? {
    guard let s, !s.isEmpty else { return nil }
    if s.hasPrefix("/"), !s.hasPrefix("//"), let base { return URL(string: s, relativeTo: base)?.absoluteURL }
    return URL(string: s)
}

// MARK: - Parts

/// A round icon button with an accessibility label (the web kit's tooltip).
public struct VoltIconButton: View {
    @Environment(\.voltStyle) var s
    let symbol: String, label: String, size: CGFloat, action: () -> Void
    public init(_ symbol: String, _ label: String, size: CGFloat = 20, action: @escaping () -> Void) {
        self.symbol = symbol; self.label = label; self.size = size; self.action = action
    }
    public var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: size * voltUIScale, weight: .semibold)).foregroundColor(s.text)
                .frame(width: (size + 24) * voltUIScale, height: (size + 24) * voltUIScale).contentShape(Rectangle())
        }
        .voltPlainButton().accessibilityLabel(label)
    }
}

/// The LIVE pill: red dot when at the live edge, "Go live" when behind.
public struct LiveBadge: View {
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    let state: PlayerState, goLive: () -> Void
    public init(state: PlayerState, goLive: @escaping () -> Void) { self.state = state; self.goLive = goLive }
    public var body: some View {
        Button(action: goLive) {
            HStack(spacing: 6) {
                Circle().fill(state.atLiveEdge ? Color.red : s.muted).frame(width: 8, height: 8)
                Text(state.atLiveEdge ? t("live") : t("goLive")).font(s.font(12 * voltUIScale, .bold)).foregroundColor(s.text)
                if !state.atLiveEdge && state.behindLive >= 1 {
                    Text(t("behindLive", ["time": Schedule.fmtTime(state.behindLive)])).font(s.font(12 * voltUIScale)).foregroundColor(s.muted)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Capsule().fill(s.background.opacity(0.6)))
        }
        .voltPlainButton().disabled(state.atLiveEdge)
        .accessibilityLabel(state.atLiveEdge ? t("live") : t("goLive"))
    }
}

/// The scrubber: on demand, or the DVR window on live. Drags preview without seeking until release.
public struct Scrubber: View {
    @Environment(\.voltStyle) var s
    let state: PlayerState, seek: (Double) -> Void
    @State private var dragging: Double?
    public init(state: PlayerState, seek: @escaping (Double) -> Void) { self.state = state; self.seek = seek }

    var range: (Double, Double)? {
        if state.live { return state.seekable.map { ($0.start, $0.end) } }
        return state.duration.isFinite && state.duration > 0 ? (0, state.duration) : nil
    }

    public var body: some View {
        GeometryReader { geo in
            if let r = range, r.1 > r.0 {
                let a = r.0, b = r.1
                let pos = dragging ?? state.currentTime
                let f = CGFloat(min(1, max(0, (pos - a) / (b - a))))
                ZStack(alignment: .leading) {
                    Capsule().fill(s.text.opacity(0.25)).frame(height: 4)
                    Capsule().fill(s.primary).frame(width: geo.size.width * f, height: 4)
                    Circle().fill(s.primary).frame(width: dragging == nil ? 12 : 18, height: dragging == nil ? 12 : 18)
                        .offset(x: geo.size.width * f - (dragging == nil ? 6 : 9))
                }
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                #if os(iOS)
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { g in dragging = a + Double(min(1, max(0, g.location.x / geo.size.width))) * (b - a) }
                    .onEnded { _ in if let d = dragging { seek(d) }; dragging = nil })
                #endif
                .accessibilityElement()
                .accessibilityValue(Schedule.fmtTime(pos - a))
                .accessibilityAdjustableAction { dir in seek(state.currentTime + (dir == .increment ? 10 : -10)) }
            }
        }
        .frame(height: 24)
    }
}

/// Up next: the same card whatever drives it (the stream's trigger, the guide, the playlist).
public struct UpNextCard: View {
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    @Environment(\.voltBase) var base
    let up: UpNext, variant: UpNext.Variant, playNow: () -> Void, cancel: () -> Void
    public init(_ up: UpNext, variant: UpNext.Variant = .overlay, playNow: @escaping () -> Void, cancel: @escaping () -> Void) {
        self.up = up; self.variant = variant; self.playNow = playNow; self.cancel = cancel
    }
    public var body: some View {
        HStack(spacing: 10) {
            if let u = voltURL(up.artworkUrl, base: base) {
                AsyncImage(url: u) { $0.resizable().aspectRatio(contentMode: .fill) } placeholder: { s.secondaryInk.opacity(0.1) }
                    .frame(width: 72 * voltUIScale, height: 40 * voltUIScale).clipped().cornerRadius(max(2, s.radius / 2))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(up.kicker(t, variant)).font(s.font(11 * voltUIScale, .semibold)).foregroundColor(s.secondaryInk.opacity(0.7))
                Text(up.title).font(s.font(14 * voltUIScale, .bold)).foregroundColor(s.secondaryInk).lineLimit(1)
                if let sub = up.subtitle { Text(sub).font(s.font(12 * voltUIScale)).foregroundColor(s.secondaryInk.opacity(0.7)).lineLimit(1) }
                if let at = up.startsAt { Text(t("startsAt", ["time": Schedule.fmtClock(at)])).font(s.font(11 * voltUIScale)).foregroundColor(s.secondaryInk.opacity(0.6)) }
            }
            Spacer(minLength: 0)
            if up.kind == .item && up.autoAdvance {
                Button(t("playNow"), action: playNow).font(s.font(12 * voltUIScale, .bold)).foregroundColor(s.primaryInk)
                    .padding(.horizontal, 10).padding(.vertical, 6).background(Capsule().fill(s.primary))
                    .voltTVFocus()
            }
            Button(action: cancel) { Image(systemName: "xmark").foregroundColor(s.secondaryInk.opacity(0.7)) }
                .voltTVFocus()
                .accessibilityLabel(t(up.kind == .item ? "cancel" : "dismiss"))
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: s.radius).fill(s.secondary.opacity(0.94))
                .overlay(alignment: .bottomLeading) {
                    GeometryReader { g in Rectangle().fill(s.primary).frame(width: g.size.width * CGFloat(up.progress), height: 3) }
                        .frame(height: 3).clipShape(RoundedRectangle(cornerRadius: s.radius))
                }
        )
        .frame(maxWidth: 360 * voltUIScale)
    }
}

/// Skip intro / recap / credits.
public struct SkipButton: View {
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    let offer: SkipOffer, action: () -> Void
    public init(_ offer: SkipOffer, action: @escaping () -> Void) { self.offer = offer; self.action = action }
    public var body: some View {
        let key = ["intro": "skipIntro", "recap": "skipRecap", "credits": "skipCredits"][offer.kind] ?? "skip"
        Button(action: action) {
            Text(t(key)).font(s.font(14 * voltUIScale, .bold)).foregroundColor(s.text)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: s.radius).stroke(s.text.opacity(0.8), lineWidth: 1.5)
                    .background(RoundedRectangle(cornerRadius: s.radius).fill(s.background.opacity(0.55))))
        }.voltPlainButton()
    }
}

#if os(iOS)
/// The system AirPlay picker (it cannot be opened from code). Not on Apple TV, which receives AirPlay.
public struct RoutePickerButton: UIViewRepresentable {
    let tint: UIColor
    public init(tint: UIColor = .white) { self.tint = tint }
    public func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.tintColor = tint; v.activeTintColor = tint; v.prioritizesVideoDevices = true
        return v
    }
    public func updateUIView(_ v: AVRoutePickerView, context: Context) { v.tintColor = tint }
}
#endif

/// A message in the middle of the picture, with Try again.
public struct CenterMessage: View {
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    let text: String, retry: (() -> Void)?
    public init(_ text: String, retry: (() -> Void)?) { self.text = text; self.retry = retry }
    public var body: some View {
        VStack(spacing: 12) {
            Text(text).font(s.font(15 * voltUIScale, .medium)).foregroundColor(s.text).multilineTextAlignment(.center)
            if let retry {
                Button(t("retry"), action: retry).font(s.font(13 * voltUIScale, .bold)).foregroundColor(s.primaryInk)
                    .padding(.horizontal, 14).padding(.vertical, 8).background(Capsule().fill(s.primary))
                    .voltTVFocus()
            }
        }.padding(20)
    }
}

/// The channel's brand mark, placed as the encoder would burn it (offsets in 1920x1080 pixels).
public struct BrandMarkView: View {
    @Environment(\.voltBase) var base
    let mark: BrandMark
    public init(_ mark: BrandMark) { self.mark = mark }
    public var body: some View {
        GeometryReader { g in
            let k = g.size.height / 1080
            let h = g.size.height * CGFloat(mark.scale) / 100
            let ox = CGFloat(mark.offsetX) * k, oy = CGFloat(mark.offsetY) * k
            let align: Alignment = {
                switch mark.position {
                case .tl: return .topLeading; case .tc: return .top; case .tr: return .topTrailing
                case .bl: return .bottomLeading; case .bc: return .bottom; case .br: return .bottomTrailing
                }
            }()
            AsyncImage(url: voltURL(mark.url, base: base)) { $0.resizable().aspectRatio(contentMode: .fit) } placeholder: { Color.clear }
                .frame(height: h).opacity(mark.opacity / 100)
                .padding(.leading, [.tl, .bl].contains(mark.position) ? ox : 0)
                .padding(.trailing, [.tr, .br].contains(mark.position) ? ox : 0)
                .padding(.top, [.tl, .tc, .tr].contains(mark.position) ? oy : 0)
                .padding(.bottom, [.bl, .bc, .br].contains(mark.position) ? oy : 0)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: align)
        }
        .allowsHitTesting(false)
    }
}

/// Diagonal text over the picture (share previews).
public struct WatermarkView: View {
    let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View {
        Text(text).font(.system(size: 28, weight: .heavy)).foregroundColor(.white.opacity(0.18))
            .rotationEffect(.degrees(-24)).allowsHitTesting(false)
    }
}

/// One entry in a ChoiceMenu. A nil id is "Off".
public struct MenuChoice {
    public let id: String?
    public let label: String
    public init(_ id: String?, _ label: String) { self.id = id; self.label = label }
}

#if os(iOS)
/// A plain menu of choices (quality, subtitles, audio, speed). On Apple TV, TVChoiceButton.
public struct ChoiceMenu: View {
    @Environment(\.voltStyle) var s
    let symbol: String, label: String, choices: [MenuChoice], selected: String?, pick: (String?) -> Void
    public init(symbol: String, label: String, choices: [MenuChoice], selected: String?, pick: @escaping (String?) -> Void) {
        self.symbol = symbol; self.label = label; self.choices = choices; self.selected = selected; self.pick = pick
    }
    public var body: some View {
        Menu {
            ForEach(Array(choices.enumerated()), id: \.offset) { _, c in
                Button { pick(c.id) } label: {
                    if c.id == selected { Label(c.label, systemImage: "checkmark") } else { Text(c.label) }
                }
            }
        } label: {
            Image(systemName: symbol).font(.system(size: 18, weight: .semibold)).foregroundColor(s.text)
                .frame(width: 40, height: 40).contentShape(Rectangle())
        }
        .accessibilityLabel(label)
    }
}
#endif
#endif
