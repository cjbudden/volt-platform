#if os(iOS) || os(tvOS)
// ============================================================================
//  PANELS every skin may show, on iPhone, iPad and Apple TV: the paywall,
//  sign in or region message (LockedPanel), and debug mode (StatsPanel).
// ============================================================================
import SwiftUI
#if os(iOS)
import UIKit
#endif
import VoltPlayerCore

/// The paywall, sign in, or the region message: at any phase.
struct LockedPanel: View {
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    let access: AccessState
    let commands: VoltCommands
    var body: some View {
        VStack(spacing: 12) {
            if access.mode == .paywall {
                Text(t("buyTitle")).font(s.font(18 * voltUIScale, .bold)).foregroundColor(s.text)
                ForEach(access.products) { p in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(p.name ?? Gate.fmtTerm(p)).font(s.font(14 * voltUIScale, .semibold)).foregroundColor(s.text)
                            Text(Gate.fmtTerm(p)).font(s.font(12 * voltUIScale)).foregroundColor(s.muted)
                        }
                        Spacer()
                        Button("\(t("buy")) \(Gate.fmtPrice(cents: p.priceCents, currency: p.currency))") { commands.purchase(p.productKey) }
                            .font(s.font(13 * voltUIScale, .bold)).foregroundColor(s.primaryInk)
                            .padding(.horizontal, 12).padding(.vertical, 7).background(Capsule().fill(s.primary))
                            .voltTVFocus()
                    }
                    .padding(10).background(RoundedRectangle(cornerRadius: s.radius).fill(s.secondary.opacity(0.9)))
                }
                Button(t("alreadyBought")) { commands.refreshAccess() }.font(s.font(12 * voltUIScale)).foregroundColor(s.muted).voltTVFocus()
            } else if access.mode == .sign_in {
                Text(t("signInTitle")).font(s.font(18 * voltUIScale, .bold)).foregroundColor(s.text)
                Button(t("signIn")) { commands.signIn() }.font(s.font(14 * voltUIScale, .bold)).foregroundColor(s.primaryInk)
                    .padding(.horizontal, 16).padding(.vertical, 9).background(Capsule().fill(s.primary))
                    .voltTVFocus()
            } else {
                Text(access.message ?? t("regionBlocked")).font(s.font(15 * voltUIScale, .medium)).foregroundColor(s.text).multilineTextAlignment(.center)
            }
        }
        .padding(20).frame(maxWidth: 420 * voltUIScale)
    }
}

/// Debug mode: what is playing and how, for support.
struct StatsPanel: View {
    @Environment(\.voltStyle) var s
    @Environment(\.voltT) var t
    let state: PlayerState
    let close: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack { Text(t("playbackStats")).font(.system(size: 12 * voltUIScale, weight: .bold)); Spacer(); Button(action: close) { Image(systemName: "xmark") }.voltTVFocus() }
            row(t("resolution"), state.activeQuality?.label ?? "-")
            row(t("bitrate"), state.activeQuality.map { "\(Int($0.bitrate / 1000)) kbps" } ?? "-")
            row(t("latency"), state.live ? Schedule.fmtTime(state.behindLive) : "-")
            row("Status", state.status.rawValue)
            row("Item", state.item?.assetId ?? state.item?.id ?? "-")
            row("SDK", "ios/\(VoltSDK.version)")
            #if os(iOS)
            Button(t("copyDebug")) {
                UIPasteboard.general.string = "status=\(state.status.rawValue) item=\(state.item?.id ?? "") q=\(state.activeQuality?.label ?? "") behind=\(state.behindLive) error=\(state.error ?? "") sdk=ios/\(VoltSDK.version)"
            }.font(.system(size: 11, weight: .semibold))
            #endif
        }
        .font(.system(size: 11 * voltUIScale).monospaced()).foregroundColor(.white)
        .padding(10).background(Color.black.opacity(0.8)).cornerRadius(8).frame(maxWidth: 280 * voltUIScale)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(10)
    }
    func row(_ k: String, _ v: String) -> some View { HStack { Text(k).opacity(0.7); Spacer(); Text(v) } }
}
#endif
