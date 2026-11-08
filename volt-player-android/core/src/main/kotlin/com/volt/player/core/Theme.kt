// ============================================================================
//  THEME TOKENS: the no-code half of a custom skin.
//
//  A port of volt-player/src/sdk/theme.ts, rule for rule (and of the Swift
//  ThemeTokens), so a theme saved in the console (Player setup) resolves to
//  exactly the same colours, corners and toggles on Android as in a browser.
//
//  Text is always readable: a chosen text colour is kept only at 3:1 contrast
//  on the background, otherwise black or white is used. The same holds for the
//  focus ring on TVs (focusColor).
// ============================================================================
package com.volt.player.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/** A theme as saved in the console. Every field optional: layers are merged. */
data class Theme(
    val primary: String? = null,
    val secondary: String? = null,
    val background: String? = null,
    val text: String? = null,
    val radius: Double? = null,
    val font: String? = null,
    val logoUrl: String? = null,
    val logoPosition: LogoPosition? = null,
    val upNextSeconds: Double? = null,
    val showGraphics: Boolean? = null,
    val autoAdvance: Boolean? = null,
    /** Only the toggles given; the rest keep their defaults. */
    val controls: Map<String, Boolean>? = null,
    /** The focus ring on TVs and keyboards (proposed token). Kept at 3:1 on the background. */
    val focusColor: String? = null,
    /** Seconds for the skip buttons and remote left/right: 10, 15 or 30 (proposed token). */
    val seekStep: Double? = null,
) {
    enum class LogoPosition(val wire: String) {
        TopLeft("top-left"), TopRight("top-right"), BottomRight("bottom-right"), None("none");
        companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } }
    }

    companion object {
        /** From a JSON object (a saved config's options.theme, or the console's live preview). */
        fun fromJson(json: JsonObject): Theme {
            fun s(k: String) = (json[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
            fun d(k: String) = (json[k] as? JsonPrimitive)?.let { it.doubleOrNull ?: it.content.toDoubleOrNull() }
            fun b(k: String) = (json[k] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
            // An explicit null clears a logo an earlier layer set.
            val logo = if (json["logoUrl"] is JsonNull) "" else s("logoUrl")
            val controls = (json["controls"] as? JsonObject)?.mapNotNull { (k, v) ->
                (v as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull?.let { k to it }
            }?.toMap()
            return Theme(
                primary = s("primary"), secondary = s("secondary"), background = s("background"), text = s("text"),
                radius = d("radius"), font = s("font"), logoUrl = logo, logoPosition = LogoPosition.of(s("logoPosition")),
                upNextSeconds = d("upNextSeconds"), showGraphics = b("showGraphics"), autoAdvance = b("autoAdvance"),
                controls = controls, focusColor = s("focusColor"), seekStep = d("seekStep"),
            )
        }
    }
}

/** Every token filled in. What a skin reads. */
data class ResolvedTheme(
    val primary: String,
    val secondary: String,
    val background: String,
    val text: String,
    val primaryInk: String,
    val secondaryInk: String,
    /** Secondary text on the chrome: white or near-black at reduced opacity. */
    val muted: String,
    val mutedOpacity: Double,
    val radius: Double,
    /** The font family asked for, or null for the system font. */
    val font: String?,
    val logoUrl: String?,
    val logoPosition: Theme.LogoPosition,
    val upNextSeconds: Double,
    val autoAdvance: Boolean,
    val showGraphics: Boolean,
    val controls: ControlToggles,
    val focusColor: String,
    val seekStep: Double,
)

object ThemeTokens {
    const val DEFAULT_PRIMARY = "#3f7bff"
    const val DEFAULT_SECONDARY = "#0f1218"
    const val DARK_INK = "#0b0e13"
    const val LIGHT_INK = "#ffffff"
    val SEEK_STEPS = listOf(10.0, 15.0, 30.0)

    fun isHex(v: String?): Boolean {
        val s = v?.trim() ?: return false
        return s.length == 7 && s[0] == '#' && s.drop(1).all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }
    }

    /** Red, green and blue 0..255 of "#rrggbb". */
    fun rgb(hex: String): Triple<Int, Int, Int> {
        val n = hex.trim().drop(1).toIntOrNull(16) ?: 0
        return Triple((n shr 16) and 255, (n shr 8) and 255, n and 255)
    }

    /** Relative luminance (WCAG). */
    fun luminance(hex: String): Double {
        val (r, g, b) = rgb(hex)
        fun lin(v: Int): Double { val c = v / 255.0; return if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4) }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    /** Black or white, whichever reads better on this colour (crossover at L = 0.179). */
    fun inkFor(hex: String): String = if (!isHex(hex)) LIGHT_INK else if (luminance(hex) > 0.179) DARK_INK else LIGHT_INK

    fun contrast(a: String, b: String): Double {
        val x = luminance(a); val y = luminance(b)
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    /** Mix a colour toward white (w > 0) or black (w < 0). */
    fun shade(hex: String, w: Double): String {
        if (!isHex(hex)) return hex
        val (r, g, b) = rgb(hex)
        val to = if (w >= 0) 255.0 else 0.0
        val k = abs(w)
        return "#" + listOf(r, g, b).joinToString("") { "%02x".format((it + (to - it) * k).roundToInt()) }
    }

    /** 10, 15 or 30: the nearest, ties to the smaller. 10 when missing. */
    fun snapSeekStep(v: Double?): Double {
        if (v == null || !v.isFinite()) return 10.0
        return SEEK_STEPS.minWith(compareBy<Double> { abs(it - v) }.thenBy { it })
    }

    private fun ControlToggles.with(key: String, v: Boolean): ControlToggles = when (key) {
        "title" -> copy(title = v)
        "seekButtons" -> copy(seekButtons = v)
        "volume" -> copy(volume = v)
        "quality" -> copy(quality = v)
        "subtitles" -> copy(subtitles = v)
        "audioTracks" -> copy(audioTracks = v)
        "speed" -> copy(speed = v)
        "pip" -> copy(pip = v)
        "fullscreen" -> copy(fullscreen = v)
        "cast" -> copy(cast = v)
        "airplay" -> copy(airplay = v)
        "startOver" -> copy(startOver = v)
        "schedule" -> copy(schedule = v)
        "upNext" -> copy(upNext = v)
        "history" -> copy(history = v)
        "skip" -> copy(skip = v)
        else -> this
    }

    /** Fill every token, keeping text readable whatever colours were chosen. Later layers win. */
    fun resolve(vararg layers: Theme?): ResolvedTheme = resolve(layers.toList())

    fun resolve(layers: List<Theme?>): ResolvedTheme {
        var t = Theme(primary = DEFAULT_PRIMARY, secondary = DEFAULT_SECONDARY, radius = 12.0, logoPosition = Theme.LogoPosition.TopRight,
            upNextSeconds = 15.0, showGraphics = true, autoAdvance = true)
        var controls = ControlToggles()
        for (l in layers) {
            if (l == null) continue
            t = t.copy(
                primary = l.primary ?: t.primary, secondary = l.secondary ?: t.secondary, background = l.background ?: t.background,
                text = l.text ?: t.text, radius = l.radius ?: t.radius, font = l.font ?: t.font, logoUrl = l.logoUrl ?: t.logoUrl,
                logoPosition = l.logoPosition ?: t.logoPosition, upNextSeconds = l.upNextSeconds ?: t.upNextSeconds,
                showGraphics = l.showGraphics ?: t.showGraphics, autoAdvance = l.autoAdvance ?: t.autoAdvance,
                focusColor = l.focusColor ?: t.focusColor, seekStep = l.seekStep ?: t.seekStep,
            )
            for ((k, v) in l.controls.orEmpty()) controls = controls.with(k, v)
        }
        val primary = if (isHex(t.primary)) t.primary!! else DEFAULT_PRIMARY
        val secondary = if (isHex(t.secondary)) t.secondary!! else DEFAULT_SECONDARY
        val background = if (isHex(t.background)) t.background!! else secondary
        val text = if (isHex(t.text) && contrast(t.text!!, background) >= 3) t.text!! else inkFor(background)
        val radius = t.radius?.takeIf { it.isFinite() }?.coerceIn(0.0, 28.0) ?: 12.0
        val upNext = t.upNextSeconds?.takeIf { it.isFinite() }?.coerceIn(5.0, 120.0) ?: 15.0
        val font = t.font?.trim()
        // http(s), or a path on the Volt site (resolved against the API base by the view).
        // "" clears a logo an earlier layer set.
        val logo = t.logoUrl?.trim()
        val logoOk = logo != null && run {
            val low = logo.lowercase()
            low.startsWith("https://") || low.startsWith("http://") || (logo.startsWith("/") && !logo.startsWith("//"))
        }
        val focus = when {
            isHex(t.focusColor) && contrast(t.focusColor!!, background) >= 3 -> t.focusColor!!
            contrast(primary, background) >= 3 -> primary
            else -> inkFor(background)
        }
        return ResolvedTheme(
            primary = primary, secondary = secondary, background = background, text = text,
            primaryInk = inkFor(primary), secondaryInk = inkFor(secondary),
            muted = if (text == LIGHT_INK) LIGHT_INK else DARK_INK, mutedOpacity = if (text == LIGHT_INK) 0.66 else 0.62,
            radius = radius, font = if (font.isNullOrEmpty()) null else font,
            logoUrl = if (logoOk) logo else null, logoPosition = t.logoPosition ?: Theme.LogoPosition.TopRight,
            upNextSeconds = upNext, autoAdvance = t.autoAdvance != false, showGraphics = t.showGraphics != false,
            controls = controls, focusColor = focus, seekStep = snapSeekStep(t.seekStep),
        )
    }

    /**
     * The theme a saved player config describes: the two original colour columns,
     * then everything newer in options.theme (so an old config still resolves).
     */
    fun fromConfig(cfg: JsonObject?): Theme {
        if (cfg == null) return Theme()
        val themeJson = ((cfg["options"] as? JsonObject)?.get("theme") as? JsonObject) ?: JsonObject(emptyMap())
        var t = Theme.fromJson(themeJson)
        fun str(e: JsonElement?) = (e as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (t.primary == null) t = t.copy(primary = str(cfg["primaryColor"]))
        if (t.secondary == null) t = t.copy(secondary = str(cfg["secondaryColor"]))
        return t
    }
}
