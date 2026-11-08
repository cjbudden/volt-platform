#if os(iOS)
// ============================================================================
//  THE DEFAULT VIDEO SKIN, the native twin of skins/video.ts.
//
//  Top: title (the item, or the programme on air), logo, AirPlay.
//  Middle: the big play button, a spinner, or a message with Try again.
//  Bottom: scrubber (on demand, or the DVR window on live), play, back and
//  forward 10 s, time or LIVE / Go live, Start over, then subtitles (only
//  when the stream has them), audio, quality, speed, picture in picture, full
//  screen. Up next sits bottom right; Skip intro / credits where it would.
//  Controls hide after 3 s of playing and come back on a tap.
// ============================================================================
import SwiftUI
import VoltPlayerCore

public struct VideoSkin: View {
    let ctx: SkinContext
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    @Environment(\.voltBase) var base
    @State private var shown = true
    @State private var hideTask: Task<Void, Never>?

    public init(ctx: SkinContext) { self.ctx = ctx }

    var st: PlayerState { ctx.state }
    var k: VoltCommands { ctx.commands }
    var c: ControlToggles { ctx.theme.controls }

    var title: String {
        if st.live, let p = st.programme { return p.title }
        return st.item?.title ?? ""
    }
    var subtitle: String? {
        if st.live, st.programme != nil { return st.item?.title }
        return st.item?.subtitle
    }

    public var body: some View {
        ZStack {
            Color.black
            ctx.picture
            if let m = st.item?.brandMark, st.adBreak == nil { BrandMarkView(m) }
            if let w = ctx.watermark { WatermarkView(w) }
            if shown || !st.playing { s.background.opacity(0.35).allowsHitTesting(false) }
            center
            VStack(spacing: 0) {
                if shown || !st.playing { top.transition(.opacity) }
                Spacer()
                HStack(alignment: .bottom) {
                    Spacer()
                    if let sk = st.skip { SkipButton(sk) { k.skip() } }
                    else if let up = st.upNext, c.upNext {
                        UpNextCard(up, playNow: { k.next() }, cancel: { k.cancelUpNext() })
                    }
                }
                .padding(12)
                if shown || !st.playing { bottom.transition(.opacity) }
            }
            if st.stats { StatsPanel(state: st, close: { k.toggleStats(false) }) }
        }
        .clipped()
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeInOut(duration: 0.2)) { shown.toggle() }; scheduleHide() }
        .onChange(of: st.playing) { _ in scheduleHide() }
        .onAppear { scheduleHide() }
        .accessibilityElement(children: .contain)
    }

    func scheduleHide() {
        hideTask?.cancel()
        guard st.playing, shown else { return }
        hideTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if !Task.isCancelled && st.playing { withAnimation(.easeInOut(duration: 0.3)) { shown = false } }
        }
    }

    @ViewBuilder var center: some View {
        switch st.status {
        case .loading, .buffering: ProgressView().tint(s.text).scaleEffect(1.4)
        case .error, .offline: CenterMessage(st.error ?? t("offline"), retry: { k.play() })
        case .locked: LockedPanel(access: st.access, commands: k)
        default:
            if !st.playing && (shown || st.status != .playing) {
                Button { k.play() } label: {
                    Image(systemName: st.status == .ended ? "arrow.counterclockwise" : "play.fill").font(.system(size: 34, weight: .bold))
                        .foregroundColor(s.primaryInk).frame(width: 76, height: 76).background(Circle().fill(s.primary))
                }
                .accessibilityLabel(st.status == .ended ? t("replay") : t("play"))
            }
        }
    }

    var top: some View {
        HStack(alignment: .top, spacing: 8) {
            if c.title {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(s.font(16, .bold)).foregroundColor(s.text).lineLimit(1)
                    if let sub = subtitle { Text(sub).font(s.font(12)).foregroundColor(s.muted).lineLimit(1) }
                }
            }
            Spacer()
            if let logo = voltURL(ctx.theme.logoUrl, base: base), ctx.theme.logoPosition == .topRight || ctx.theme.logoPosition == .topLeft {
                AsyncImage(url: logo) { $0.resizable().aspectRatio(contentMode: .fit) } placeholder: { Color.clear }.frame(height: 24)
            }
            if c.airplay && st.airplay.available { RoutePickerButton(tint: UIColor(s.text)).frame(width: 36, height: 36) }
        }
        .padding(.horizontal, 14).padding(.top, 10)
        .background(LinearGradient(colors: [s.background.opacity(0.7), .clear], startPoint: .top, endPoint: .bottom).allowsHitTesting(false))
    }

    var autoLabel: String {
        if st.quality == "auto", let q = st.activeQuality { return t("autoNow", ["q": q.label]) }
        return t("auto")
    }

    var bottom: some View {
        VStack(spacing: 4) {
            if !st.live || st.dvr { Scrubber(state: st) { k.seek($0) }.padding(.horizontal, 14) }
            HStack(spacing: 2) {
                VoltIconButton(st.playing ? "pause.fill" : "play.fill", st.playing ? t("pause") : t("play")) { k.toggle() }
                if c.seekButtons && (!st.live || st.dvr) {
                    VoltIconButton("gobackward.10", t("back10"), size: 18) { k.seekBy(-10) }
                    VoltIconButton("goforward.10", t("fwd10"), size: 18) { k.seekBy(10) }
                }
                if c.volume { VoltIconButton(st.muted ? "speaker.slash.fill" : "speaker.wave.2.fill", st.muted ? t("unmute") : t("mute"), size: 18) { k.toggleMute() } }
                if st.live { LiveBadge(state: st) { k.goLive() } }
                else { Text("\(Schedule.fmtTime(st.currentTime)) / \(Schedule.fmtTime(st.duration))").font(s.font(12).monospacedDigit()).foregroundColor(s.text) }
                if c.startOver && st.canStartOver {
                    VoltIconButton("backward.end.fill", t("startOver"), size: 16) { k.startOver() }
                }
                Spacer(minLength: 0)
                Group {
                if c.subtitles && !st.textTracks.isEmpty {
                    ChoiceMenu(symbol: st.textTrack == nil ? "captions.bubble" : "captions.bubble.fill", label: t("subtitles"),
                               choices: [MenuChoice(nil, t("off"))] + st.textTracks.map { MenuChoice($0.id, $0.label) }, selected: st.textTrack) { k.setTextTrack($0) }
                }
                if c.audioTracks && st.audioTracks.count > 1 {
                    ChoiceMenu(symbol: "waveform", label: t("audio"), choices: st.audioTracks.map { MenuChoice($0.id, $0.label) }, selected: st.audioTrack) { if let id = $0 { k.setAudioTrack(id) } }
                }
                if c.quality && st.qualities.count > 1 {
                    ChoiceMenu(symbol: "slider.horizontal.3", label: t("quality"),
                               choices: [MenuChoice("auto", autoLabel)] + st.qualities.map { MenuChoice($0.id, $0.label) },
                               selected: st.quality) { k.setQuality($0 ?? "auto") }
                }
                if c.speed && !st.live {
                    ChoiceMenu(symbol: "speedometer", label: t("speed"),
                               choices: [0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map { (r: Double) in MenuChoice(String(r), r == 1 ? t("normal") : "\(r)×") }, selected: String(st.rate)) {
                        if let s = $0, let r = Double(s) { k.setRate(r) }
                    }
                }
                }
                Group {
                if c.pip && st.pip.available && st.hasPicture { VoltIconButton("pip.enter", t("pip"), size: 18) { k.togglePip() } }
                if c.fullscreen {
                    VoltIconButton(st.fullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                                   st.fullscreen ? t("exitFullscreen") : t("fullscreen"), size: 18) { k.toggleFullscreen() }
                }
                }
            }
            .padding(.horizontal, 6).padding(.bottom, 6)
        }
        .background(LinearGradient(colors: [.clear, s.background.opacity(0.75)], startPoint: .top, endPoint: .bottom).allowsHitTesting(false))
    }
}

#endif
