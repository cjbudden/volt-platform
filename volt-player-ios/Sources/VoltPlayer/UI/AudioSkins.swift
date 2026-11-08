#if os(iOS) || os(tvOS)
// ============================================================================
//  AUDIO SKINS, the native twins of skins/audio.ts.
//
//    audio_square      a square tile: artwork, title, play. Fits a grid.
//    audio_nowplaying  a panel: big artwork, track details, the last five
//                      tracks and what is coming up. (audio_wave maps here:
//                      AVPlayer gives no sample data for HLS, and the web
//                      rule is that the waveform shows real levels or nothing.)
//    audio_radio       a station player: logo and name, the programme on air
//                      and how far through it is, and the Coming up banner.
//
//  What they show, best first: the track now playing (station metadata or the
//  stream's ID3), else the programme on air, else the item's own title.
//
//  On Apple TV every audio name draws TVAudioSkin (TVSkin.swift), which reuses
//  AudioInfo, Artwork and PlayButton from here.
// ============================================================================
import SwiftUI
import VoltPlayerCore

struct AudioInfo {
    var title: String, sub: String, art: String?, meta: String

    init(_ st: PlayerState) {
        let item = st.item
        if let np = st.nowPlaying, !np.title.isEmpty {
            title = np.title; sub = np.artist ?? ""; art = np.artworkUrl ?? item?.artworkUrl
            meta = [np.album, np.year.map(String.init)].compactMap { $0 }.joined(separator: " · ")
        } else if let p = st.programme {
            title = p.title; sub = p.subtitle ?? item?.title ?? ""; art = p.imageUrl ?? item?.artworkUrl
            meta = "\(Schedule.fmtClock(p.startsAt)) – \(p.endsAt.isFinite ? Schedule.fmtClock(p.endsAt) : "")"
        } else {
            title = item?.title ?? ""; sub = item?.subtitle ?? item?.description ?? ""; art = item?.artworkUrl; meta = ""
        }
    }
}

struct Artwork: View {
    @Environment(\.voltStyle) var s
    @Environment(\.voltBase) var base
    let url: String?
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: s.radius).fill(s.secondary)
            if let u = voltURL(url, base: base) {
                AsyncImage(url: u) { $0.resizable().aspectRatio(contentMode: .fill) } placeholder: { Color.clear }
            } else {
                Image(systemName: "music.note").font(.system(size: 36, weight: .semibold)).foregroundColor(s.secondaryInk.opacity(0.5))
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: s.radius))
    }
}

struct PlayButton: View {
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    let st: PlayerState, k: VoltCommands, size: CGFloat
    var body: some View {
        Button { k.toggle() } label: {
            ZStack {
                Circle().fill(s.primary)
                if st.buffering || st.status == .loading { ProgressView().tint(s.primaryInk) }
                else { Image(systemName: st.playing ? "pause.fill" : "play.fill").font(.system(size: size * 0.4, weight: .bold)).foregroundColor(s.primaryInk) }
            }.frame(width: size, height: size)
        }
        .voltPlainButton().accessibilityLabel(st.playing ? t("pause") : t("play"))
    }
}

#if os(iOS)
/// "Listen on Apple Music": Apple's artwork may be shown only with a link to the song there.
struct ListenLink: View {
    @Environment(\.voltStyle) var s
    let track: TrackInfo?
    var body: some View {
        if let l = track?.listen, let u = URL(string: l.url) {
            Link("Listen on \(l.service)", destination: u).font(s.font(11, .semibold)).foregroundColor(s.muted)
        }
    }
}

public struct AudioSquareSkin: View {
    let ctx: SkinContext
    @Environment(\.voltStyle) var s
    public init(ctx: SkinContext) { self.ctx = ctx }
    public var body: some View {
        let info = AudioInfo(ctx.state)
        ZStack(alignment: .bottomLeading) {
            Artwork(url: info.art)
            LinearGradient(colors: [.clear, s.background.opacity(0.9)], startPoint: .center, endPoint: .bottom)
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    if ctx.state.live { Text(ctx.t("onAir")).font(s.font(10, .heavy)).foregroundColor(.red) }
                    Text(info.title).font(s.font(15, .bold)).foregroundColor(s.text).lineLimit(2)
                    Text(info.sub).font(s.font(12)).foregroundColor(s.muted).lineLimit(1)
                }
                Spacer()
                PlayButton(st: ctx.state, k: ctx.commands, size: 46)
            }.padding(12)
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: s.radius))
    }
}

public struct AudioNowPlayingSkin: View {
    let ctx: SkinContext
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    public init(ctx: SkinContext) { self.ctx = ctx }
    public var body: some View {
        let st = ctx.state
        let info = AudioInfo(st)
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 14) {
                Artwork(url: info.art).frame(width: 120)
                VStack(alignment: .leading, spacing: 4) {
                    Text(t("nowPlaying")).font(s.font(11, .semibold)).foregroundColor(s.muted)
                    Text(info.title).font(s.font(18, .bold)).foregroundColor(s.text).lineLimit(2)
                    Text(info.sub).font(s.font(14)).foregroundColor(s.text.opacity(0.85)).lineLimit(1)
                    if !info.meta.isEmpty { Text(info.meta).font(s.font(12)).foregroundColor(s.muted) }
                    ListenLink(track: st.nowPlaying)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 10) {
                PlayButton(st: st, k: ctx.commands, size: 48)
                if st.live { LiveBadge(state: st) { ctx.commands.goLive() } }
                Spacer()
                if ctx.theme.controls.airplay && st.airplay.available { RoutePickerButton(tint: UIColor(s.text)).frame(width: 36, height: 36) }
            }
            if let next = st.nextTrack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(t("comingUp")).font(s.font(11, .semibold)).foregroundColor(s.muted)
                    Text([next.title, next.artist].compactMap { $0 }.joined(separator: " · ")).font(s.font(13)).foregroundColor(s.text)
                }
            }
            if ctx.theme.controls.history && !st.history.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(t("recentlyPlayed")).font(s.font(11, .semibold)).foregroundColor(s.muted)
                    ForEach(Array(st.history.prefix(5).enumerated()), id: \.offset) { _, tr in
                        HStack(spacing: 8) {
                            Artwork(url: tr.artworkUrl).frame(width: 32)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(tr.title).font(s.font(13, .semibold)).foregroundColor(s.text).lineLimit(1)
                                if let a = tr.artist { Text(a).font(s.font(11)).foregroundColor(s.muted).lineLimit(1) }
                            }
                            Spacer()
                            if let at = tr.startedAt { Text(Schedule.fmtClock(at)).font(s.font(11)).foregroundColor(s.muted) }
                        }
                    }
                }
            }
            if st.status == .error || st.status == .offline { CenterMessage(st.error ?? t("offline"), retry: { ctx.commands.play() }) }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: s.radius).fill(s.background))
    }
}

public struct AudioRadioSkin: View {
    let ctx: SkinContext
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    @Environment(\.voltBase) var base
    public init(ctx: SkinContext) { self.ctx = ctx }
    public var body: some View {
        let st = ctx.state
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Artwork(url: st.item?.artworkUrl).frame(width: 64)
                VStack(alignment: .leading, spacing: 2) {
                    Text(st.item?.title ?? "").font(s.font(16, .bold)).foregroundColor(s.text)
                    if let p = st.programme {
                        Text(p.title).font(s.font(14)).foregroundColor(s.text.opacity(0.85)).lineLimit(1)
                        if p.endsAt.isFinite, let w = st.wallClock {
                            ProgressView(value: min(1, max(0, (w - p.startsAt) / (p.endsAt - p.startsAt)))).tint(s.primary)
                            Text(t("timeLeft", ["time": Schedule.fmtTime(max(0, (p.endsAt - w) / 1000))])).font(s.font(11)).foregroundColor(s.muted)
                        }
                    } else if let np = st.nowPlaying {
                        Text([np.title, np.artist].compactMap { $0 }.joined(separator: " · ")).font(s.font(14)).foregroundColor(s.text.opacity(0.85)).lineLimit(1)
                    }
                }
                Spacer()
                PlayButton(st: st, k: ctx.commands, size: 48)
            }
            if let up = st.upNext, ctx.theme.controls.upNext {
                UpNextCard(up, variant: .banner, playNow: {}, cancel: { ctx.commands.cancelUpNext() })
            }
            if let n = st.nextProgramme, st.upNext == nil {
                Text("\(t("next")): \(n.title) · \(Schedule.fmtClock(n.startsAt))").font(s.font(12)).foregroundColor(s.muted)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: s.radius).fill(s.background))
    }
}
#endif
#endif
