#!/usr/bin/env bash
set -euo pipefail

# Idempotently syncs tracked Android native overlay (foreground TTS media service,
# MediaSession, lockscreen/status-bar controls, permissions, Gradle deps, ProGuard)
# into the generated `src-tauri/gen/android` project.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY_DIR="$ROOT_DIR/src-tauri/android-overlay"
ANDROID_APP_DIR="$ROOT_DIR/src-tauri/gen/android/app"
ANDROID_MAIN_DIR="$ANDROID_APP_DIR/src/main"

if [[ ! -d "$ANDROID_MAIN_DIR" ]]; then
  echo "[ERROR] Android project not initialized at $ANDROID_APP_DIR" >&2
  exit 1
fi

# 1. Copy Kotlin sources & vector drawables
mkdir -p "$ANDROID_MAIN_DIR/java/com/readingbook/app"
mkdir -p "$ANDROID_MAIN_DIR/res/drawable"
cp -f "$OVERLAY_DIR/java/com/readingbook/app/"*.kt "$ANDROID_MAIN_DIR/java/com/readingbook/app/"
cp -f "$OVERLAY_DIR/res/drawable/"*.xml "$ANDROID_MAIN_DIR/res/drawable/"

# 2. Patch AndroidManifest.xml, build.gradle.kts, proguard-rules.pro idempotently via Python 3
python3 - "$ANDROID_APP_DIR" <<'PY'
import pathlib
import sys

app_dir = pathlib.Path(sys.argv[1])

# --- AndroidManifest.xml ---
manifest_path = app_dir / "src/main/AndroidManifest.xml"
manifest = manifest_path.read_text(encoding="utf-8")

permissions = [
    '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
    '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />',
    '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    '    <uses-permission android:name="android.permission.WAKE_LOCK" />',
]
missing_perms = [p for p in permissions if p.strip() not in manifest]
if missing_perms:
    anchor = '<uses-permission android:name="android.permission.INTERNET" />'
    if anchor in manifest:
        manifest = manifest.replace(anchor, anchor + "\n" + "\n".join(missing_perms), 1)
    else:
        manifest = manifest.replace("<application", "\n".join(missing_perms) + "\n\n    <application", 1)

service_block = """        <service
            android:name=".TtsMediaService"
            android:exported="false"
            android:foregroundServiceType="mediaPlayback" />"""

if 'android:name=".TtsMediaService"' not in manifest:
    manifest = manifest.replace("    </application>", "\n" + service_block + "\n    </application>", 1)

manifest_path.write_text(manifest, encoding="utf-8")

# --- build.gradle.kts ---
gradle_path = app_dir / "build.gradle.kts"
gradle = gradle_path.read_text(encoding="utf-8")
media_dep = '    implementation("androidx.media:media:1.7.0")'
if 'androidx.media:media:' not in gradle:
    gradle = gradle.replace(
        '    implementation("androidx.lifecycle:lifecycle-process:2.10.0")',
        '    implementation("androidx.lifecycle:lifecycle-process:2.10.0")\n' + media_dep,
        1,
    )
    if 'androidx.media:media:' not in gradle:
        gradle = gradle.replace("dependencies {\n", "dependencies {\n" + media_dep + "\n", 1)
    gradle_path.write_text(gradle, encoding="utf-8")

# --- proguard-rules.pro ---
proguard_path = app_dir / "proguard-rules.pro"
proguard = proguard_path.read_text(encoding="utf-8")
keep_rules = """
# ReadingBook Android TTS MediaSession & WebView JS bridge
-keep class com.readingbook.app.AndroidTtsBridge { *; }
-keepclassmembers class com.readingbook.app.AndroidTtsBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.readingbook.app.TtsMediaService { *; }
"""
if "com.readingbook.app.AndroidTtsBridge" not in proguard:
    proguard = proguard.rstrip() + "\n" + keep_rules
    proguard_path.write_text(proguard, encoding="utf-8")
PY

echo "[OK] Synced Android native TTS media overlay into $ANDROID_APP_DIR"
