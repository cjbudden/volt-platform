#if os(iOS) || os(tvOS)
// ============================================================================
//  THE VOLT PLAYER FOR iOS AND tvOS: AVPlayer + playlist + guide + events + beacons.
//
//  On tvOS: AirPlay sending, picture in picture and full screen are not
//  offered (the state says unavailable), purchase and sign in always go to the
//  app as events (a TV has no browser), and the item carries its title and
//  programme as external metadata for the system info panel.
//
//  The same job as volt-player/src/sdk/player.ts. It owns the AVPlayer and
//  publishes one PlayerState; skins draw from the state and call commands,
//  and never touch the AVPlayer, so a skin can render badly but cannot break
//  playback. Every rule that is not AVFoundation plumbing lives in
//  VoltPlayerCore (Derive, Schedule, Triggers, EventRules) and is unit tested.
// ============================================================================
import AVFoundation
import AVKit
import Combine
import Foundation
import MediaPlayer
import UIKit
import VoltPlayerCore

@MainActor
public final class VoltPlayer: NSObject, ObservableObject, VoltCommands {
    @Published public private(set) var state = PlayerState()
    @Published public private(set) var theme: ResolvedTheme
    public let t: Translator
    public private(set) var options: VoltPlayerOptions
    /// The skin to draw: the option, else the asset kind's default.
    @Published public private(set) var skinId: String

    /// The AVPlayer, for a view that draws the picture. Skins never use it.
    public let avPlayer = AVPlayer()
    let api: VoltAPI?

    private var item: AVPlayerItem?
    private var timeObserver: Any?
    private var kvo: [NSKeyValueObservation] = []
    private var observers: [NSObjectProtocol] = []
    /// The current item's own observers, removed with it so an old item cannot write the state.
    private var itemKVO: [NSKeyValueObservation] = []
    private var itemObservers: [NSObjectProtocol] = []
    /// An event's stream has been asked for in this live phase (cleared when the phase ends).
    private var liveLoadStarted = false
    private var tasks: [Task<Void, Never>] = []
    private var eventTask: Task<Void, Never>?
    private var loadTask: Task<Void, Never>?

    private var graphics: [String: StreamGraphic] = [:]
    private var dismissed: String?
    private var lastProgrammeId: String?
    private var lastPresentation: Presentation?
    private var presentationStart: EpochMs?
    private var beacons: BeaconSession?
    private var beaconClock = Date()
    private var collector: AVPlayerItemMetadataCollector?
    private var metadataOutput: AVPlayerItemMetadataOutput?
    private var variants: [(id: String, size: CGSize?, bitrate: Double)] = []
    private var fairPlay: FairPlayDelegate?
    private var contentKeySession: AVContentKeySession?
    #if os(iOS)
    private let routes = AVRouteDetector()
    #endif
    weak var playerLayer: AVPlayerLayer?
    private var pip: AVPictureInPictureController?
    private var started = false

    public init(_ options: VoltPlayerOptions) {
        self.options = options
        self.t = Translator(options.strings)
        self.theme = ThemeTokens.resolve(options.theme)
        self.skinId = options.skin ?? (options.eventId != nil ? "event" : options.stationId != nil ? "audio_nowplaying" : Self.defaultVideoSkin)
        if let base = options.apiBase, let key = options.appKey {
            self.api = VoltAPI(base: base, appKey: key, appVersion: options.appVersion)
        } else { self.api = nil }
        super.init()
        if let demo = options.demo { self.state = demo; return }
        avPlayer.isMuted = options.muted
        state.muted = options.muted
        #if os(iOS)
        avPlayer.allowsExternalPlayback = options.airplay
        routes.isRouteDetectionEnabled = true
        state.airplay.available = routes.multipleRoutesDetected
        state.pip.available = AVPictureInPictureController.isPictureInPictureSupported()
        #endif
        watchPlayer()
        if options.configureAudioSession { try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback) }
        if options.lockScreen { setUpRemoteCommands() }
        Task { await self.start() }
    }

    /// The skin for a channel or on-demand asset when none is named: `tv` on Apple TV.
    #if os(tvOS)
    static let defaultVideoSkin = "tv"
    #else
    static let defaultVideoSkin = "video"
    #endif

    // MARK: - Start

    private func start() async {
        var items: [PlaylistItem] = []
        if let pl = options.playlist { items = Schedule.normalize(pl) }
        else if let it = options.item { items = [it] }
        else if let s = options.source { items = [PlaylistItem(id: "source", source: s)] }
        else if let a = options.assetId ?? options.eventId { items = [PlaylistItem(id: a, assetId: a)] }

        // A station: its saved setup (theme) and its sources, unless the app gave its own.
        if let sid = options.stationId, let api {
            if let s = await api.stationSession(stationId: sid) {
                theme = ThemeTokens.resolve(s.theme, options.theme)
                if items.isEmpty { items = [PlaylistItem(id: sid, title: s.name, artworkUrl: s.artworkUrl, source: s.source, live: true)] }
            }
            pollNowPlaying(sid)
        }
        if let g = options.epg { state.schedule = g }
        if let ch = options.epgChannelId { pollGuide(ch) }
        state.items = items
        state.index = min(max(0, options.startIndex), max(0, items.count - 1))
        // An event plays only when the control plane says it is live (or the replay is asked for).
        // pollEvent loads it on the way into live, now or on a later poll, so it is loaded in one place.
        if options.eventId != nil {
            await pollEvent()
            if state.presentation != .live { set { $0.status = .idle } }
            return
        }
        if !items.isEmpty { load(index: state.index) }
    }

    // MARK: - Loading an item

    private func load(index: Int) {
        guard index >= 0, index < state.items.count else { return }
        loadTask?.cancel()
        // The old stream stops now: if the next item turns out locked or off air, nothing keeps
        // playing behind the message, and none of its callbacks can change the state.
        stopItem()
        endBeacons()
        dismissed = nil
        graphics = [:]
        presentationStart = nil
        state.index = index
        state.item = state.items[index]
        state.status = .loading
        state.error = nil
        emit(.itemchange, state.item)
        loadTask = Task { [weak self] in await self?.resolveAndPlay(index) }
    }

    private func resolveAndPlay(_ index: Int) async {
        var it = state.items[index]
        let sid = "ios-\(UUID().uuidString.lowercased())"
        if let asset = it.assetId, let api, !Schedule.hasSource(it.source) || it.playbackToken == nil {
            do {
                let r = try await api.resolve(assetId: asset, viewerToken: options.viewerToken, sid: sid)
                if Task.isCancelled { return }
                it = mergeResolved(it, r)
                state.access = AccessState()
            } catch let e as GateError {
                if Task.isCancelled { return }
                set {
                    $0.status = .locked
                    $0.error = e.message
                    $0.access = AccessState(mode: e.mode.flatMap(AccessState.Mode.init(rawValue:)) ?? (e.status == 451 ? .blocked : nil),
                                            message: e.message, products: e.products)
                }
                emit(.locked, e.message)
                return
            } catch {
                if Task.isCancelled { return }
                fail(t("stopped"), code: "network"); return
            }
        }
        if it.brandMark == nil { it.brandMark = options.brandMark }
        state.items[index] = it
        state.item = it
        guard let url = Self.playableURL(it.source) else {
            set { $0.status = .offline; $0.error = self.t("offline") }
            return
        }
        attach(url: url, item: it, sid: sid)
    }

    /// HLS first (AVPlayer's own format), then progressive audio, then anything else. DASH is not
    /// played by AVPlayer; a Volt asset always has HLS.
    static func playableURL(_ s: Source?) -> URL? {
        guard let s else { return nil }
        for c in [s.hls, s.mp3, s.url] { if let c, !c.isEmpty, let u = URL(string: c) { return u } }
        return nil
    }

    private func attach(url: URL, item it: PlaylistItem, sid: String) {
        let asset = AVURLAsset(url: url)
        if let fp = options.fairPlay {
            let session = AVContentKeySession(keySystem: .fairPlayStreaming)
            let d = FairPlayDelegate(config: fp, assetId: it.assetId)
            session.setDelegate(d, queue: DispatchQueue(label: "volt.fairplay"))
            session.addContentKeyRecipient(asset)
            fairPlay = d; contentKeySession = session
        }
        let pi = AVPlayerItem(asset: asset)
        // In-stream triggers (EXT-X-DATERANGE): programmes, up next, ad breaks, skip markers.
        let c = AVPlayerItemMetadataCollector(identifiers: nil, classifyingLabels: nil)
        c.setDelegate(self, queue: .main)
        pi.add(c); collector = c
        // Timed ID3 (radio now playing carried in the stream).
        let o = AVPlayerItemMetadataOutput(identifiers: nil)
        o.setDelegate(self, queue: .main)
        pi.add(o); metadataOutput = o
        watchItem(pi)
        item = pi
        avPlayer.replaceCurrentItem(with: pi)
        if let s = options.startAt, !(it.live ?? false), state.index == options.startIndex {
            pi.seek(to: CMTime(seconds: s, preferredTimescale: 600), completionHandler: nil)
        }
        loadVariants(asset)
        if let token = it.playbackToken, options.beacons, let api {
            beaconClock = Date()
            beacons = BeaconSession(token: token, id: sid, now: 0) { body in Task { await api.beacon(body) } }
        }
        if options.autoplay { avPlayer.play() }
        updateNowPlayingInfo()
        #if os(tvOS)
        applyExternalMetadata(state.programme)
        #endif
        emit(.ready, nil)
    }

    private func loadVariants(_ asset: AVURLAsset) {
        Task { [weak self] in
            var list: [(String, CGSize?, Double)] = []
            if #available(iOS 16, tvOS 16, *) {
                if let vs = try? await asset.load(.variants) {
                    for (i, v) in vs.enumerated() { list.append(("\(i)", v.videoAttributes?.presentationSize, v.peakBitRate ?? v.averageBitRate ?? 0)) }
                }
            } else {
                for (i, v) in asset.variants.enumerated() { list.append(("\(i)", v.videoAttributes?.presentationSize, v.peakBitRate ?? v.averageBitRate ?? 0)) }
            }
            guard let self else { return }
            self.variants = list.map { (id: $0.0, size: $0.1, bitrate: $0.2) }
            let q = Schedule.qualityList(list.map { v in Schedule.VariantInput(id: v.0, height: v.1.map { Int($0.height) }, width: v.1.map { Int($0.width) }, bandwidth: v.2) })
            self.set { $0.qualities = q; $0.audioOnly = !list.isEmpty && list.allSatisfy { $0.1 == nil } }
            self.loadMediaSelection(asset)
        }
    }

    private func loadMediaSelection(_ asset: AVURLAsset) {
        Task { [weak self] in
            guard let self else { return }
            let legible = await Self.group(asset, .legible)
            let audible = await Self.group(asset, .audible)
            let texts = legible?.options.enumerated().map { i, o in
                TextTrackInfo(id: "\(i)", lang: o.extendedLanguageTag ?? o.locale?.identifier ?? "", label: o.displayName,
                              kind: o.hasMediaCharacteristic(.describesMusicAndSoundForAccessibility) ? "captions" : "subtitles")
            } ?? []
            let audios = (audible?.options.count ?? 0) > 1 ? audible!.options.enumerated().map { i, o in
                AudioTrackInfo(id: "\(i)", lang: o.extendedLanguageTag ?? o.locale?.identifier ?? "", label: o.displayName, channels: nil)
            } : []
            self.set { $0.textTracks = texts; $0.audioTracks = audios; $0.audioTrack = audios.isEmpty ? nil : "0" }
        }
    }

    static func group(_ asset: AVURLAsset, _ c: AVMediaCharacteristic) async -> AVMediaSelectionGroup? {
        if #available(iOS 16, tvOS 16, *) { return try? await asset.loadMediaSelectionGroup(for: c) }
        return asset.mediaSelectionGroup(forMediaCharacteristic: c)
    }

    // MARK: - Watching the player

    private func watchPlayer() {
        timeObserver = avPlayer.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.derive() }
        }
        kvo.append(avPlayer.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
            Task { @MainActor in self?.statusChanged(p.timeControlStatus) }
        })
        let nc = NotificationCenter.default
        #if os(iOS)
        kvo.append(avPlayer.observe(\.isExternalPlaybackActive, options: [.new]) { [weak self] p, _ in
            Task { @MainActor in self?.set { $0.airplay.active = p.isExternalPlaybackActive } }
        })
        observers.append(nc.addObserver(forName: .AVRouteDetectorMultipleRoutesDetectedDidChange, object: routes, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { guard let self else { return }; self.set { $0.airplay.available = self.routes.multipleRoutesDetected } }
        })
        #endif
        observers.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.wentToBackground() }
        })
        observers.append(nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { guard let self, self.state.playing else { return }; self.beacons?.resume(now: self.beaconNow, kbps: self.kbps) }
        })
    }

    /// Stop and let go of the current item and everything watching it.
    private func stopItem() {
        avPlayer.pause()
        itemKVO.forEach { $0.invalidate() }; itemKVO = []
        itemObservers.forEach { NotificationCenter.default.removeObserver($0) }; itemObservers = []
        if item != nil || avPlayer.currentItem != nil { avPlayer.replaceCurrentItem(with: nil) }
        item = nil
        collector = nil; metadataOutput = nil
        contentKeySession = nil; fairPlay = nil
    }

    private func watchItem(_ pi: AVPlayerItem) {
        itemKVO.append(pi.observe(\.status, options: [.new]) { [weak self] i, _ in
            Task { @MainActor in
                guard let self, i === self.item else { return }
                if i.status == .failed { self.fail(self.readable(i.error), code: (i.error as NSError?).map { "\($0.code)" }) }
                if i.status == .readyToPlay { self.set { $0.status = self.avPlayer.rate > 0 ? .playing : .ready } }
            }
        })
        itemKVO.append(pi.observe(\.presentationSize, options: [.new]) { [weak self] i, _ in
            Task { @MainActor in self?.set { $0.hasPicture = i.presentationSize.width > 0 } }
        })
        itemObservers.append(NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: pi, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.ended() }
        })
        itemObservers.append(NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: pi, queue: .main) { [weak self] n in
            MainActor.assumeIsolated { self?.fail(self?.readable(n.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error) ?? "", code: "stalled") }
        })
    }

    private func statusChanged(_ s: AVPlayer.TimeControlStatus) {
        switch s {
        case .playing:
            set { $0.status = .playing; $0.playing = true; $0.buffering = false }
            if !started { started = true }
            beacons?.playing(now: beaconNow, kbps: kbps)
            emit(.play, nil)
        case .paused:
            // No item: the pause came from stopping one, and the state already says what is next.
            if item != nil && state.status != .ended && state.status != .error && state.status != .locked && state.status != .offline {
                set { $0.status = .paused; $0.playing = false; $0.buffering = false }
                emit(.pause, nil)
            }
        case .waitingToPlayAtSpecifiedRate:
            set { $0.buffering = true; if $0.status != .loading { $0.status = .buffering } }
        @unknown default: break
        }
        updateNowPlayingInfo()
    }

    private var beaconNow: Double { Date().timeIntervalSince(beaconClock) }
    private var kbps: Int? {
        guard let e = item?.accessLog()?.events.last, e.indicatedBitrate > 0 else { return nil }
        return Int((e.indicatedBitrate / 1000).rounded())
    }

    /// The state from the engine, every half second (Derive.run, tested in the core).
    private func derive() {
        guard let pi = item else { return }
        let ct = pi.currentTime().seconds
        let cur = ct.isFinite ? ct : 0
        let live = pi.duration.isIndefinite
        var window: SeekWindow?
        if let r = pi.seekableTimeRanges.last?.timeRangeValue, r.duration.seconds.isFinite {
            window = SeekWindow(start: r.start.seconds, end: r.end.seconds)
        }
        // Wall clock of media time 0, from PROGRAM-DATE-TIME (AVPlayerItem.currentDate()).
        if let d = pi.currentDate() { presentationStart = d.timeIntervalSince1970 * 1000 - cur * 1000 }
        let snap = EngineSnapshot(currentTime: cur, duration: live ? .nan : pi.duration.seconds, live: live, seekable: window,
                                  presentationStart: presentationStart)
        let horizon = cur - 3600
        Triggers.merge(&graphics, [], horizon: horizon)
        let d = Derive.run(DeriveInput(
            engine: snap, now: Date().timeIntervalSince1970 * 1000, schedule: state.schedule, graphics: Array(graphics.values),
            graphicsOn: options.showGraphics ?? theme.showGraphics, upNextOn: theme.controls.upNext, skipOn: theme.controls.skip,
            upNextSeconds: theme.upNextSeconds, autoAdvance: theme.autoAdvance, items: state.items, index: state.index, dismissed: dismissed))
        beacons?.time(cur, paused: !state.playing)
        beacons?.tick(now: beaconNow, kbps: kbps)
        if d.programme?.id != lastProgrammeId {
            lastProgrammeId = d.programme?.id
            if let p = d.programme { emit(.programmechange, p) }
            #if os(tvOS)
            applyExternalMetadata(d.programme)
            #endif
        }
        if d.upNext != nil && state.upNext == nil { emit(.upnext, d.upNext) }
        let active = activeQuality()
        set {
            $0.currentTime = cur; $0.duration = snap.duration; $0.live = live; $0.seekable = window
            $0.dvr = d.dvr; $0.atLiveEdge = d.atLiveEdge; $0.behindLive = d.behindLive; $0.wallClock = d.wallClock
            $0.programme = d.programme; $0.nextProgramme = d.nextProgramme; $0.canStartOver = d.canStartOver
            $0.graphics = d.graphics; $0.adBreak = d.adBreak; $0.upNext = d.upNext; $0.skip = d.skip
            $0.activeQuality = active; $0.rate = Double(self.avPlayer.rate == 0 ? Float($0.rate) : self.avPlayer.rate)
            #if os(iOS)
            $0.pip.active = self.pip?.isPictureInPictureActive ?? false
            $0.pip.available = (self.pip?.isPictureInPicturePossible ?? false) || AVPictureInPictureController.isPictureInPictureSupported() && $0.hasPicture
            #endif
            if let ms = EventRules.msToStart($0.event, now: Date().timeIntervalSince1970 * 1000) { $0.msToStart = ms }
        }
        if let k = d.dismissKey { currentCardKey = k }
    }

    private var currentCardKey: String?

    private func activeQuality() -> Quality? {
        guard let br = item?.accessLog()?.events.last?.indicatedBitrate, br > 0, !state.qualities.isEmpty else { return nil }
        return state.qualities.min { abs($0.bitrate - br) < abs($1.bitrate - br) }
    }

    private func ended() {
        endBeacons()
        if !state.live, state.index + 1 < state.items.count, theme.autoAdvance, dismissed != "i:\(state.index)" {
            next(); return
        }
        set { $0.status = .ended; $0.playing = false }
        emit(.ended, nil)
    }

    private func fail(_ message: String, code: String?) {
        set { $0.status = .error; $0.playing = false; $0.buffering = false; $0.error = message; $0.errorCode = code }
        emit(.error, message)
    }

    private func readable(_ e: Error?) -> String {
        guard let e = e as NSError? else { return t("stopped") }
        if e.domain == NSURLErrorDomain { return e.code == NSURLErrorNotConnectedToInternet ? "You're offline." : t("stopped") }
        if e.code == -12938 || e.code == -1100 { return t("offline") } // 404 on the playlist: not on air
        return t("stopped")
    }

    private func wentToBackground() {
        // A video in the background has nobody watching; audio, PiP and AirPlay do.
        #if os(iOS)
        if state.hasPicture && !(pip?.isPictureInPictureActive ?? false) && !avPlayer.isExternalPlaybackActive { beacons?.end() }
        #else
        if state.hasPicture { beacons?.end() }
        #endif
    }

    private func endBeacons() { beacons?.end(); beacons = nil }

    // MARK: - Polling

    private func pollGuide(_ channelId: String) {
        guard let api else { return }
        tasks.append(Task { [weak self] in
            while !Task.isCancelled {
                // A player dropped without destroy() stops polling here.
                guard self != nil else { return }
                let g = await api.schedule(channelId: channelId)
                if !g.isEmpty { self?.set { $0.schedule = g } }
                try? await Task.sleep(nanoseconds: 5 * 60 * 1_000_000_000)
            }
        })
    }

    private func pollNowPlaying(_ stationId: String) {
        guard let api else { return }
        tasks.append(Task { [weak self] in
            while !Task.isCancelled {
                guard self != nil else { return }
                if let np = await api.nowPlaying(stationId: stationId) {
                    self?.set { $0.nowPlaying = np.nowPlaying; $0.history = np.history; $0.nextTrack = np.next }
                    self?.updateNowPlayingInfo()
                }
                try? await Task.sleep(nanoseconds: 15 * 1_000_000_000)
            }
        })
    }

    @discardableResult
    private func pollEvent() async -> EventInfo? {
        guard let id = options.eventId, let api else { return nil }
        let e = await api.event(id: id)
        if let e {
            let now = Date().timeIntervalSince1970 * 1000
            let was = state.presentation
            set { $0.event = e; $0.presentation = e.presentation; $0.msToStart = EventRules.msToStart(e, now: now) }
            if was != e.presentation {
                emit(.presentationchange, e.presentation.rawValue)
                // No longer live, and the replay is not what is playing: stop, so no sound carries on
                // behind the promo screen. The next live phase loads afresh.
                if was == .live && !state.replaying {
                    stopItem(); endBeacons(); loadTask?.cancel()
                    liveLoadStarted = false
                    set { $0.status = .idle; $0.playing = false; $0.buffering = false }
                }
            }
            // Live: load the stream once for this phase, whether this is the first answer (an
            // earlier call may have failed) or a change. The phase came from the control plane.
            if e.presentation == .live && !liveLoadStarted && !state.replaying && item == nil && !state.items.isEmpty {
                liveLoadStarted = true
                load(index: state.index)
            }
        }
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            let delay = EventRules.pollDelay(presentation: self?.state.presentation, msToStart: self?.state.msToStart)
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if !Task.isCancelled { await self?.pollEvent() }
        }
        return e
    }

    // MARK: - Commands

    public func play() {
        if state.status == .error || state.status == .offline || item == nil { load(index: state.index); return }
        if state.status == .ended { seek(0) }
        avPlayer.play()
    }
    public func pause() { avPlayer.pause() }
    public func toggle() { state.playing ? pause() : play() }
    public func seek(_ seconds: Double) {
        beacons?.seeking()
        avPlayer.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }
    public func seekBy(_ delta: Double) {
        var to = state.currentTime + delta
        if let w = state.seekable { to = min(max(w.start, to), w.end) }
        seek(to)
    }
    public func goLive() {
        guard let end = item?.seekableTimeRanges.last?.timeRangeValue.end else { return }
        beacons?.seeking()
        avPlayer.seek(to: end)
        avPlayer.play()
    }
    public func adClick() { /* On-demand ad overlay: not in this release (guided ads play natively). */ }
    public func startOver() {
        guard let p = state.programme,
              let r = Schedule.startOverTarget(programmeStart: p.startsAt, presentationStart: presentationStart, seekable: state.seekable) else { return }
        seek(r.seconds)
    }
    public func setQuality(_ id: String) {
        guard let pi = item else { return }
        if id == "auto" {
            pi.preferredPeakBitRate = 0
            pi.preferredMaximumResolution = .zero
        } else if let q = state.qualities.first(where: { $0.id == id }) {
            // AVPlayer cannot pin a variant: cap it, and the best at or under the cap plays.
            pi.preferredPeakBitRate = q.bitrate * 1.05
            if let w = q.width, let h = q.height { pi.preferredMaximumResolution = CGSize(width: w, height: h) }
        }
        set { $0.quality = id }
        emit(.qualitychange, id)
    }
    public func setTextTrack(_ id: String?) {
        guard let pi = item else { return }
        Task { [weak self] in
            guard let self, let asset = pi.asset as? AVURLAsset, let g = await Self.group(asset, .legible) else { return }
            if let id, let i = Int(id), i < g.options.count { pi.select(g.options[i], in: g) } else { pi.select(nil, in: g) }
            self.set { $0.textTrack = id }
        }
    }
    public func setAudioTrack(_ id: String) {
        guard let pi = item else { return }
        Task { [weak self] in
            guard let self, let asset = pi.asset as? AVURLAsset, let g = await Self.group(asset, .audible), let i = Int(id), i < g.options.count else { return }
            pi.select(g.options[i], in: g)
            self.set { $0.audioTrack = id }
        }
    }
    public func setVolume(_ v: Double) { avPlayer.volume = Float(min(1, max(0, v))); set { $0.volume = min(1, max(0, v)) } }
    public func toggleMute() { avPlayer.isMuted.toggle(); set { $0.muted = self.avPlayer.isMuted } }
    public func setRate(_ r: Double) {
        if #available(iOS 16, tvOS 16, *) { avPlayer.defaultRate = Float(r) }
        if state.playing { avPlayer.rate = Float(r) }
        set { $0.rate = r }
    }
    public func next() { if state.index + 1 < state.items.count { load(index: state.index + 1) } }
    public func previous() {
        if state.currentTime > 5 || state.index == 0 { seek(0) } else { load(index: state.index - 1) }
    }
    public func playItem(_ index: Int) { load(index: index) }
    public func cancelUpNext() { dismissed = currentCardKey; set { $0.upNext = nil } }
    public func skip() {
        guard let s = state.skip else { return }
        if s.kind == "credits" && state.index + 1 < state.items.count { next() } else { seek(s.to) }
    }
    /// A TV is always full screen: nothing to toggle there.
    public func toggleFullscreen() {
        #if os(iOS)
        set { $0.fullscreen.toggle() }
        #endif
    }
    public func togglePip() {
        #if os(iOS)
        guard let p = pip else { return }
        p.isPictureInPictureActive ? p.stopPictureInPicture() : p.startPictureInPicture()
        #endif
    }
    /// Chromecast needs the Google Cast SDK in the app; this release reports it unavailable.
    public func cast() {}
    /// AirPlay is chosen from the system route picker (RoutePickerButton in the skin).
    public func airplay() {}
    public func purchase(_ productKey: String) {
        let p = state.access.products.first { $0.productKey == productKey }
        #if os(tvOS)
        // A TV has no browser: the app takes the viewer through its own checkout.
        emit(.purchase, ["productKey": productKey, "assetId": state.item?.assetId as Any,
                         "price": p.map { Double($0.priceCents) / 100 } as Any, "currency": p?.currency as Any])
        #else
        if let tpl = options.purchaseUrl, let u = URL(string: Gate.fillUrl(tpl, [
            "productKey": productKey, "assetId": state.item?.assetId ?? options.eventId,
            "price": p.map { String(format: "%.2f", Double($0.priceCents) / 100) }, "currency": p?.currency])) {
            UIApplication.shared.open(u)
        } else { emit(.purchase, ["productKey": productKey, "assetId": state.item?.assetId as Any]) }
        #endif
    }
    public func signIn() {
        #if os(tvOS)
        // A TV signs in with a code shown on screen and confirmed on a phone: the app's job.
        emit(.signin, ["assetId": state.item?.assetId as Any])
        #else
        if let tpl = options.signInUrl, let u = URL(string: Gate.fillUrl(tpl, ["assetId": state.item?.assetId ?? options.eventId])) {
            UIApplication.shared.open(u)
        } else { emit(.signin, ["assetId": state.item?.assetId as Any]) }
        #endif
    }
    public func playReplay() {
        guard let r = state.event?.replayAssetId else { return }
        state.items = [PlaylistItem(id: r, assetId: r)]
        set { $0.replaying = true }
        load(index: 0)
    }
    public func refreshAccess() { item = nil; load(index: state.index) }
    public func toggleStats(_ on: Bool? = nil) { set { $0.stats = on ?? !$0.stats }; emit(.statschange, state.stats) }

    /// Change the viewer (after sign-in or a purchase) and ask the gate again.
    public func setViewerToken(_ token: String?) {
        options.viewerToken = token
        refreshAccess()
    }

    /// The console's live preview: change the theme without reloading.
    public func setTheme(_ theme: Theme?) { self.theme = ThemeTokens.resolve(options.theme, theme) }
    public func setSkin(_ id: String) { skinId = id }

    /// Stop everything: beacons end, polling stops, the player lets go of the stream.
    public func destroy() {
        endBeacons()
        tasks.forEach { $0.cancel() }; tasks = []
        eventTask?.cancel(); loadTask?.cancel()
        stopItem()
        if let o = timeObserver { avPlayer.removeTimeObserver(o); timeObserver = nil }
        kvo.forEach { $0.invalidate() }; kvo = []
        observers.forEach { NotificationCenter.default.removeObserver($0) }; observers = []
        avPlayer.replaceCurrentItem(with: nil)
        item = nil
    }

    // MARK: - Picture in picture (the view hands over its layer)

    func attachLayer(_ layer: AVPlayerLayer) {
        guard playerLayer !== layer else { return }
        playerLayer = layer
        #if os(iOS)
        if AVPictureInPictureController.isPictureInPictureSupported() {
            pip = AVPictureInPictureController(playerLayer: layer)
            if #available(iOS 14.2, *) { pip?.canStartPictureInPictureAutomaticallyFromInline = true }
        }
        #endif
    }

    #if os(tvOS)
    // MARK: - The system info panel (tvOS)

    /// Title, the programme on air and its description for the info panel of AVPlayerViewController.
    /// The programme is passed in, never read from the state: on a programme change the state still
    /// holds the one that just ended. nil means no programme: the item's own title.
    private func applyExternalMetadata(_ programme: Programme?) {
        guard let pi = item else { return }
        let p = programme
        func meta(_ id: AVMetadataIdentifier, _ value: String?) -> AVMetadataItem? {
            guard let value, !value.isEmpty else { return nil }
            let m = AVMutableMetadataItem()
            m.identifier = id
            m.value = value as NSString
            m.extendedLanguageTag = "und"
            return m.copy() as? AVMetadataItem
        }
        let title = p?.title ?? state.item?.title
        let sub = p != nil ? state.item?.title : state.item?.subtitle
        let desc = p?.description ?? state.item?.description
        pi.externalMetadata = [meta(.commonIdentifierTitle, title), meta(.iTunesMetadataTrackSubTitle, sub),
                               meta(.commonIdentifierDescription, desc)].compactMap { $0 }
        let art = p?.imageUrl ?? state.item?.artworkUrl
        guard let a = art, let url = URL(string: a, relativeTo: options.apiBase)?.absoluteURL else { return }
        Task { [weak self] in
            guard let r = try? await URLSession.shared.data(from: url), let self, self.item === pi else { return }
            let m = AVMutableMetadataItem()
            m.identifier = .commonIdentifierArtwork
            m.value = r.0 as NSData
            m.dataType = kCMMetadataBaseDataType_JPEG as String
            m.extendedLanguageTag = "und"
            if let c = m.copy() as? AVMetadataItem { pi.externalMetadata.append(c) }
        }
    }

    /// Ad breaks play through: the system transport bar may not skip them.
    var requiresLinearPlayback: Bool { state.adBreak != nil }
    #endif

    // MARK: - Lock screen and Control Center

    private func setUpRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        // Remote command handlers run on the main thread.
        c.playCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.play() }; return .success }
        c.pauseCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.pause() }; return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.toggle() }; return .success }
    }

    private func updateNowPlayingInfo() {
        guard options.lockScreen else { return }
        var info: [String: Any] = [:]
        if let np = state.nowPlaying {
            info[MPMediaItemPropertyTitle] = np.title
            if let a = np.artist { info[MPMediaItemPropertyArtist] = a }
            if let a = np.album { info[MPMediaItemPropertyAlbumTitle] = a }
        } else {
            info[MPMediaItemPropertyTitle] = state.programme?.title ?? state.item?.title ?? ""
            if let s = state.item?.title, state.programme != nil { info[MPMediaItemPropertyArtist] = s }
        }
        info[MPNowPlayingInfoPropertyIsLiveStream] = state.live
        info[MPNowPlayingInfoPropertyPlaybackRate] = state.playing ? state.rate : 0
        if !state.live && state.duration.isFinite { info[MPMediaItemPropertyPlaybackDuration] = state.duration; info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = state.currentTime }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    // MARK: - Plumbing

    func set(_ change: (inout PlayerState) -> Void) {
        var s = state
        change(&s)
        if s != state { state = s; emit(.state, nil) }
    }

    func emit(_ name: PlayerEventName, _ detail: Any?) {
        guard name != .state || options.onEvent != nil else { return }
        options.onEvent?(name, detail)
    }
}

// MARK: - In-stream triggers and timed ID3

extension VoltPlayer: AVPlayerItemMetadataCollectorPushDelegate, AVPlayerItemMetadataOutputPushDelegate {
    nonisolated public func metadataCollector(_ metadataCollector: AVPlayerItemMetadataCollector,
                                              didCollect metadataGroups: [AVDateRangeMetadataGroup],
                                              indexesOfNewGroups: IndexSet, indexesOfModifiedGroups: IndexSet) {
        let ranges: [Triggers.DateRange] = metadataGroups.compactMap { g in
            var attrs: [String: String] = [:]
            for it in g.items {
                guard let k = (it.key as? String) ?? it.identifier?.rawValue else { continue }
                if let s = it.stringValue { attrs[k] = s } else if let n = it.numberValue { attrs[k] = n.stringValue }
            }
            return Triggers.DateRange(id: g.uniqueID ?? "", cls: g.classifyingLabel ?? attrs["CLASS"] ?? "",
                                      startDate: g.startDate.timeIntervalSince1970 * 1000,
                                      endDate: g.endDate.map { $0.timeIntervalSince1970 * 1000 }, attributes: attrs)
        }
        MainActor.assumeIsolated {
            guard let ps = self.presentationStart ?? self.item?.currentDate().map({ $0.timeIntervalSince1970 * 1000 - (self.item?.currentTime().seconds ?? 0) * 1000 }) else { return }
            self.presentationStart = ps
            Triggers.merge(&self.graphics, Triggers.graphics(from: ranges, presentationStart: ps))
        }
    }

    nonisolated public func metadataOutput(_ output: AVPlayerItemMetadataOutput, didOutputTimedMetadataGroups groups: [AVTimedMetadataGroup],
                                           from track: AVPlayerItemTrack?) {
        var title: String?, artist: String?, album: String?
        for g in groups {
            for it in g.items {
                switch it.commonKey {
                case .some(.commonKeyTitle): title = it.stringValue ?? title
                case .some(.commonKeyArtist): artist = it.stringValue ?? artist
                case .some(.commonKeyAlbumName): album = it.stringValue ?? album
                default: break
                }
            }
        }
        guard let title, !title.isEmpty else { return }
        MainActor.assumeIsolated {
            // The station's own now-playing feed (stationId) is richer; the stream's tag fills in without one.
            guard self.options.stationId == nil else { return }
            self.set { $0.nowPlaying = TrackInfo(title: title, artist: artist, album: album, startedAt: Date().timeIntervalSince1970 * 1000) }
            self.updateNowPlayingInfo()
        }
    }
}
#endif
