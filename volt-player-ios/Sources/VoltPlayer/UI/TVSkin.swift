#if os(tvOS)
// ============================================================================
//  THE TV SKIN: lean-back on Apple TV with the Siri Remote.
//
//  Two ways to draw the controls, chosen by options.tvControls:
//
//    .system (default)  The system player, AVPlayerViewController. It is what
//                       viewers already know on Apple TV: clickpad scrubbing
//                       with picture previews (from the I-frame playlists when
//                       the output profile has trick-play on), swipe down for
//                       the info panel (description, subtitles, audio), and
//                       Menu to go back. Volt adds to it rather than replacing
//                       it: Guide, Go live, Start over and Quality in the
//                       transport bar; Skip intro and Up next as contextual
//                       buttons; ad breaks played through (no skipping); the
//                       programme on air as the item's title in the info panel.
//    .volt              Volt's own focusable controls in the account's theme.
//                       Controls come up on any press and go away 5 s after
//                       the last one while playing. Left and right seek by
//                       the theme's seek step, up and down bring the controls
//                       back, Play/Pause works anywhere, Menu closes what is
//                       open and otherwise goes back.
//
//  Whatever is chosen, Volt draws the states the system player has no words
//  for: the paywall and sign in, region blocks, "not on air", errors, and
//  demo mode. The guide panel is Volt's in both: the schedule, the programme
//  on now focused first, earlier ones still in the DVR window playable from
//  their start, later ones listed.
// ============================================================================
import AVKit
import Combine
import SwiftUI
import VoltPlayerCore

public struct TVSkin: View {
    let ctx: SkinContext
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    @Environment(\.voltBase) var base
    @State private var guideOpen = false

    public init(ctx: SkinContext) { self.ctx = ctx }

    var st: PlayerState { ctx.state }
    var guideAvailable: Bool { ctx.theme.controls.schedule && !st.schedule.isEmpty && st.live }

    /// The system player while there is a stream to show; Volt's own drawing for everything else.
    var useSystem: Bool {
        guard let host = ctx.host, !ctx.isDemo, host.options.tvControls == .system else { return false }
        switch st.status {
        case .locked, .error, .offline, .idle: return false
        default: return true
        }
    }

    public var body: some View {
        // The guide is drawn over the picture in this view, not presented: a presented screen
        // would make the player screen underneath "disappear", and apps destroy the player then.
        ZStack {
            if useSystem, let host = ctx.host {
                ZStack {
                    TVSystemPlayer(player: host, state: st, theme: ctx.theme, t: ctx.t,
                                   guideAvailable: guideAvailable, panelOpen: guideOpen, openGuide: { guideOpen = true })
                    TVSystemOverlay(ctx: ctx)
                }
            } else {
                TVDrawnSkin(ctx: ctx, guideAvailable: guideAvailable, panelOpen: guideOpen, openGuide: { guideOpen = true })
                    .disabled(guideOpen)
            }
            if guideOpen {
                TVGuidePanel(ctx: ctx, close: { guideOpen = false })
                    .transition(.opacity)
            }
        }
        .ignoresSafeArea()
    }
}

// MARK: - The system player

/// AVPlayerViewController with Volt's actions in its transport bar.
@MainActor
struct TVSystemPlayer: UIViewControllerRepresentable {
    let player: VoltPlayer
    let state: PlayerState
    let theme: ResolvedTheme
    let t: Translator
    let guideAvailable: Bool
    /// The guide is open over the player: the player's view must not take focus back.
    let panelOpen: Bool
    let openGuide: () -> Void

    final class Coordinator {
        /// What the menus were last built from: rebuilt only when it changes, not every tick.
        var key = ""
        var openGuide: () -> Void = {}
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        vc.player = player.avPlayer
        vc.showsPlaybackControls = true
        vc.allowsPictureInPicturePlayback = false
        vc.transportBarIncludesTitleView = true
        apply(vc, context.coordinator)
        return vc
    }

    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {
        if vc.player !== player.avPlayer { vc.player = player.avPlayer }
        apply(vc, context.coordinator)
    }

    static func dismantleUIViewController(_ vc: AVPlayerViewController, coordinator: Coordinator) {
        vc.player = nil
    }

    var behind: Bool { state.live && state.dvr && !state.atLiveEdge }
    var c: ControlToggles { theme.controls }

    func apply(_ vc: AVPlayerViewController, _ co: Coordinator) {
        co.openGuide = openGuide
        if vc.view.isUserInteractionEnabled == panelOpen { vc.view.isUserInteractionEnabled = !panelOpen }
        // Ad breaks play through: the transport bar may not skip them.
        let linear = state.adBreak != nil
        if vc.requiresLinearPlayback != linear { vc.requiresLinearPlayback = linear }
        let key = [
            "\(guideAvailable)", "\(behind)", "\(c.startOver && state.canStartOver)",
            c.quality ? state.qualities.map(\.id).joined(separator: ",") : "", state.quality,
            state.skip.map { "\($0.kind):\($0.to)" } ?? "",
            state.upNext.map { "\($0.kind):\($0.title):\($0.autoAdvance)" } ?? "",
        ].joined(separator: "|")
        guard key != co.key else { return }
        co.key = key
        // Skip and Up next float over the picture on tvOS 16 and later. tvOS 15 has no contextual
        // buttons, so there they go first in the transport bar, so Skip always has a control.
        if #available(tvOS 16, *) {
            vc.transportBarCustomMenuItems = menuItems(co)
            vc.contextualActions = contextualActions()
        } else {
            vc.transportBarCustomMenuItems = contextualActions() + menuItems(co)
        }
    }

    func action(_ title: String, _ symbol: String, selected: Bool = false, _ run: @escaping @MainActor () -> Void) -> UIAction {
        UIAction(title: title, image: UIImage(systemName: symbol), state: selected ? .on : .off) { _ in
            MainActor.assumeIsolated { run() }
        }
    }

    func menuItems(_ co: Coordinator) -> [UIMenuElement] {
        let p = player
        var items: [UIMenuElement] = []
        if guideAvailable { items.append(action(t("schedule"), "list.bullet.rectangle") { co.openGuide() }) }
        if c.startOver && state.canStartOver { items.append(action(t("startOver"), "backward.end") { p.startOver() }) }
        if behind { items.append(action(t("goLive"), "dot.radiowaves.left.and.right") { p.goLive() }) }
        if c.quality && state.qualities.count > 1 {
            let auto = state.quality == "auto"
            var choices: [UIMenuElement] = [action(t("auto"), "sparkles", selected: auto) { p.setQuality("auto") }]
            for q in state.qualities {
                choices.append(action(q.label, "rectangle", selected: state.quality == q.id) { p.setQuality(q.id) })
            }
            items.append(UIMenu(title: t("quality"), image: UIImage(systemName: "slider.horizontal.3"), children: choices))
        }
        return items
    }

    /// Skip intro or credits, and Up next for a playlist item: the buttons that float over the picture.
    func contextualActions() -> [UIAction] {
        let p = player
        if let sk = state.skip, c.skip {
            let key = ["intro": "skipIntro", "recap": "skipRecap", "credits": "skipCredits"][sk.kind] ?? "skip"
            return [action(t(key), "forward.end") { p.skip() }]
        }
        if let up = state.upNext, c.upNext, up.kind == .item {
            return [action("\(t("upNext")): \(up.title)", "play.fill") { p.next() }]
        }
        return []
    }
}

/// What Volt draws over the system player. Nothing here takes focus.
struct TVSystemOverlay: View {
    let ctx: SkinContext
    var st: PlayerState { ctx.state }
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let m = st.item?.brandMark, st.adBreak == nil { BrandMarkView(m) }
            if let w = ctx.watermark { WatermarkView(w) }
            // A programme coming up has nothing to press; the system player cannot say it, so Volt does.
            if let up = st.upNext, ctx.theme.controls.upNext, up.kind != .item, st.adBreak == nil {
                TVUpNextBanner(up: up).padding(60)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .allowsHitTesting(false)
    }
}

/// "Coming up: Midday Report, at 12:00". Information only.
struct TVUpNextBanner: View {
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    let up: UpNext
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(up.kicker(t, .overlay)).font(s.font(22, .semibold)).foregroundColor(s.secondaryInk.opacity(0.75))
            Text(up.title).font(s.font(30, .bold)).foregroundColor(s.secondaryInk).lineLimit(1)
            if let at = up.startsAt { Text(t("startsAt", ["time": Schedule.fmtClock(at)])).font(s.font(22)).foregroundColor(s.secondaryInk.opacity(0.7)) }
        }
        .padding(24)
        .background(RoundedRectangle(cornerRadius: s.radius).fill(s.secondary.opacity(0.92)))
        .frame(maxWidth: 640, alignment: .leading)
    }
}

// MARK: - Volt's own controls

/// A button that draws only its label: the invisible surface that holds focus while the controls are hidden.
struct TVBareButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { configuration.label }
}

/// A control in the TV bar: an icon over a word, focus ring in the theme.
struct TVControlButton: View {
    @Environment(\.voltStyle) var s
    let symbol: String, label: String, action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: symbol).font(.system(size: 34, weight: .semibold))
                Text(label).font(s.font(20, .medium)).lineLimit(1)
            }
            .foregroundColor(s.text)
            .frame(minWidth: 110, minHeight: 96)
            .padding(.horizontal, 8)
            .background(RoundedRectangle(cornerRadius: max(6, s.radius)).fill(s.secondary.opacity(0.55)))
        }
        .buttonStyle(VoltTVButtonStyle())
        .accessibilityLabel(label)
    }
}

/// LIVE at the edge, else how far behind. Information only (Go live is its own button).
struct TVLiveTag: View {
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    let state: PlayerState
    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(state.atLiveEdge ? Color.red : s.muted).frame(width: 14, height: 14)
            Text(t("live")).font(s.font(24, .bold)).foregroundColor(s.text)
            if !state.atLiveEdge && state.behindLive >= 1 {
                Text(t("behindLive", ["time": Schedule.fmtTime(state.behindLive)])).font(s.font(22)).foregroundColor(s.muted)
            }
        }
    }
}

/// Where the playhead is: on demand against the duration, live against the DVR window.
struct TVProgressBar: View {
    @Environment(\.voltStyle) var s
    let state: PlayerState
    var range: (Double, Double)? {
        if state.live { return state.dvr ? state.seekable.map { ($0.start, $0.end) } : nil }
        return state.duration.isFinite && state.duration > 0 ? (0, state.duration) : nil
    }
    var body: some View {
        if let r = range, r.1 > r.0 {
            let f = CGFloat(min(1, max(0, (state.currentTime - r.0) / (r.1 - r.0))))
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(s.text.opacity(0.25)).frame(height: 8)
                    Capsule().fill(s.primary).frame(width: g.size.width * f, height: 8)
                    Circle().fill(s.primary).frame(width: 22, height: 22).offset(x: g.size.width * f - 11)
                }
                .frame(maxHeight: .infinity)
            }
            .frame(height: 24)
        }
    }
}

/// Up next for a playlist item, with Play now and Cancel that can take focus.
struct TVUpNextCard<F: Hashable>: View {
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    let up: UpNext
    let focus: FocusState<F?>.Binding
    let playFocus: F
    let playNow: () -> Void, cancel: () -> Void
    var body: some View {
        HStack(spacing: 24) {
            VStack(alignment: .leading, spacing: 4) {
                Text(up.kicker(t, .overlay)).font(s.font(22, .semibold)).foregroundColor(s.secondaryInk.opacity(0.75))
                Text(up.title).font(s.font(30, .bold)).foregroundColor(s.secondaryInk).lineLimit(1)
                if let sub = up.subtitle { Text(sub).font(s.font(22)).foregroundColor(s.secondaryInk.opacity(0.7)).lineLimit(1) }
            }
            if up.kind == .item && up.autoAdvance {
                Button(action: playNow) {
                    Text(t("playNow")).font(s.font(24, .bold)).foregroundColor(s.primaryInk)
                        .padding(.horizontal, 22).padding(.vertical, 12).background(Capsule().fill(s.primary))
                }
                .buttonStyle(VoltTVButtonStyle())
                .focused(focus, equals: playFocus)
            }
            Button(action: cancel) {
                Text(t(up.kind == .item ? "cancel" : "dismiss")).font(s.font(22, .semibold)).foregroundColor(s.secondaryInk)
                    .padding(.horizontal, 18).padding(.vertical, 10)
            }
            .buttonStyle(VoltTVButtonStyle())
        }
        .padding(24)
        .background(RoundedRectangle(cornerRadius: s.radius).fill(s.secondary.opacity(0.94)))
    }
}

struct TVDrawnSkin: View {
    let ctx: SkinContext
    let guideAvailable: Bool
    let panelOpen: Bool
    let openGuide: () -> Void

    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    @Environment(\.voltBase) var base

    enum Focus: Hashable { case surface, play, back, forward, startOver, goLive, guide, previous, next, subtitles, audio, quality, skip, upNext }
    enum Choice: String, Identifiable { case subtitles, audio, quality; var id: String { rawValue } }

    @FocusState private var focus: Focus?
    @State private var shown = true
    @State private var lastInput = Date()
    @State private var choice: Choice?
    @State private var flash: String?
    @State private var flashTask: Task<Void, Never>?
    /// Kept in state: the view is rebuilt every half second as the playhead moves, and a timer made
    /// in a plain property would be replaced (and never fire) each time.
    @State private var tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    init(ctx: SkinContext, guideAvailable: Bool, panelOpen: Bool, openGuide: @escaping () -> Void) {
        self.ctx = ctx; self.guideAvailable = guideAvailable; self.panelOpen = panelOpen; self.openGuide = openGuide
    }

    var st: PlayerState { ctx.state }
    var k: VoltCommands { ctx.commands }
    var c: ControlToggles { ctx.theme.controls }
    var step: Double { ctx.theme.seekStep }

    var playable: Bool {
        switch st.status {
        case .locked, .error, .offline: return false
        default: return true
        }
    }
    var canSeek: Bool { TVRules.seekTarget(st, delta: 0) != nil }

    var title: String {
        if st.live, let p = st.programme { return p.title }
        return st.item?.title ?? ""
    }
    var subtitle: String? {
        if st.live, st.programme != nil { return st.item?.title }
        return st.item?.subtitle
    }

    var body: some View {
        ZStack {
            Color.black
            ctx.picture
            if let m = st.item?.brandMark, st.adBreak == nil { BrandMarkView(m) }
            if let w = ctx.watermark { WatermarkView(w) }
            if playable {
                if shown || !st.playing { s.background.opacity(0.4).allowsHitTesting(false) }
                if st.status == .loading || st.status == .buffering { ProgressView().tint(s.text).scaleEffect(2) }
                if let f = flash {
                    Text(f).font(s.font(44, .heavy)).foregroundColor(s.text)
                        .padding(.horizontal, 30).padding(.vertical, 16)
                        .background(Capsule().fill(s.background.opacity(0.7)))
                }
                if shown || !st.playing { chrome } else { surface }
                corner
            } else {
                s.background.opacity(0.7)
                if st.status == .locked {
                    LockedPanel(access: st.access, commands: k)
                } else {
                    CenterMessage(st.error ?? t("offline"), retry: { k.play() })
                }
            }
            if st.stats { StatsPanel(state: st, close: { k.toggleStats(false) }) }
        }
        .onPlayPauseCommand { input(); k.toggle() }
        .onExitCommand(perform: exitAction)
        .onReceive(tick) { _ in autoHide() }
        .onChange(of: focus) { _ in lastInput = Date() }
        .onChange(of: st.skip?.kind) { kind in if kind != nil && !shown { focus = .skip } }
        .onAppear { Task { @MainActor in focus = shown || !st.playing ? .play : .surface } }
        .confirmationDialog(choiceTitle, isPresented: Binding(get: { choice != nil }, set: { if !$0 { choice = nil } }),
                            titleVisibility: .visible) {
            ForEach(Array(choiceItems.enumerated()), id: \.offset) { _, it in
                Button(it.selected ? "✓ \(it.label)" : it.label) { it.pick(); choice = nil; input() }
            }
            Button(t("cancel"), role: .cancel) { choice = nil }
        }
    }

    // MARK: input and timing

    func input() { lastInput = Date() }

    func show() {
        input()
        withAnimation(.easeOut(duration: 0.2)) { shown = true }
        Task { @MainActor in focus = .play }
    }

    func hide() {
        withAnimation(.easeIn(duration: 0.3)) { shown = false }
        Task { @MainActor in focus = st.skip != nil ? .skip : .surface }
    }

    func autoHide() {
        if TVRules.shouldHide(shown: shown, playing: st.playing, panelOpen: panelOpen || choice != nil,
                              idleSeconds: Date().timeIntervalSince(lastInput)) { hide() }
    }

    /// Menu: close what is open, else let it go back (nil passes the press on).
    var exitAction: (() -> Void)? {
        if shown && st.playing && playable { return { hide() } }
        return nil
    }

    func seek(_ delta: Double) {
        input()
        guard let to = TVRules.seekTarget(st, delta: delta) else { return }
        k.seek(to)
        flashTask?.cancel()
        flash = (delta > 0 ? "+" : "−") + "\(Int(abs(delta))) s"
        flashTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 900_000_000)
            if !Task.isCancelled { flash = nil }
        }
    }

    /// Left and right seek, up and down bring the controls up: on the hidden surface, and on Skip
    /// when it holds focus. With the controls showing, the focus engine moves between buttons.
    func hiddenMove(_ dir: MoveCommandDirection) {
        // Controls on screen: the focus engine moves between the buttons, nothing to seek here.
        if shown || !st.playing { return }
        switch dir {
        case .left: seek(-step)
        case .right: seek(step)
        default: show()
        }
    }

    // MARK: parts

    /// Holds focus while the controls are hidden: select shows them, left and right seek.
    var surface: some View {
        Button { show() } label: { Color.white.opacity(0.001).frame(maxWidth: .infinity, maxHeight: .infinity) }
            .buttonStyle(TVBareButtonStyle())
            .focused($focus, equals: .surface)
            .onMoveCommand(perform: hiddenMove)
            .accessibilityLabel(t("play"))
    }

    var chrome: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 24) {
                if c.title {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(title).font(s.font(46, .bold)).foregroundColor(s.text).lineLimit(1)
                        if let sub = subtitle { Text(sub).font(s.font(28)).foregroundColor(s.muted).lineLimit(1) }
                        if st.live, let n = st.nextProgramme {
                            Text("\(t("next")): \(n.title) · \(Schedule.fmtClock(n.startsAt))").font(s.font(24)).foregroundColor(s.muted).lineLimit(1)
                        }
                    }
                }
                Spacer()
                if let logo = voltURL(ctx.theme.logoUrl, base: base), ctx.theme.logoPosition != .none {
                    AsyncImage(url: logo) { $0.resizable().aspectRatio(contentMode: .fit) } placeholder: { Color.clear }.frame(height: 56)
                }
            }
            .padding(.horizontal, 80).padding(.top, 60)
            .background(LinearGradient(colors: [s.background.opacity(0.8), .clear], startPoint: .top, endPoint: .bottom).allowsHitTesting(false))

            Spacer()

            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 24) {
                    if st.live { TVLiveTag(state: st) }
                    else if st.duration.isFinite {
                        Text("\(Schedule.fmtTime(st.currentTime)) / \(Schedule.fmtTime(st.duration))")
                            .font(s.font(24).monospacedDigit()).foregroundColor(s.text)
                    }
                    Spacer()
                }
                TVProgressBar(state: st)
                HStack(spacing: 20) {
                    TVControlButton(symbol: st.playing ? "pause.fill" : "play.fill", label: st.playing ? t("pause") : t("play")) { input(); k.toggle() }
                        .focused($focus, equals: .play)
                    if c.seekButtons && canSeek {
                        TVControlButton(symbol: "gobackward.\(Int(step))", label: "−\(Int(step)) s") { seek(-step) }
                            .focused($focus, equals: .back)
                        TVControlButton(symbol: "goforward.\(Int(step))", label: "+\(Int(step)) s") { seek(step) }
                            .focused($focus, equals: .forward)
                    }
                    if c.startOver && st.canStartOver {
                        TVControlButton(symbol: "backward.end.fill", label: t("startOver")) { input(); k.startOver() }
                            .focused($focus, equals: .startOver)
                    }
                    if st.live && st.dvr && !st.atLiveEdge {
                        TVControlButton(symbol: "dot.radiowaves.left.and.right", label: t("goLive")) { input(); k.goLive() }
                            .focused($focus, equals: .goLive)
                    }
                    if guideAvailable {
                        TVControlButton(symbol: "list.bullet.rectangle", label: t("schedule")) { input(); openGuide() }
                            .focused($focus, equals: .guide)
                    }
                    if st.items.count > 1 {
                        TVControlButton(symbol: "backward.fill", label: t("previous")) { input(); k.previous() }
                            .focused($focus, equals: .previous)
                        TVControlButton(symbol: "forward.fill", label: t("nextItem")) { input(); k.next() }
                            .focused($focus, equals: .next)
                    }
                    Spacer(minLength: 0)
                    Group {
                    if c.subtitles && !st.textTracks.isEmpty {
                        TVControlButton(symbol: st.textTrack == nil ? "captions.bubble" : "captions.bubble.fill", label: t("subtitles")) { input(); choice = .subtitles }
                            .focused($focus, equals: .subtitles)
                    }
                    if c.audioTracks && st.audioTracks.count > 1 {
                        TVControlButton(symbol: "waveform", label: t("audio")) { input(); choice = .audio }
                            .focused($focus, equals: .audio)
                    }
                    if c.quality && st.qualities.count > 1 {
                        TVControlButton(symbol: "slider.horizontal.3", label: t("quality")) { input(); choice = .quality }
                            .focused($focus, equals: .quality)
                    }
                    }
                }
                .focusSection()
            }
            .padding(.horizontal, 80).padding(.bottom, 60).padding(.top, 40)
            .background(LinearGradient(colors: [.clear, s.background.opacity(0.85)], startPoint: .top, endPoint: .bottom).allowsHitTesting(false))
        }
        .transition(.opacity)
    }

    /// Skip intro or credits, or up next, bottom right above the controls.
    @ViewBuilder var corner: some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                if let sk = st.skip, c.skip {
                    SkipButton(sk) { input(); k.skip() }
                        .focused($focus, equals: .skip)
                        .onMoveCommand(perform: hiddenMove)
                } else if let up = st.upNext, c.upNext, st.adBreak == nil {
                    TVUpNextCard(up: up, focus: $focus, playFocus: Focus.upNext, playNow: { input(); k.next() }, cancel: { input(); k.cancelUpNext() })
                }
            }
            .padding(.horizontal, 80)
            .padding(.bottom, shown || !st.playing ? 320 : 80)
        }
    }

    // MARK: choices

    struct ChoiceItem { let label: String; let selected: Bool; let pick: () -> Void }

    var choiceTitle: String {
        switch choice {
        case .subtitles?: return t("subtitles")
        case .audio?: return t("audio")
        case .quality?: return t("quality")
        case nil: return ""
        }
    }

    var choiceItems: [ChoiceItem] {
        let k = self.k
        switch choice {
        case .subtitles?:
            return [ChoiceItem(label: t("off"), selected: st.textTrack == nil) { k.setTextTrack(nil) }]
                + st.textTracks.map { tr in ChoiceItem(label: tr.label, selected: st.textTrack == tr.id) { k.setTextTrack(tr.id) } }
        case .audio?:
            return st.audioTracks.map { tr in ChoiceItem(label: tr.label, selected: st.audioTrack == tr.id) { k.setAudioTrack(tr.id) } }
        case .quality?:
            let auto = st.quality == "auto" && st.activeQuality != nil ? t("autoNow", ["q": st.activeQuality!.label]) : t("auto")
            return [ChoiceItem(label: auto, selected: st.quality == "auto") { k.setQuality("auto") }]
                + st.qualities.map { q in ChoiceItem(label: q.label, selected: st.quality == q.id) { k.setQuality(q.id) } }
        case nil:
            return []
        }
    }
}

// MARK: - The guide

/// The schedule as a focusable list. The programme on now has focus first; earlier ones still in the
/// window play from their start; later ones are listed (nothing to play yet). Menu closes it.
struct TVGuidePanel: View {
    let ctx: SkinContext
    let close: () -> Void
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    @FocusState private var focused: String?
    @Namespace private var scope

    init(ctx: SkinContext, close: @escaping () -> Void) { self.ctx = ctx; self.close = close }

    var body: some View {
        let rows = TVRules.guideRows(ctx.state, now: Date().timeIntervalSince1970 * 1000)
        ZStack {
            s.background.opacity(0.94).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 30) {
                Text(t("schedule")).font(s.font(52, .heavy)).foregroundColor(s.text)
                if rows.isEmpty {
                    Text(t("offline")).font(s.font(28)).foregroundColor(s.muted)
                }
                // A plain stack: at most 40 rows, and every row exists, so focus can land on any of them.
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            ForEach(rows) { r in
                                row(r).id(r.id)
                                    .prefersDefaultFocus(r.kind == .onNow, in: scope)
                            }
                        }
                        .padding(.vertical, 20).padding(.horizontal, 12)
                    }
                    .onAppear {
                        guard let i = TVRules.initialRow(rows) else { return }
                        let id = rows[i].id
                        focused = id
                        Task { @MainActor in proxy.scrollTo(id, anchor: .center) }
                    }
                }
            }
            .padding(.horizontal, 100).padding(.vertical, 70)
        }
        .focusScope(scope)
        .focusSection()
        .onExitCommand { close() }
    }

    func tag(_ r: TVRules.GuideRow) -> String {
        switch r.kind {
        case .onNow: return r.target != nil ? "\(t("onNow")) · \(t("startOver"))" : t("onNow")
        case .earlier: return t("startOver")
        case .later: return t("later")
        }
    }

    func row(_ r: TVRules.GuideRow) -> some View {
        Button { choose(r) } label: {
            HStack(alignment: .center, spacing: 30) {
                Text(Schedule.fmtClock(r.programme.startsAt)).font(s.font(28, .semibold).monospacedDigit())
                    .foregroundColor(s.muted).frame(width: 150, alignment: .leading)
                VStack(alignment: .leading, spacing: 6) {
                    Text(r.programme.title).font(s.font(32, .bold)).foregroundColor(s.text).lineLimit(1)
                    if let sub = r.programme.subtitle { Text(sub).font(s.font(24)).foregroundColor(s.muted).lineLimit(1) }
                }
                Spacer(minLength: 20)
                Text(tag(r)).font(s.font(22, .semibold))
                    .foregroundColor(r.kind == .onNow ? s.primaryInk : s.text)
                    .padding(.horizontal, 16).padding(.vertical, 8)
                    .background(Capsule().fill(r.kind == .onNow ? s.primary : s.secondary.opacity(0.8)))
                    .opacity(r.kind == .later ? 0.7 : 1)
            }
            .padding(.horizontal, 28).padding(.vertical, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: max(6, s.radius)).fill(s.secondary.opacity(r.kind == .onNow ? 0.9 : 0.55)))
        }
        .buttonStyle(VoltTVButtonStyle())
        .focused($focused, equals: r.id)
    }

    /// Earlier or on now: play from its start. Later: nothing to play yet, the guide stays open.
    func choose(_ r: TVRules.GuideRow) {
        if let to = r.target {
            ctx.commands.seek(to)
            ctx.commands.play()
            close()
        } else if r.kind == .onNow {
            close()
        }
    }
}

// MARK: - Audio on a TV

/// Every audio skin on Apple TV: large artwork, the track, a focusable play button, what is
/// coming up and what played. Play/Pause on the remote works from anywhere on it.
public struct TVAudioSkin: View {
    let ctx: SkinContext
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    public init(ctx: SkinContext) { self.ctx = ctx }

    public var body: some View {
        let st = ctx.state
        let info = AudioInfo(st)
        HStack(alignment: .center, spacing: 70) {
            Artwork(url: info.art).frame(width: 560)
            VStack(alignment: .leading, spacing: 18) {
                Text(st.live ? t("onAir") : t("nowPlaying")).font(s.font(26, .semibold)).foregroundColor(st.live ? .red : s.muted)
                Text(info.title).font(s.font(58, .bold)).foregroundColor(s.text).lineLimit(2)
                if !info.sub.isEmpty { Text(info.sub).font(s.font(36)).foregroundColor(s.text.opacity(0.85)).lineLimit(1) }
                if !info.meta.isEmpty { Text(info.meta).font(s.font(26)).foregroundColor(s.muted) }
                HStack(spacing: 30) {
                    PlayButton(st: st, k: ctx.commands, size: 110)
                    if st.live { TVLiveTag(state: st) }
                }
                .padding(.vertical, 10)
                if let next = st.nextTrack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(t("comingUp")).font(s.font(22, .semibold)).foregroundColor(s.muted)
                        Text([next.title, next.artist].compactMap { $0 }.joined(separator: " · ")).font(s.font(28)).foregroundColor(s.text)
                    }
                } else if let n = st.nextProgramme {
                    Text("\(t("next")): \(n.title) · \(Schedule.fmtClock(n.startsAt))").font(s.font(26)).foregroundColor(s.muted)
                }
                if ctx.theme.controls.history && !st.history.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(t("recentlyPlayed")).font(s.font(22, .semibold)).foregroundColor(s.muted)
                        ForEach(Array(st.history.prefix(4).enumerated()), id: \.offset) { _, tr in
                            HStack(spacing: 16) {
                                Artwork(url: tr.artworkUrl).frame(width: 64)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(tr.title).font(s.font(26, .semibold)).foregroundColor(s.text).lineLimit(1)
                                    if let a = tr.artist { Text(a).font(s.font(22)).foregroundColor(s.muted).lineLimit(1) }
                                }
                                Spacer()
                                if let at = tr.startedAt { Text(Schedule.fmtClock(at)).font(s.font(22)).foregroundColor(s.muted) }
                            }
                        }
                    }
                }
                if st.status == .error || st.status == .offline { CenterMessage(st.error ?? t("offline"), retry: { ctx.commands.play() }) }
                if st.status == .locked { LockedPanel(access: st.access, commands: ctx.commands) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 100).padding(.vertical, 80)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(s.background.ignoresSafeArea())
        .onPlayPauseCommand { ctx.commands.toggle() }
    }
}
#endif
