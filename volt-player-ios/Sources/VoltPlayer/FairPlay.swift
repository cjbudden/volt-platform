#if os(iOS) || os(tvOS)
// ============================================================================
//  FAIRPLAY STREAMING: the standard AVContentKeySession exchange.
//
//    1. AVFoundation meets an encrypted segment and asks for a key
//       (skd:// URI in the playlist's EXT-X-KEY).
//    2. We fetch the application certificate once and ask AVFoundation for
//       the SPC (server playback context) for that key.
//    3. The SPC goes to the licence server (FairPlayConfig.licenseUrl, with
//       its headers, e.g. the entitlement token); the answer is the CKC.
//    4. The CKC goes back to AVFoundation and playback continues.
//
//  The licence server's body format varies by DRM vendor. This sends the raw
//  SPC with content-type application/octet-stream and accepts a raw CKC, or
//  JSON {"ckc": base64} which several vendors (Axinom among them) answer.
// ============================================================================
import AVFoundation
import Foundation

final class FairPlayDelegate: NSObject, AVContentKeySessionDelegate {
    let config: FairPlayConfig
    let assetId: String?
    private var certificate: Data?

    init(config: FairPlayConfig, assetId: String?) { self.config = config; self.assetId = assetId }

    func contentKeySession(_ session: AVContentKeySession, didProvide keyRequest: AVContentKeyRequest) {
        handle(keyRequest)
    }

    func contentKeySession(_ session: AVContentKeySession, didProvideRenewingContentKeyRequest keyRequest: AVContentKeyRequest) {
        handle(keyRequest)
    }

    func contentKeySession(_ session: AVContentKeySession, contentKeyRequest keyRequest: AVContentKeyRequest, didFailWithError err: Error) {}

    private func handle(_ req: AVContentKeyRequest) {
        guard let skd = req.identifier as? String, let contentId = skd.replacingOccurrences(of: "skd://", with: "").data(using: .utf8) else {
            req.processContentKeyResponseError(NSError(domain: "VoltFairPlay", code: 1, userInfo: [NSLocalizedDescriptionKey: "No key identifier"]))
            return
        }
        Task {
            do {
                let cert = try await self.loadCertificate()
                let spc = try await req.makeStreamingContentKeyRequestData(forApp: cert, contentIdentifier: contentId, options: nil)
                let ckc = try await self.license(spc: spc)
                req.processContentKeyResponse(AVContentKeyResponse(fairPlayStreamingKeyResponseData: ckc))
            } catch {
                req.processContentKeyResponseError(error)
            }
        }
    }

    private func loadCertificate() async throws -> Data {
        if let c = certificate { return c }
        var r = URLRequest(url: config.certificateUrl)
        for (k, v) in config.headers { r.setValue(v, forHTTPHeaderField: k) }
        let (d, _) = try await URLSession.shared.data(for: r)
        certificate = d
        return d
    }

    private func license(spc: Data) async throws -> Data {
        var r = URLRequest(url: config.licenseUrl)
        r.httpMethod = "POST"
        r.httpBody = spc
        r.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        for (k, v) in config.headers { r.setValue(v, forHTTPHeaderField: k) }
        let (d, resp) = try await URLSession.shared.data(for: r)
        guard (resp as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false else {
            throw NSError(domain: "VoltFairPlay", code: 2, userInfo: [NSLocalizedDescriptionKey: "The licence server refused the request"])
        }
        if let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let b = j["ckc"] as? String, let ckc = Data(base64Encoded: b) {
            return ckc
        }
        return d
    }
}
#endif
