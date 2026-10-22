# Xovra local media workspace

Xovra is a local-first media link analyzer and downloader. It uses the official yt-dlp executable to inspect the formats a public source actually returns, and FFmpeg for stream merging and audio conversion. It does not send media through a Xovra server.

## Run the web workspace during development

1. Install Node.js 20 or newer and FFmpeg with `ffprobe`. Both tools must be available from a terminal (or configure `XOVRA_FFMPEG` and `XOVRA_FFPROBE`).
2. In this folder, run `npm run setup:engine` once. The setup fetches the latest official yt-dlp release from GitHub, checks its published SHA-256, then saves it in Xovra's local app-data folder (`%LOCALAPPDATA%\Xovra\bin` on Windows).
3. Run `npm start`.
4. Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

On macOS and Linux, use the same commands in a terminal. The setup script selects the yt-dlp binary for the current OS and CPU. Install FFmpeg using your OS package manager and ensure it is on `PATH`.

## Desktop installers for Windows and Linux

The desktop shell starts the local media service on an available loopback port and opens Xovra in its own window. It packages yt-dlp, FFmpeg and FFprobe with the app; users do not need Node.js or a system-wide FFmpeg installation.

For desktop development, install the dependencies with `npm install`, set up yt-dlp with `npm run setup:engine`, and make sure FFmpeg/FFprobe are on `PATH`; then run `npm run start:desktop`. To create an installer, build on the target operating system with `npm run make:desktop`. The build prepares verified yt-dlp and platform-specific FFmpeg binaries, then writes installers under `out/make`:

- Windows x64: Squirrel `Setup.exe` and WiX `.msi` installers (requires WiX Toolset 3 for local builds).
- Linux x64: Debian `.deb` and RPM `.rpm` packages (requires `fakeroot` and `rpm`).

The GitHub Actions workflow at `.github/workflows/build-desktop.yml` builds both targets on native Windows and Linux runners when `main` is updated or the workflow is manually dispatched. It stores the installers as downloadable workflow artifacts for 30 days. These unsigned builds are for early distribution; code signing can be added before a public release.

The bundled FFmpeg build has separate license and source obligations. The generated engine folder contains a manifest and third-party notices. Review those notices and provide the required corresponding source/build information before publishing installers.

Downloads are saved to `~/Downloads/Xovra` by default. Set `XOVRA_DOWNLOAD_DIR` before starting Xovra to use another folder. Set `XOVRA_PORT` to change the local web port. `XOVRA_YTDLP` and `XOVRA_FFMPEG` can point to custom executable paths.

## What the engine supports

- Live metadata and format discovery through yt-dlp, including title, creator, thumbnail, duration, codecs, resolution, frame rate, container, and size estimates when the source provides them.
- Explicit video/audio format selection, live download progress, cancellation, a two-download concurrency limit, and completed-file reveal in the system file manager.
- A video clipper for public links or local files, with a preview for local videos, time sliders and editable timestamps. Clips save as MP4 in `Downloads/Xovra/Clips` (up to 30 minutes per clip).
- Video downloads are saved in MP4 for broader playback compatibility; FFmpeg transcodes when required.
- Video compression, conversion to MP4/WebM/MOV/MKV, and audio extraction to MP3/M4A/Opus/WAV/FLAC work with public links or local files. Processed files are saved to `Downloads/Xovra/Tools`.
- Local files up to 4 GB are copied into Xovra's local app-data staging folder while they are processed; they are not sent to a remote Xovra server. Staged copies are cleaned up after 24 hours.
- Recent analyzed links in browser-local storage and download job records in the operating system's Xovra app-data folder.

The source controls are convenience labels; yt-dlp is the extractor authority. Support and available formats depend on the live source and installed yt-dlp version. Xovra does not supply login cookies, access private posts, or bypass DRM or other access protections. Analyze only links you have permission to use.

## Local service security

The engine binds to `127.0.0.1`, only serves the app files, rejects cross-origin API requests, blocks local/reserved destination hosts, limits request sizes, and invokes yt-dlp with argument arrays (never a shell command). Downloads only begin after the user chooses a format and confirms the Download action.
