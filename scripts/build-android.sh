#!/usr/bin/env bash
set -euo pipefail

# One-click Tauri 2 Android (arm64) APK build + optional WiFi ADB install script.
#
# Usage:
#   ./scripts/build-android.sh                        # Build arm64 debug APK only
#   ./scripts/build-android.sh --install              # Build and install to connected adb device
#   ./scripts/build-android.sh --install 192.168.1.50:5555  # Connect via WiFi ADB and install

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

# 4. Build arm64 debug APK (fast, auto-signed, ready for adb install)
echo "[STEP] Building ReadingBook arm64 APK..."
npx tauri android build --apk --target aarch64 --debug

APK_PATH="$(find "$ROOT_DIR/src-tauri/gen/android/app/build/outputs/apk" -name '*.apk' -type f | head -n 1)"
if [[ -z "$APK_PATH" || ! -f "$APK_PATH" ]]; then
  echo "[ERROR] APK not found after build." >&2
  exit 1
fi

echo "[OK] Built APK: $APK_PATH"

# 5. Optional WiFi ADB install
if [[ "$DO_INSTALL" == "true" ]]; then
  if [[ -n "$ADB_TARGET" ]]; then
    echo "[STEP] Connecting to WiFi ADB device $ADB_TARGET..."
    adb connect "$ADB_TARGET"
  fi
  echo "[STEP] Installing APK to device..."
  adb devices
  adb install -r "$APK_PATH"
  echo "[STEP] Launching ReadingBook on phone..."
  adb shell monkey -p com.readingbook.app.debug -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  echo "[DONE] ReadingBook installed and launched!"
fi
