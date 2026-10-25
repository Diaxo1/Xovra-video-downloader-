# Xovra Android

The Android app is being built as a native, on-device app. This first milestone includes a local Python runtime with yt-dlp and a focused link analyzer/downloader. It only offers single-file video formats that already include audio, plus audio-only formats. It does not yet merge separate video/audio streams or include the desktop clip, convert, compress, and history features.

The Android app embeds yt-dlp as a Python package through the MIT-licensed Chaquopy runtime. It does not use the GPL `youtubedl-android` wrapper. The Python package is pinned in `app/build.gradle.kts`; update it with a new Xovra release. Third-party components are listed in `THIRD-PARTY-NOTICES.md`; include complete upstream license texts with every distributable Android package.

## Build locally

Install Android Studio with Android SDK 36 and JDK 17, then open this `android-app` folder. Build the `app` debug APK from Android Studio. The app supports current 64-bit Android devices (arm64-v8a) and x86_64 emulators, Android 10 / API 29 and newer.

Android preview builds are published as a separate GitHub prerelease: [Xovra Android Preview](https://github.com/Diaxo1/Xovra-video-downloader-/releases/tag/android-preview-0.1.0). Download `Xovra-Android-0.1.0-preview.apk` from its Assets section. It is debug-signed and intended for testing; Android may ask you to allow installs from your browser. Because preview builds do not yet share a stable signing key, future updates may require uninstalling the previous preview first.

## Current preview limits

- Downloads run while the app is open; a persistent background queue and progress notifications are not included yet.
- Only formats that can be saved as one file are offered. Xovra does not merge separate video/audio streams yet.
- Clipping, conversion, compression, and audio transcoding are desktop-only for now.
- Link history is in memory in this preview.

Downloads are copied into `Downloads/Xovra` using Android's Downloads collection. Only download media you have permission to use. Xovra does not bypass private access or DRM.

## Publishing

The public Android preview is not the stable release. Before publishing an updateable release APK or Play Store AAB, configure a stable signing key, keep it out of Git, and back it up securely.

