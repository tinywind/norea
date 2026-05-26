import groovy.json.JsonSlurper
import java.io.File
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

fun envOrNull(name: String) = System.getenv(name)?.takeIf { it.isNotBlank() }

// Production signing uses environment-provided secrets; fallback tester keys are generated under .tmp.
val releaseKeystoreFile =
    envOrNull("ANDROID_RELEASE_KEYSTORE_FILE")?.let { file(it) }
        ?: file("../../../../.tmp/android-release-signing/test-release.jks")
val releaseKeyAlias = envOrNull("ANDROID_RELEASE_KEY_ALIAS") ?: "androiddebugkey"
val releaseStorePassword = envOrNull("ANDROID_RELEASE_STORE_PASSWORD") ?: "android"
val releaseKeyPassword = envOrNull("ANDROID_RELEASE_KEY_PASSWORD") ?: "android"
val buildChannel = envOrNull("NOREA_BUILD_CHANNEL") ?: "release"

data class RustlsPlatformVerifierAndroidDependency(
    val repository: File,
    val version: String,
)

fun findRustlsPlatformVerifierAndroidDependency(): RustlsPlatformVerifierAndroidDependency {
    val dependencyText = providers.exec {
        workingDir = projectDir
        commandLine(
            "cargo",
            "metadata",
            "--format-version",
            "1",
            "--locked",
            "--filter-platform",
            "aarch64-linux-android",
            "--manifest-path",
            file("../../../Cargo.toml").absolutePath,
        )
    }.standardOutput.asText.get()

    @Suppress("UNCHECKED_CAST")
    val packages = (JsonSlurper().parseText(dependencyText) as Map<String, Any>)["packages"]
        as List<Map<String, Any>>
    val dependency = packages.first { it["name"] == "rustls-platform-verifier-android" }
    val manifestPath = dependency["manifest_path"]?.toString()
        ?: error("rustls-platform-verifier-android manifest path was not found")
    val version = dependency["version"]?.toString()
        ?: error("rustls-platform-verifier-android version was not found")

    return RustlsPlatformVerifierAndroidDependency(
        repository = File(File(manifestPath).parentFile, "maven"),
        version = version,
    )
}

val rustlsPlatformVerifierAndroid by lazy {
    findRustlsPlatformVerifierAndroidDependency()
}

repositories {
    maven {
        url = uri(rustlsPlatformVerifierAndroid.repository)
        metadataSources {
            mavenPom()
        }
    }
}

fun applyLauncherPlaceholders(
    placeholders: MutableMap<String, Any>,
    appName: String,
    appIcon: String,
    appRoundIcon: String,
) {
    placeholders["appName"] = appName
    placeholders["appIcon"] = appIcon
    placeholders["appRoundIcon"] = appRoundIcon
    placeholders["usesCleartextTraffic"] = "true"
}

android {
    compileSdk = 36
    namespace = "io.github.tinywind.norea"
    defaultConfig {
        applyLauncherPlaceholders(
            manifestPlaceholders,
            "Norea",
            "@mipmap/ic_launcher",
            "@mipmap/ic_launcher_round",
        )
        applicationId = "io.github.tinywind.norea"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("releaseApk") {
            storeFile = releaseKeystoreFile
            storePassword = releaseStorePassword
            keyAlias = releaseKeyAlias
            keyPassword = releaseKeyPassword
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            applyLauncherPlaceholders(
                manifestPlaceholders,
                "Norea Debug",
                "@drawable/ic_launcher_debug",
                "@drawable/ic_launcher_debug",
            )
            isDebuggable = true
            isJniDebuggable = false
            isMinifyEnabled = false
        }
        getByName("release") {
            if (buildChannel == "dev") {
                applyLauncherPlaceholders(
                    manifestPlaceholders,
                    "Norea",
                    "@drawable/ic_launcher_dev",
                    "@drawable/ic_launcher_dev",
                )
            }
            signingConfig = signingConfigs.getByName("releaseApk")
            isJniDebuggable = false
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    packaging {
        jniLibs {
            keepDebugSymbols += "**/libapp_lib.so"
        }
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_1_8)
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.documentfile:documentfile:1.1.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("rustls:rustls-platform-verifier:${rustlsPlatformVerifierAndroid.version}")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

val patchRustWebViewClient by tasks.registering {
    val source = layout.projectDirectory.file(
        "src/main/java/io/github/tinywind/norea/generated/RustWebViewClient.kt"
    )
    inputs.file(source)
    outputs.file(source)
    outputs.upToDateWhen { false }

    doLast {
        val file = source.asFile
        if (!file.exists()) return@doLast

        val original = file.readText()
        val hook =
            "        (view.context as? MainActivity)?.androidLocalMediaResponse(request.url)?.let { return it }"
        if (original.contains(hook)) return@doLast

        val target = "    ): WebResourceResponse? {\n        pendingUrlRedirect?.let {\n"
        val replacement =
            "    ): WebResourceResponse? {\n$hook\n\n        pendingUrlRedirect?.let {\n"
        check(original.contains(target)) {
            "RustWebViewClient request interception hook target was not found."
        }
        file.writeText(original.replace(target, replacement))
    }
}

tasks.matching {
    it.name.startsWith("compile") && it.name.endsWith("Kotlin")
}.configureEach {
    dependsOn(patchRustWebViewClient)
}

patchRustWebViewClient.configure {
    mustRunAfter(tasks.matching { it.name.startsWith("rustBuild") })
}

apply(from = "tauri.build.gradle.kts")
