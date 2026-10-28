# Xovra Android

The Android app is being built as a native, on-device app. This first milestone includes a local Python runtime with yt-dlp and a focused link analyzer/downloader. It only offers single-file video formats that already include audio, plus audio-only formats. It does not yet merge separate video/audio streams or include the desktop clip, convert, compress, and history features.

The Android app embeds yt-dlp as a Python package through the MIT-licensed Chaquopy runtime. It does not use the GPL `youtubedl-android` wrapper. The Python package is pinned in `app/build.gradle.kts`; update it with a new Xovra release. Third-party components are listed in `THIRD-PARTY-NOTICES.md`; include complete upstream license texts with every distributable Android package.

## Build locally

Install Android Studio with Android SDK 36 and JDK 17, then open this `android-app` folder. Build the `app` debug APK from Android Studio. The app supports current 64-bit Android devices (arm64-v8a) and x86_64 emulators, Android 10 / API 29 and newer.

The latest stable Android release is [Xovra Android 0.1.4](https://github.com/Diaxo1/Xovra-video-downloader-/releases/tag/android-v0.1.4). Download `Xovra-Android-0.1.4.apk` from its Assets section. Install it over stable Android 0.1.3; uninstall the earlier debug preview first because it uses a different signing key. Android may ask you to allow installs from your browser.

## Current preview limits

- Downloads run while the app is open; a persistent background queue and progress notifications are not included yet.
- Only formats that can be saved as one file are offered. Xovra does not merge separate video/audio streams yet.
- Clipping, conversion, compression, and audio transcoding are desktop-only for now.
- Link history is in memory in this preview.

Downloads are copied into `Downloads/Xovra` using Android's Downloads collection. Only download media you have permission to use. Xovra does not bypass private access or DRM.

## Publishing the stable Android release

The stable APK uses a persistent upload key so future updates can install over it. The key is not in the repository. To publish a later release, create/retain the PKCS12 key with JDK `keytool`, then keep these repository Actions secrets under **Settings → Secrets and variables → Actions**:

- `ANDROID_KEYSTORE_BASE64`: Base64 of the `.jks` file.
- `ANDROID_KEY_ALIAS`: the alias used when creating the key (`xovra-upload`).
- `ANDROID_STORE_PASSWORD`: the keystore password.
- `ANDROID_KEY_PASSWORD`: the key password.

On Windows PowerShell, create the key with `keytool -genkeypair -v -keystore xovra-upload-key.jks -storetype PKCS12 -alias xovra-upload -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Xovra Android"`, then copy its Base64 value with `[Convert]::ToBase64String([IO.File]::ReadAllBytes("xovra-upload-key.jks")) | Set-Clipboard`. Use the exact password and alias chosen at key creation. Back up the `.jks` file and passwords securely in more than one place. Never commit them or paste them into chat.

The stable workflow uses tags named `android-vMAJOR.MINOR.PATCH`; update the app version code and name before each new release. Remove the debug preview before installing the first stable APK; after that, install newer stable APKs over the existing app and keep using the same signing key for every update. Losing or replacing the key prevents in-place updates for users.

