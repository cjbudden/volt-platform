// ============================================================================
//  THE THEME, AS COMPOSE READS IT. Colours, corners and the TV focus ring
//  come from the resolved theme tokens (core ThemeTokens), so a theme saved in
//  Player setup looks the same here as in a browser and on iOS.
// ============================================================================
package com.volt.player.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.volt.player.core.ResolvedTheme
import com.volt.player.core.ThemeTokens
import com.volt.player.core.Translator

/** "#rrggbb" to a Compose colour. */
fun hexColor(hex: String, alpha: Float = 1f): Color {
    val (r, g, b) = ThemeTokens.rgb(hex)
    return Color(r, g, b, (alpha * 255).toInt().coerceIn(0, 255))
}

/** The theme as colours and sizes. `scale` is 1 on phones and larger on TVs (ten-foot type). */
class VoltStyle(val theme: ResolvedTheme, val scale: Float = 1f) {
    val primary = hexColor(theme.primary)
    val primaryInk = hexColor(theme.primaryInk)
    val secondary = hexColor(theme.secondary)
    val secondaryInk = hexColor(theme.secondaryInk)
    val background = hexColor(theme.background)
    val text = hexColor(theme.text)
    val muted = hexColor(theme.muted, theme.mutedOpacity.toFloat())
    val focus = hexColor(theme.focusColor)
    val live = Color(0xFFE5484D)
    val radius: Dp = theme.radius.dp
    val shape: Shape = RoundedCornerShape(radius)

    fun type(size: Float, weight: FontWeight = FontWeight.Normal, color: Color = text) =
        TextStyle(fontSize = (size * scale).sp, fontWeight = weight, color = color)
}

val LocalVoltStyle = compositionLocalOf { VoltStyle(ThemeTokens.resolve()) }
val LocalVoltT = staticCompositionLocalOf { Translator() }
/** The Volt address, for logos and artwork given as paths on the Volt site. */
val LocalVoltBase = staticCompositionLocalOf<String?> { null }

/** http(s) as given; a path on the Volt site against the API base; anything else dropped. */
fun voltUrl(s: String?, base: String?): String? {
    val v = s?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val low = v.lowercase()
    if (low.startsWith("https://") || low.startsWith("http://")) return v
    if (v.startsWith("/") && !v.startsWith("//") && base != null) return base.trimEnd('/') + v
    return null
}

/**
 * A visible focus ring in the theme's focus colour, and a small lift on TVs. Every control
 * in every skin has one, so a D-pad or keyboard always shows where it is.
 */
fun Modifier.voltFocus(shape: Shape? = null, tv: Boolean = false): Modifier = composed {
    val s = LocalVoltStyle.current
    var focused by remember { mutableStateOf(false) }
    val lift by animateFloatAsState(if (focused && tv) 1.08f else 1f, label = "focus")
    this
        .onFocusChanged { focused = it.isFocused }
        .graphicsLayer { scaleX = lift; scaleY = lift }
        .border(if (focused) (if (tv) 3.dp else 2.dp) else 0.dp, if (focused) s.focus else Color.Transparent, shape ?: s.shape)
}

/** The current style, for skins written outside the SDK. */
@Composable fun voltStyle(): VoltStyle = LocalVoltStyle.current
