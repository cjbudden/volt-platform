import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Your Volt address and an Android app's publishable key, from local.properties (never committed):
//   volt.apiBase=https://volt.example.com
//   volt.appKey=pk_live_...
//   volt.channelId=...   volt.eventId=...   volt.stationId=...
val local = Properties().apply { rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) } }
fun prop(k: String) = "\"" + (local.getProperty(k) ?: "") + "\""

android {
    namespace = "com.volt.player.demo"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.volt.player.demo"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "VOLT_API", prop("volt.apiBase"))
        buildConfigField("String", "VOLT_KEY", prop("volt.appKey"))
        buildConfigField("String", "VOLT_CHANNEL", prop("volt.channelId"))
        buildConfigField("String", "VOLT_EVENT", prop("volt.eventId"))
        buildConfigField("String", "VOLT_STATION", prop("volt.stationId"))
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }
}

dependencies {
    implementation(project(":player"))
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.material3:material3")
}
