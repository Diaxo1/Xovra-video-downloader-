# Xovra

Xovra is a desktop media workspace for analyzing supported media links, downloading available formats, clipping videos, converting files, and extracting audio.

## Download

Download the latest version from [GitHub Releases](https://github.com/Diaxo1/Xovra-video-downloader-/releases/latest).

- **Windows x64:** use `Xovra Setup.exe` for the standard installer, or the `.msi` package.
- **Linux x64:** use `.deb` for Debian or Ubuntu, or `.rpm` for Fedora and other RPM-based distributions.

Current Windows builds are unsigned and may show an Unknown Publisher or SmartScreen warning. Check that the installer came from this repository before running it.

## The media engine is included

The desktop installers bundle the matching yt-dlp, FFmpeg, and FFprobe programs. They are installed with Xovra, so you do not need Node.js, a separate engine setup, or a system-wide FFmpeg installation.

Xovra processes media on your computer. It does not send media files through an Xovra server. Downloads are saved under `Downloads/Xovra`.

## Use Xovra

1. Install and open Xovra.
2. Paste a supported public media link in Analyzer, or select a file in Media tools.
3. Choose a format or tool, then save the result.

Available formats depend on the source and the media it provides. Xovra does not access private posts or bypass DRM or other access protections. Only download media you have permission to use.

## Included tools

- Analyze a media link and choose among available video and audio formats.
- Download supported media links.
- Clip a section from a public video link or a file.
- Compress or convert video to MP4, WebM, MOV, or MKV.
- Extract audio as MP3, M4A, Opus, WAV, or FLAC.
- View download and recent-link history.

## Third-party software

Xovra includes yt-dlp, FFmpeg, and FFprobe. Their notices and any license files supplied with the build are included with the application. FFmpeg redistribution terms depend on the exact bundled build; see the included notice file for the build details and related source links.

## Building installers

The workflow can be run manually to create temporary build artifacts. Pushing a `v*` tag builds the Windows x64 and Linux x64 installers, then attaches them to a GitHub Release with SHA-256 checksums. The current package version is `0.1.0`.
