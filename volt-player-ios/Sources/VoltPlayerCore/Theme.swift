// ============================================================================
//  THEME TOKENS: the no-code half of a custom skin.
//
//  A port of volt-player/src/sdk/theme.ts, rule for rule, so a theme saved in
//  the console (Player setup) resolves to exactly the same colours, corners and
//  toggles on iOS as in a browser:
//
//    primary / primaryInk      buttons, progress, the live dot
//    secondary / secondaryInk  chips, cards, the up-next panel
//    background / text / muted the chrome itself
//    radius, font
//
//  Text is always readable: a chosen text colour is kept only at 3:1 contrast
//  on the background, otherwise black or white is used.
// ============================================================================
import Foundation

/// A theme as saved in the console. Every field optional: layers are merged.
public struct Theme: Codable, Equatable, Sendable {
    public enum LogoPosition: String, Codable, Sendable { case topLeft = "top-left", topRight = "top-right", bottomRight = "bottom-right", none }
    public var primary: String?
    public var secondary: String?
    public var background: String?
    public var text: String?
    public var radius: Double?
    public var font: String?
    public var logoUrl: String?
    public var logoPosition: LogoPosition?
    public var upNextSeconds: Double?
    public var showGraphics: Bool?
    public var autoAdvance: Bool?
    /// Only the toggles given; the rest keep their defaults.
    public var controls: [String: Bool]?
    /// The focus ring on TV and keyboard. Kept only at 3:1 on the background.
    public var focusColor: String?
    /// Seconds for the skip buttons and the remote's left and right: 10, 15 or 30.
    public var seekStep: Double?
    public init(primary: String? = nil, secondary: String? = nil, background: String? = nil, text: String? = nil,
                radius: Double? = nil, font: String? = nil, logoUrl: String? = nil, logoPosition: LogoPosition? = nil,
                upNextSeconds: Double? = nil, showGraphics: Bool? = nil, autoAdvance: Bool? = nil, controls: [String: Bool]? = nil,
                focusColor: String? = nil, seekStep: Double? = nil) {
        self.primary = primary; self.secondary = secondary; self.background = background; self.text = text
        self.radius = radius; self.font = font; self.logoUrl = logoUrl; self.logoPosition = logoPosition
        self.upNextSeconds = upNextSeconds; self.showGraphics = showGraphics; self.autoAdvance = autoAdvance; self.controls = controls
        self.focusColor = focusColor; self.seekStep = seekStep
    }

    /// From a JSON object (a saved config's options.theme, or the console's live preview).
    public init(json: [String: Any]) {
        func s(_ k: String) -> String? { json[k] as? String }
        func d(_ k: String) -> Double? { (json[k] as? NSNumber)?.doubleValue ?? (json[k] as? String).flatMap(Double.init) }
        // An explicit null clears a logo an earlier layer set.
        let logo = json["logoUrl"] is NSNull ? "" : s("logoUrl")
        self.init(primary: s("primary"), secondary: s("secondary"), background: s("background"), text: s("text"),
                  radius: d("radius"), font: s("font"), logoUrl: logo,
                  logoPosition: s("logoPosition").flatMap(LogoPosition.init(rawValue:)),
                  upNextSeconds: d("upNextSeconds"), showGraphics: json["showGraphics"] as? Bool,
                  autoAdvance: json["autoAdvance"] as? Bool,
                  controls: (json["controls"] as? [String: Any])?.compactMapValues { $0 as? Bool },
                  focusColor: s("focusColor"), seekStep: d("seekStep"))
    }
}

/// Every token filled in. What a skin reads.
public struct ResolvedTheme: Equatable, Sendable {
    public var primary: String
    public var secondary: String
    public var background: String
    public var text: String
    public var primaryInk: String
    public var secondaryInk: String
    /// Secondary text on the chrome: white or near-black at reduced opacity.
    public var muted: String
    public var mutedOpacity: Double
    public var radius: Double
    /// The font family asked for, or nil for the system font.
    public var font: String?
    public var logoUrl: String?
    public var logoPosition: Theme.LogoPosition
    public var upNextSeconds: Double
    public var autoAdvance: Bool
    public var showGraphics: Bool
    public var controls: ControlToggles
    /// The focus ring colour, always readable (3:1) on the background.
    public var focusColor: String
    /// 10, 15 or 30 seconds.
    public var seekStep: Double
}

public enum ThemeTokens {
    public static let defaultPrimary = "#3f7bff"
    public static let defaultSecondary = "#0f1218"
    public static let darkInk = "#0b0e13"
    public static let lightInk = "#ffffff"

    public static func isHex(_ v: String?) -> Bool {
        guard let v = v?.trimmingCharacters(in: .whitespaces), v.count == 7, v.first == "#" else { return false }
        return v.dropFirst().allSatisfy { $0.isHexDigit }
    }

    /// Red, green and blue 0...255 of "#rrggbb".
    public static func rgb(_ hex: String) -> (Int, Int, Int) {
        let n = Int(hex.trimmingCharacters(in: .whitespaces).dropFirst(), radix: 16) ?? 0
        return ((n >> 16) & 255, (n >> 8) & 255, n & 255)
    }

    /// Relative luminance (WCAG).
    public static func luminance(_ hex: String) -> Double {
        let (r, g, b) = rgb(hex)
        func lin(_ v: Int) -> Double { let c = Double(v) / 255; return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    /// Black or white, whichever reads better on this colour (crossover at L = 0.179).
    public static func inkFor(_ hex: String) -> String {
        guard isHex(hex) else { return lightInk }
        return luminance(hex) > 0.179 ? darkInk : lightInk
    }

    public static func contrast(_ a: String, _ b: String) -> Double {
        let x = luminance(a), y = luminance(b)
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    /// Mix a colour toward white (w > 0) or black (w < 0).
    public static func shade(_ hex: String, _ w: Double) -> String {
        guard isHex(hex) else { return hex }
        let (r, g, b) = rgb(hex)
        let to = w >= 0 ? 255.0 : 0.0, k = abs(w)
        let c = [r, g, b].map { Int((Double($0) + (to - Double($0)) * k).rounded()) }
        return "#" + c.map { String(format: "%02x", $0) }.joined()
    }

    static func setControl(_ c: inout ControlToggles, _ key: String, _ v: Bool) {
        switch key {
        case "title": c.title = v
        case "seekButtons": c.seekButtons = v
        case "volume": c.volume = v
        case "quality": c.quality = v
        case "subtitles": c.subtitles = v
        case "audioTracks": c.audioTracks = v
        case "speed": c.speed = v
        case "pip": c.pip = v
        case "fullscreen": c.fullscreen = v
        case "cast": c.cast = v
        case "airplay": c.airplay = v
        case "startOver": c.startOver = v
        case "schedule": c.schedule = v
        case "upNext": c.upNext = v
        case "history": c.history = v
        case "skip": c.skip = v
        default: break
        }
    }

    /// Fill every token, keeping text readable whatever colours were chosen. Later layers win.
    public static func resolve(_ layers: Theme?...) -> ResolvedTheme { resolve(layers) }

    public static func resolve(_ layers: [Theme?]) -> ResolvedTheme {
        var t = Theme(primary: defaultPrimary, secondary: defaultSecondary, radius: 12, logoPosition: .topRight,
                      upNextSeconds: 15, showGraphics: true, autoAdvance: true)
        var controls = ControlToggles()
        for l in layers {
            guard let l else { continue }
            if let v = l.primary { t.primary = v }
            if let v = l.secondary { t.secondary = v }
            if let v = l.background { t.background = v }
            if let v = l.text { t.text = v }
            if let v = l.radius { t.radius = v }
            if let v = l.font { t.font = v }
            if let v = l.logoUrl { t.logoUrl = v }
            if let v = l.logoPosition { t.logoPosition = v }
            if let v = l.upNextSeconds { t.upNextSeconds = v }
            if let v = l.showGraphics { t.showGraphics = v }
            if let v = l.autoAdvance { t.autoAdvance = v }
            for (k, v) in l.controls ?? [:] { setControl(&controls, k, v) }
            if let v = l.focusColor { t.focusColor = v }
            if let v = l.seekStep { t.seekStep = v }
        }
        let primary = isHex(t.primary) ? t.primary! : defaultPrimary
        let secondary = isHex(t.secondary) ? t.secondary! : defaultSecondary
        let background = isHex(t.background) ? t.background! : secondary
        let text = isHex(t.text) && contrast(t.text!, background) >= 3 ? t.text! : inkFor(background)
        let radius = (t.radius?.isFinite ?? false) ? max(0, min(28, t.radius!)) : 12
        let upNext = (t.upNextSeconds?.isFinite ?? false) ? max(5, min(120, t.upNextSeconds!)) : 15
        let font = t.font?.trimmingCharacters(in: .whitespaces)
        // http(s), or a path on the Volt site (resolved against the API base by the view).
        // "" clears a logo an earlier layer set.
        let logo = t.logoUrl?.trimmingCharacters(in: .whitespaces)
        let logoOk = logo.map { l in
            let low = l.lowercased()
            return low.hasPrefix("https://") || low.hasPrefix("http://") || (l.hasPrefix("/") && !l.hasPrefix("//"))
        } ?? false
        return ResolvedTheme(
            primary: primary, secondary: secondary, background: background, text: text,
            primaryInk: inkFor(primary), secondaryInk: inkFor(secondary),
            muted: text == lightInk ? lightInk : darkInk, mutedOpacity: text == lightInk ? 0.66 : 0.62,
            radius: radius, font: (font?.isEmpty ?? true) ? nil : font,
            logoUrl: logoOk ? logo : nil, logoPosition: t.logoPosition ?? .topRight,
            upNextSeconds: upNext, autoAdvance: t.autoAdvance != false, showGraphics: t.showGraphics != false,
            controls: controls,
            focusColor: focusColorFor(t.focusColor, primary: primary, background: background),
            seekStep: snapSeekStep(t.seekStep))
    }

    /// The seek steps a theme may choose.
    public static let seekSteps: [Double] = [10, 15, 30]

    /// The nearest of 10, 15 and 30 (a tie goes to the smaller); 10 when missing.
    public static func snapSeekStep(_ v: Double?) -> Double {
        guard let v, v.isFinite else { return 10 }
        var best = seekSteps[0]
        for s in seekSteps where abs(s - v) < abs(best - v) { best = s }
        return best
    }

    /// The focus ring: the chosen colour at 3:1 on the background, else primary at 3:1, else black or white.
    public static func focusColorFor(_ chosen: String?, primary: String, background: String) -> String {
        if let c = chosen?.trimmingCharacters(in: .whitespaces), isHex(c), contrast(c, background) >= 3 { return c }
        if contrast(primary, background) >= 3 { return primary }
        return inkFor(background)
    }

    /// The theme a saved player config describes: the two original colour columns,
    /// then everything newer in options.theme (so an old config still resolves).
    public static func fromConfig(_ cfg: [String: Any]?) -> Theme {
        guard let cfg else { return Theme() }
        var t = Theme(json: ((cfg["options"] as? [String: Any])?["theme"] as? [String: Any]) ?? [:])
        if t.primary == nil { t.primary = cfg["primaryColor"] as? String }
        if t.secondary == nil { t.secondary = cfg["secondaryColor"] as? String }
        return t
    }
}
