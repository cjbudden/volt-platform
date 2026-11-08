// The Volt player SDK for Android, Android TV and Fire TV.
//   :core    the contract and every rule, pure Kotlin (tested on any JVM)
//   :player  Media3 ExoPlayer engine, MediaSession, Compose skins (phone and TV)
//   :demo    a demo app for phones, tablets and TVs
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("com.android.library") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false
    id("org.jetbrains.kotlin.jvm") version "2.1.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.0" apply false
    id("app.cash.paparazzi") version "1.3.5" apply false
}
