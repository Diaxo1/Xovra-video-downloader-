# Xovra Android

The Android app is being built as a native, on-device app. This first milestone includes a local Python runtime with yt-dlp and a focused link analyzer/downloader. It only offers single-file video formats that already include audio, plus audio-only formats. It does not yet merge separate video/audio streams or include the desktop clip, convert, compress, and history features.

The Android app embeds yt-dlp as a Python package through the MIT-licensed Chaquopy runtime. It does not use the GPL `youtubedl-android` wrapper. The Python package is pinned in `app/build.gradle.kts`; update it with a new Xovra release. Third-party components are listed in `THIRD-PARTY-NOTICES.md`; include complete upstream license texts with every distributable Android package.

## Build locally

Install Android Studio with Android SDK 36 and JDK 17, then open this `android-app` folder. Build the `app` debug APK from Android Studio. The app supports current 64-bit Android devices (arm64-v8a) and x86_64 emulators, Android 10 / API 29 and newer.

The project’s Android preview workflow also builds a debug APK when Android files change and uploads it as a short-lived GitHub Actions artifact. This is for development only, not a public app release.

## Current preview limits

- Downloads run while the app is open; a persistent background queue and progress notifications are not included yet.
- Only formats that can be saved as one file are offered. Xovra does not merge separate video/audio streams yet.
- Clipping, conversion, compression, and audio transcoding are desktop-only for now.
- Link history is in memory in this preview.

Downloads are copied into `Downloads/Xovra` using Android's Downloads collection. Only download media you have permission to use. Xovra does not bypass private access or DRM.

## Publishing

No APK is published yet. A stable Android signing key is required before publishing installs that can be updated over an existing copy. Keep that key out of Git and back it up securely. After the app scope and signing are ready, build a release APK or Play Store AAB, attach it to a GitHub Release, and link it from the Xovra website.

