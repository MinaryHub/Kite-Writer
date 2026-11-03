import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
}

// 버전은 데스크톱 앱과 같은 package.json 에서 가져온다 (1.2.3 → versionCode 10203)
val pkg = JsonSlurper().parse(rootProject.file("../package.json")) as Map<*, *>
val appVersion = pkg["version"] as String
val appVersionCode = appVersion.split(".").map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
    .let { (it.getOrElse(0) { 0 } * 10000) + (it.getOrElse(1) { 0 } * 100) + it.getOrElse(2) { 0 } }

// 서명 정보: android/keystore.properties 또는 환경 변수 (없으면 release 는 서명하지 않은 채로 만든다)
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signingValue(key: String, env: String): String? = keystoreProps.getProperty(key) ?: System.getenv(env)
val storeFilePath = signingValue("storeFile", "KITE_KEYSTORE_FILE")

// 화면(vite 빌드 결과 ../dist)을 앱 자산 www/ 로 넣는다
val webDist = rootProject.file("../dist")
val webAssetsDir = layout.buildDirectory.dir("generated/kite-web").get().asFile
val copyWebAssets by tasks.registering(Sync::class) {
    description = "Copy the web build (../dist) into the app assets"
    from(webDist)
    into(File(webAssetsDir, "www"))
    doFirst {
        if (!File(webDist, "index.html").exists()) {
            throw GradleException("../dist/index.html 이 없습니다. 먼저 저장소 루트에서 'npm run build:web' 을 실행하세요.")
        }
    }
}

android {
    namespace = "com.minary.kite"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.minary.kite"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersion
    }

    signingConfigs {
        if (storeFilePath != null) {
            create("release") {
                storeFile = rootProject.file(storeFilePath)
                storePassword = signingValue("storePassword", "KITE_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "KITE_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "KITE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (storeFilePath != null) signingConfig = signingConfigs.getByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    sourceSets["main"].assets.srcDir(webAssetsDir)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // 압축하지 않으면 큰 글꼴·wasm 자산을 더 빨리 읽는다
    androidResources {
        noCompress += listOf("wasm", "ttf", "otf", "woff", "woff2", "bcmap", "pfb")
    }
}

tasks.named("preBuild") { dependsOn(copyWebAssets) }

dependencies {
    implementation("androidx.activity:activity:1.9.3")
    implementation("androidx.core:core:1.13.1")
    // androidx 가 끌어오는 kotlin-stdlib 와 옛 -jdk7/-jdk8 조각이 겹치지 않게 한 버전으로 맞춘다
    implementation(platform("org.jetbrains.kotlin:kotlin-bom:1.8.22"))
}
