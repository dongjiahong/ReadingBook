#!/usr/bin/env bash
set -euo pipefail

# One-click Tauri 2 Android (arm64) release APK build + signing + optional WiFi ADB install.
#
# Usage:
#   ./scripts/build-android.sh                             # Build & sign arm64 release APK
#   ./scripts/build-android.sh --install                   # Build, sign & install to connected adb device
#   ./scripts/build-android.sh --install 192.168.1.50:5555 # Connect via WiFi ADB and install

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

DO_INSTALL=false
ADB_TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)
      DO_INSTALL=true
      if [[ $# -ge 2 && "$2" != --* ]]; then
        ADB_TARGET="$2"
        shift
      fi
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

# 1. Auto-detect toolchain paths on macOS
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [[ -z "${ANDROID_HOME:-}" ]]; then
  for candidate in "$HOME/Library/Android/sdk" "/opt/homebrew/share/android-commandlinetools"; do
    if [[ -d "$candidate" ]]; then
      export ANDROID_HOME="$candidate"
      break
    fi
  done
fi

if [[ -z "${ANDROID_HOME:-}" ]]; then
  echo "[ERROR] ANDROID_HOME not found. Please install Android SDK or export ANDROID_HOME." >&2
  exit 1
fi
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

if [[ -z "${NDK_HOME:-}" && -d "$ANDROID_HOME/ndk" ]]; then
  LATEST_NDK="$(ls -1 "$ANDROID_HOME/ndk" | sort -V | tail -n 1)"
  if [[ -n "$LATEST_NDK" ]]; then
    export NDK_HOME="$ANDROID_HOME/ndk/$LATEST_NDK"
  fi
fi

if [[ -z "${NDK_HOME:-}" ]]; then
  echo "[ERROR] NDK_HOME not found under $ANDROID_HOME/ndk. Install NDK via sdkmanager or Android Studio." >&2
  exit 1
fi

if [[ -z "${JAVA_HOME:-}" ]]; then
  for j in \
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
    "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" \
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" \
    "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home"; do
    if [[ -d "$j" ]]; then
      export JAVA_HOME="$j"
      break
    fi
  done
fi
[[ -n "${JAVA_HOME:-}" ]] && export PATH="$JAVA_HOME/bin:$PATH"

echo "ANDROID_HOME : $ANDROID_HOME"
echo "NDK_HOME     : $NDK_HOME"
echo "JAVA_HOME    : ${JAVA_HOME:-system default}"

# 2. Ensure Rust Android arm64 target is installed
if ! rustup target list --installed | grep -q '^aarch64-linux-android$'; then
  echo "[STEP] Adding Rust target aarch64-linux-android..."
  rustup target add aarch64-linux-android
fi

# 3. Initialize Tauri 2 Android project if needed
if [[ ! -d "$ROOT_DIR/src-tauri/gen/android" ]]; then
  echo "[STEP] Initializing Tauri 2 Android project..."
  npx tauri android init
fi

# 3.5 Sync Android launcher icons only when missing or readingbook.png changed
ANDROID_ICON_CHECK="$ROOT_DIR/src-tauri/gen/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"
if [[ -f "$ROOT_DIR/readingbook.png" ]] && [[ ! -f "$ANDROID_ICON_CHECK" || "$ROOT_DIR/readingbook.png" -nt "$ANDROID_ICON_CHECK" ]]; then
  echo "[STEP] Syncing Android launcher icons from readingbook.png..."
  npx tauri icon "$ROOT_DIR/readingbook.png" >/dev/null
fi

# 4. Build arm64 release APK
echo "[STEP] Building ReadingBook arm64 release APK..."
npx tauri android build --apk --target aarch64

APK_ROOT="$ROOT_DIR/src-tauri/gen/android/app/build/outputs/apk"
RAW_APK="$(find "$APK_ROOT" -path '*/release/*.apk' ! -name '*-signed.apk' ! -name '*-aligned.apk' -type f 2>/dev/null | head -n 1 || true)"
if [[ -z "$RAW_APK" || ! -f "$RAW_APK" ]]; then
  echo "[ERROR] Release APK not found under $APK_ROOT." >&2
  exit 1
fi

# 4.5 Sign release APK with persistent local keystore so adb install -r works cleanly
BUILD_TOOLS_DIR=""
if [[ -d "$ANDROID_HOME/build-tools" ]]; then
  LATEST_BT="$(ls -1 "$ANDROID_HOME/build-tools" | sort -V | tail -n 1)"
  [[ -n "$LATEST_BT" ]] && BUILD_TOOLS_DIR="$ANDROID_HOME/build-tools/$LATEST_BT"
fi
if [[ -z "$BUILD_TOOLS_DIR" || ! -x "$BUILD_TOOLS_DIR/apksigner" ]]; then
  echo "[ERROR] Android build-tools (apksigner/zipalign) not found under $ANDROID_HOME/build-tools." >&2
  exit 1
fi

KEYSTORE_PATH="${READINGBOOK_KEYSTORE:-$HOME/.readingbook-android-release.jks}"
KEY_ALIAS="${READINGBOOK_KEY_ALIAS:-readingbook}"
KEY_PASS="${READINGBOOK_KEY_PASS:-readingbook-local-release}"

if [[ ! -f "$KEYSTORE_PATH" ]]; then
  echo "[STEP] Generating local release keystore at $KEYSTORE_PATH..."
  keytool -genkeypair -v \
    -keystore "$KEYSTORE_PATH" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KEY_PASS" -keypass "$KEY_PASS" \
    -dname "CN=ReadingBook, OU=Personal, O=ReadingBook, L=Local, S=Local, C=CN"
fi

ALIGNED_APK="${RAW_APK%.apk}-aligned.apk"
SIGNED_APK="${RAW_APK%.apk}-signed.apk"

echo "[STEP] Zipaligning & signing release APK..."
"$BUILD_TOOLS_DIR/zipalign" -p -f 4 "$RAW_APK" "$ALIGNED_APK"
"$BUILD_TOOLS_DIR/apksigner" sign \
  --ks "$KEYSTORE_PATH" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KEY_PASS" \
  --key-pass "pass:$KEY_PASS" \
  --out "$SIGNED_APK" \
  "$ALIGNED_APK"
rm -f "$ALIGNED_APK"

echo "[OK] Built & signed release APK: $SIGNED_APK"

# 5. Optional WiFi ADB install
if [[ "$DO_INSTALL" == "true" ]]; then
  if [[ -n "$ADB_TARGET" ]]; then
    echo "[STEP] Connecting to WiFi ADB device $ADB_TARGET..."
    adb connect "$ADB_TARGET"
  fi
  echo "[STEP] Installing release APK to device..."
  adb devices
  adb install -r "$SIGNED_APK"
  echo "[STEP] Launching ReadingBook on phone..."
  adb shell monkey -p com.readingbook.app -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  echo "[DONE] ReadingBook release APK installed and launched!"
fi
