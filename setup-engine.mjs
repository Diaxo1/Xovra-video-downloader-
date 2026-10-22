import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDirs = {
  win32: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Xovra'),
  darwin: path.join(os.homedir(), 'Library', 'Application Support', 'Xovra'),
  linux: path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'xovra')
};
const binDir = path.join(dataDirs[process.platform] || path.join(os.homedir(), '.xovra'), 'bin');
const platformAssets = {
  win32: { x64: 'yt-dlp.exe', arm64: 'yt-dlp_arm64.exe' },
  darwin: { x64: 'yt-dlp_macos', arm64: 'yt-dlp_macos' },
  linux: { x64: 'yt-dlp_linux', arm64: 'yt-dlp_linux_aarch64', arm: 'yt-dlp_linux_armv7l' }
};

async function downloadAsset(url, { label, maxBytes, timeoutMs }) {
  const controller = AbortSignal.timeout(timeoutMs);
  console.log(`Connecting to ${label} download…`);
  let response;
  try { response = await fetch(url, { signal: controller }); }
  catch (error) {
    if (controller.aborted) throw new Error(`${label} download timed out after ${timeoutMs / 1000} seconds. Check your connection and retry.`);
    throw new Error(`Could not connect to ${label} download. Check your internet connection and retry.`);
  }
  if (!response.ok) throw new Error(`${label} download failed (${response.status}).`);
  const expectedSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(expectedSize) && expectedSize > maxBytes) throw new Error(`${label} is larger than expected.`);
  if (!response.body) throw new Error(`${label} download returned no data.`);

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error(`${label} is larger than expected.`);
      chunks.push(Buffer.from(value));
      const now = Date.now();
      if (now - lastReport >= 1000) {
        const downloaded = `${(received / 1024 / 1024).toFixed(1)} MB`;
        const total = Number.isFinite(expectedSize) && expectedSize > 0 ? ` of ${(expectedSize / 1024 / 1024).toFixed(1)} MB` : '';
        console.log(`${label}: ${downloaded}${total} downloaded`);
        lastReport = now;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (controller.aborted) throw new Error(`${label} download timed out after ${timeoutMs / 1000} seconds. Check your connection and retry.`);
    throw error;
  }
  console.log(`${label}: ${(received / 1024 / 1024).toFixed(1)} MB transfer complete`);
  return Buffer.concat(chunks, received);
}

async function installYtDlp({ platform = process.platform, arch = process.arch, outputDir = binDir } = {}) {
  const assetName = platformAssets[platform]?.[arch];
  if (!assetName) throw new Error(`No yt-dlp release is listed for ${platform}/${arch}.`);

  const releaseResponse = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'Xovra-local-engine-setup' },
    signal: AbortSignal.timeout(30000)
  });
  if (!releaseResponse.ok) throw new Error(`GitHub release lookup failed (${releaseResponse.status}).`);
  const release = await releaseResponse.json();
  const asset = release.assets?.find(item => item.name === assetName);
  const checksums = release.assets?.find(item => item.name === 'SHA2-256SUMS');
  if (!asset || !checksums) throw new Error(`The latest yt-dlp release did not include ${assetName} and SHA2-256SUMS.`);
  if (Number.isFinite(asset.size) && (asset.size < 1 || asset.size > 100 * 1024 * 1024)) throw new Error('The release binary has an unexpected size.');
  const allowedPrefix = 'https://github.com/yt-dlp/yt-dlp/releases/download/';
  if (!asset.browser_download_url.startsWith(allowedPrefix) || !checksums.browser_download_url.startsWith(allowedPrefix)) throw new Error('Unexpected release asset host.');

  console.log(`Downloading yt-dlp ${release.tag_name} for ${platform}/${arch}…`);
  const checksum = await downloadAsset(checksums.browser_download_url, { label: 'SHA-256 checksum', maxBytes: 1024 * 1024, timeoutMs: 30_000 });
  const binary = await downloadAsset(asset.browser_download_url, { label: 'yt-dlp', maxBytes: 100 * 1024 * 1024, timeoutMs: 5 * 60 * 1000 });
  console.log('Checking the published SHA-256 checksum…');
  const checksumText = checksum.toString('utf8');
  const expected = checksumText.split(/\r?\n/).map(line => line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)).find(match => match?.[2] === assetName)?.[1];
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error('The release checksum file did not contain a valid SHA-256 entry.');
  const actual = createHash('sha256').update(binary).digest('hex');
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error('The downloaded yt-dlp binary did not match its published SHA-256 checksum.');

  console.log('Checksum verified. Installing yt-dlp…');
  await mkdir(outputDir, { recursive: true });
  const outputName = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const outputPath = path.join(outputDir, outputName);
  const temporaryPath = `${outputPath}.download`;
  console.log(`Writing verified binary to ${outputPath}…`);
  await writeFile(temporaryPath, binary);
  if (platform !== 'win32') await chmod(temporaryPath, 0o755);
  await rm(outputPath, { force: true });
  await rename(temporaryPath, outputPath);
  console.log(`Installed verified yt-dlp ${release.tag_name} at ${outputPath}`);
  return { path: outputPath, version: release.tag_name };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    await installYtDlp();
    console.log('FFmpeg must also be installed and available on PATH for merging and audio conversion.');
  } catch (error) {
    console.error(error.message || 'yt-dlp setup failed.');
    process.exitCode = 1;
  }
}

export { installYtDlp };
