#if os(iOS) || os(tvOS)
// ============================================================================
//  THE EVENT SKIN, the native twin of skins/event.ts.
//
//  Draws the phase the control plane reports over the event's promo, and
//  hands over to the video skin when it is live or the replay is playing:
//
//    pre         countdown, the start in the viewer's own time, Add to calendar
//    offline     past the start, not live yet: "Starting soon"
//    postponed   was / now, or "a new date will be announced"
//    cancelled   said plainly, no countdown
//    ended       the promoter's closing message
//    replay      Watch the replay
//    locked      at any phase: the passes with Buy, or Sign in
//
//  On Apple TV the live phase and the replay hand over to the tv skin, and
//  there is no Add to calendar (a TV has no calendar).
// ============================================================================
import Combine
import SwiftUI
import VoltPlayerCore

public struct EventSkin: View {
    let ctx: SkinContext
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    @Environment(\.voltBase) var base
    @State private var now = Date()
    @State private var calendarFile: URL?
    let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    public init(ctx: SkinContext) { self.ctx = ctx }

    var st: PlayerState { ctx.state }

    public var body: some View {
        if EventRules.showsVideo(st.presentation, replaying: st.replaying) && st.status != .locked {
            #if os(tvOS)
            TVSkin(ctx: ctx)
            #else
            VideoSkin(ctx: ctx)
            #endif
        } else {
            ZStack {
                s.background
                poster
                LinearGradient(colors: [s.background.opacity(0.2), s.background.opacity(0.92)], startPoint: .top, endPoint: .bottom)
                VStack(spacing: 14) {
                    promo
                    phase
                    if st.status == .locked || !st.access.products.isEmpty { LockedPanel(access: st.access, commands: ctx.commands) }
                }
                .padding(18)
            }
            .clipped()
            .onReceive(timer) { now = $0 }
            #if os(iOS)
            .sheet(item: Binding(get: { calendarFile.map { IdentifiedURL(url: $0) } }, set: { calendarFile = $0?.url })) { f in
                ShareSheet(items: [f.url])
            }
            #endif
        }
    }

    @ViewBuilder var poster: some View {
        if let u = voltURL(st.event?.promo?.posterUrl, base: base) {
            AsyncImage(url: u) { $0.resizable().aspectRatio(contentMode: st.event?.promo?.posterFit == "contain" ? .fit : .fill) } placeholder: { Color.clear }
        }
    }

    @ViewBuilder var promo: some View {
        let e = st.event
        if let sides = e?.promo?.sides, sides.count >= 2, e?.promo?.template == .versus {
            HStack(spacing: 16) {
                side(sides[0])
                Text(e?.promo?.separator ?? "vs").font(s.font(16 * voltUIScale, .heavy)).foregroundColor(s.muted)
                side(sides[1])
            }
        }
        VStack(spacing: 4) {
            if let h = e?.promo?.headline { Text(h).font(s.font(12 * voltUIScale, .semibold)).foregroundColor(s.muted) }
            Text(e?.title ?? st.item?.title ?? "").font(s.font(22 * voltUIScale, .heavy)).foregroundColor(s.text).multilineTextAlignment(.center)
            if let sub = e?.promo?.subhead { Text(sub).font(s.font(13 * voltUIScale)).foregroundColor(s.muted) }
        }
    }

    func side(_ p: PromoSide) -> some View {
        VStack(spacing: 6) {
            if let u = voltURL(p.imageUrl, base: base) {
                AsyncImage(url: u) { $0.resizable().aspectRatio(contentMode: .fit) } placeholder: { Color.clear }.frame(width: 56 * voltUIScale, height: 56 * voltUIScale)
            }
            Text(p.name).font(s.font(14 * voltUIScale, .bold)).foregroundColor(s.text).lineLimit(2).multilineTextAlignment(.center)
        }.frame(maxWidth: 140 * voltUIScale)
    }

    func when(_ ms: Double) -> String {
        let f = DateFormatter(); f.dateFormat = DateFormatter.dateFormat(fromTemplate: "EEE d MMM h:mm a", options: 0, locale: .current)
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    @ViewBuilder var phase: some View {
        let e = st.event
        switch st.presentation {
        case .pre?:
            if let start = e?.startsAt {
                let cd = EventRules.countdown(start - now.timeIntervalSince1970 * 1000)
                VStack(spacing: 8) {
                    Text(t("startsIn2")).font(s.font(12 * voltUIScale, .semibold)).foregroundColor(s.muted)
                    HStack(spacing: 10) {
                        unit(cd.days, t("days")); unit(cd.hours, t("hours")); unit(cd.minutes, t("mins")); unit(cd.seconds, t("secs"))
                    }
                    Text(when(start)).font(s.font(13 * voltUIScale)).foregroundColor(s.text)
                    if let m = e?.preMessage { Text(m).font(s.font(13 * voltUIScale)).foregroundColor(s.muted).multilineTextAlignment(.center) }
                    #if os(iOS)
                    Button { addToCalendar() } label: { Label(t("addToCalendar"), systemImage: "calendar.badge.plus") }
                        .font(s.font(13 * voltUIScale, .semibold)).foregroundColor(s.secondaryInk)
                        .padding(.horizontal, 12).padding(.vertical, 7).background(Capsule().fill(s.secondary))
                    #endif
                }
            }
        case .offline?:
            VStack(spacing: 6) {
                Text(t("startingSoon")).font(s.font(17 * voltUIScale, .bold)).foregroundColor(s.text)
                Text(t("startingSoonText")).font(s.font(13 * voltUIScale)).foregroundColor(s.muted)
                ProgressView().tint(s.text)
            }
        case .postponed?:
            VStack(spacing: 6) {
                Text(t("postponed")).font(s.font(17 * voltUIScale, .bold)).foregroundColor(s.text)
                if let was = e?.previousStartsAt { Text(t("wasAt", ["when": when(was)])).font(s.font(13 * voltUIScale)).strikethrough().foregroundColor(s.muted) }
                if let start = e?.startsAt { Text(t("nowAt", ["when": when(start)])).font(s.font(13 * voltUIScale, .semibold)).foregroundColor(s.text) }
                else { Text(t("newDateTba")).font(s.font(13 * voltUIScale)).foregroundColor(s.muted) }
            }
        case .cancelled?:
            Text(t("cancelled")).font(s.font(17 * voltUIScale, .bold)).foregroundColor(s.text)
        case .replay?:
            VStack(spacing: 8) {
                Text(t("ended")).font(s.font(15 * voltUIScale, .semibold)).foregroundColor(s.muted)
                Button { ctx.commands.playReplay() } label: { Label(t("watchReplay"), systemImage: "play.fill") }
                    .font(s.font(15 * voltUIScale, .bold)).foregroundColor(s.primaryInk)
                    .padding(.horizontal, 18).padding(.vertical, 10).background(Capsule().fill(s.primary))
                    .voltTVFocus()
                Text(t("replayHint")).font(s.font(12 * voltUIScale)).foregroundColor(s.muted)
            }
        case .ended?:
            VStack(spacing: 6) {
                Text(t("ended")).font(s.font(17 * voltUIScale, .bold)).foregroundColor(s.text)
                if let m = e?.endedMessage { Text(m).font(s.font(13 * voltUIScale)).foregroundColor(s.muted).multilineTextAlignment(.center) }
            }
        default:
            ProgressView().tint(s.text)
        }
    }

    func unit(_ v: Int, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(String(format: "%02d", v)).font(s.font(26 * voltUIScale, .heavy).monospacedDigit()).foregroundColor(s.text)
            Text(label).font(s.font(10 * voltUIScale, .semibold)).foregroundColor(s.muted)
        }
        .frame(minWidth: 52 * voltUIScale).padding(.vertical, 6).background(RoundedRectangle(cornerRadius: s.radius).fill(s.secondary.opacity(0.85)))
    }

    /// An .ics the viewer opens in Calendar (or any calendar app) from the share sheet.
    func addToCalendar() {
        guard let e = st.event, let start = e.startsAt else { return }
        let ics = EventRules.ics(id: e.id, title: e.title, startsAt: start, endsAt: e.endsAt, description: e.description,
                                 url: "", now: Date().timeIntervalSince1970 * 1000)
        let f = FileManager.default.temporaryDirectory.appendingPathComponent("\(e.title.prefix(40)).ics")
        try? ics.data(using: .utf8)?.write(to: f)
        calendarFile = f
    }
}

struct IdentifiedURL: Identifiable { let url: URL; var id: String { url.absoluteString } }

#if os(iOS)
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
#endif
#endif
