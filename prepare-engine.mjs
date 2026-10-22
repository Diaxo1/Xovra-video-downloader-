import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { installYtDlp } from './setup-engine.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.join(ROOT, 'engine', 'bin');
const executableExtension = process.platform === 'win32' ? '.exe' : '';
const ffmpegPath = typeof ffmpegStatic === 'string' ? ffmpegStatic : ffmpegStatic?.path;
const ffprobePath = typeof ffprobeStatic === 'string' ? ffprobeStatic : ffprobeStatic?.path;

if (!ffmpegPath || !ffprobePath) {
  throw new Error(`The FFmpeg packages do not provide binaries for ${process.platform}/${process.arch}. Build on a supported x64 Windows or Linux runner.`);
}

await mkdir(ENGINE_DIR, { recursive: true });
const ytdlp = await installYtDlp({ outputDir: ENGINE_DIR });
const ffmpegDestination = path.join(ENGINE_DIR, `ffmpeg${executableExtension}`);
const ffprobeDestination = path.join(ENGINE_DIR, `ffprobe${executableExtension}`);
await copyFile(ffmpegPath, ffmpegDestination);
await copyFile(ffprobePath, ffprobeDestination);

if (process.platform !== 'win32') {
  await Promise.all([chmod(ffmpegDestination, 0o755), chmod(ffprobeDestination, 0o755)]);
}

const packages = await Promise.all(['ffmpeg-static', 'ffprobe-static'].map(async name => {
  const packageJsonPath = path.join(ROOT, 'node_modules', name, 'package.json');
  const metadata = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const packageDir = path.dirname(packageJsonPath);
  let licenseText = null;
  for (const filename of ['LICENSE', 'LICENSE.txt', 'COPYING']) {
    try {
      licenseText = await readFile(path.join(packageDir, filename), 'utf8');
      break;
    } catch {}
  }
  if (licenseText) await writeFile(path.join(ROOT, 'engine', `${name}-LICENSE.txt`), licenseText);
  return { name, version: metadata.version, license: metadata.license || 'See upstream project', licenseFileIncluded: Boolean(licenseText) };
}));
const manifest = {
  platform: process.platform,
  architecture: process.arch,
  ytDlpBinary: path.basename(ytdlp.path),
  ffmpegBinary: path.basename(ffmpegDestination),
  ffprobeBinary: path.basename(ffprobeDestination),
  ffmpegPackages: packages,
  ffmpegVersion: 'See bundled FFmpeg/FFprobe version output; binaries are supplied by the pinned npm packages.'
};
await writeFile(path.join(ROOT, 'engine', 'engine-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(path.join(ROOT, 'engine', 'THIRD-PARTY-NOTICES.txt'), [
  'Xovra includes the following separately executed media-engine programs:',
  '',
  `yt-dlp: ${ytdlp.version}. Source and license: https://github.com/yt-dlp/yt-dlp`,
  'FFmpeg and FFprobe are supplied by the pinned ffmpeg-static and ffprobe-static npm packages.',
  `Package metadata: ${packages.map(item => `${item.name}@${item.version} (${item.license})`).join('; ')}.`,
  'Package license files are included beside these notices when supplied by the package.',
  'FFmpeg licensing depends on the configuration of the exact binary build. Review the build metadata and satisfy all source, notice, and redistribution terms before publishing installers.',
  'FFmpeg legal information: https://ffmpeg.org/legal.html',
  'FFmpeg static binary source project: https://github.com/eugeneware/ffmpeg-static'
].join('\n') + '\n');
console.log(`Prepared Xovra engine files in ${ENGINE_DIR}`);
