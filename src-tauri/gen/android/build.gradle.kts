import com.android.build.api.dsl.LibraryExtension
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.13.2")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

subprojects {
    afterEvaluate {
        if (plugins.hasPlugin("com.android.library")) {
            extensions.configure<LibraryExtension>("android") {
                defaultConfig.consumerProguardFiles.clear()
                defaultConfig.consumerProguardFiles("proguard-rules.pro")
            }
        }
    }
    tasks.withType<KotlinCompile>().configureEach {
        compilerOptions {
            suppressWarnings.set(true)
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}
