import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORK_DIR = path.resolve(process.env.XOVRA_WORK_DIR || ROOT);
const HOST = '127.0.0.1';
let PORT = Number(process.env.XOVRA_PORT || 4317);
const MAX_BODY = 64 * 1024;
const MAX_ANALYSES = 3;
const MAX_QUEUE = 40;
const DOWNLOAD_CONCURRENCY = 2;
const ANALYSIS_TIMEOUT = 90_000;
const DOWNLOAD_TIMEOUT = 6 * 60 * 60 * 1000;
const rootDirs = {
  win32: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Xovra'),
  darwin: path.join(os.homedir(), 'Library', 'Application Support', 'Xovra'),
  linux: path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'xovra')
};
const DATA_DIR = rootDirs[process.platform] || path.join(os.homedir(), '.xovra');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const DOWNLOAD_DIR = path.resolve(process.env.XOVRA_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'Xovra'));
const CLIP_DIR = path.join(DOWNLOAD_DIR, 'Clips');
const TOOL_OUTPUT_DIR = path.join(DOWNLOAD_DIR, 'Tools');
const TOOL_WORK_DIR = path.join(DATA_DIR, 'media-tool-work');
const UPLOAD_DIR = path.join(DATA_DIR, 'media-uploads');
const MAX_MEDIA_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const MEDIA_UPLOAD_TTL = 24 * 60 * 60 * 1000;
const MAX_CLIP_SECONDS = 30 * 60;
const analyses = new Map();
const jobs = new Map();
const clipJobs = new Map();
const mediaToolJobs = new Map();
const uploadedMedia = new Map();
const queue = [];
const activeProcesses = new Map();
let activeDownloads = 0;
let activeAnalyses = 0;
let activeClipId = null;
let activeMediaToolId = null;
let persistChain = Promise.resolve();

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function fail(status, message, code = 'request_failed') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function isPublicIPv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255 && b === 255 && c === 255) return false;
  return true;
}

function isPublicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return isPublicIPv4(address);
  if (version !== 6) return false;
  const value = address.toLowerCase().split('%')[0];
  if (value === '::' || value === '::1' || value.startsWith('::ffff:')) return false;
  if (value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('ff')) return false;
  if (value.startsWith('2001:db8:')) return false;
  return true;
}

async function validateMediaUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 10_000) throw fail(400, 'Enter a valid public media URL.', 'invalid_url');
  let url;
  try { url = new URL(raw.trim()); } catch { throw fail(400, 'That link is not a valid URL.', 'invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw fail(400, 'Use a public http:// or https:// link without embedded credentials.', 'invalid_url');
  if (url.port && !['80', '443'].includes(url.port)) throw fail(400, 'Links on custom network ports are not allowed.', 'invalid_url');
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw fail(400, 'Local network addresses are not supported.', 'private_host');
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw fail(400, 'Local or reserved network addresses are not supported.', 'private_host');
  } else {
    let addresses;
    try { addresses = await lookup(host, { all: true, verbatim: true }); }
    catch { throw fail(400, 'This host name could not be resolved.', 'host_unresolved'); }
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw fail(400, 'Links to local or reserved network addresses are not supported.', 'private_host');
  }
  return url.href;
}

function run(command, args, { timeout = 15_000, maxOutput = 1024 * 1024, onLine, onStart, failureFormatter = friendlyExtractorError } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: WORK_DIR, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    onStart?.(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(fail(504, 'The media engine took too long. Try again later.', 'engine_timeout'));
    }, timeout);
    const append = (target, chunk, stream) => {
      const piece = chunk.toString('utf8');
      if (stream === 'stdout') stdout += piece;
      else stderr += piece;
      if ((stdout.length + stderr.length) > maxOutput) {
        child.kill('SIGKILL');
        finish(fail(502, 'The media engine returned too much data.', 'engine_output_limit'));
        return;
      }
      if (onLine) {
        target.buffer += piece;
        const lines = target.buffer.split(/\r?\n/);
        target.buffer = lines.pop() || '';
        for (const line of lines) onLine(line, stream);
      }
    };
    const outState = { buffer: '' };
    const errState = { buffer: '' };
    child.stdout.on('data', chunk => append(outState, chunk, 'stdout'));
    child.stderr.on('data', chunk => append(errState, chunk, 'stderr'));
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (onLine) {
        if (outState.buffer) onLine(outState.buffer, 'stdout');
        if (errState.buffer) onLine(errState.buffer, 'stderr');
      }
      if (code === 0) finish(null, { stdout, stderr });
      else finish(fail(502, failureFormatter(stderr || stdout), 'engine_process_failed'));
    });
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
  });
}

function friendlyExtractorError(raw) {
  const text = String(raw || '').replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-6).join(' ');
  if (/unsupported url/i.test(text)) return 'This source is not supported by the installed extractor version.';
  if (/private|members.only|sign in|login required|authentication/i.test(text)) return 'This media is private or requires access that Xovra does not provide.';
  if (/no video formats|requested format is not available/i.test(text)) return 'No downloadable formats were returned for this link.';
  if (/copyright|drm|protected/i.test(text)) return 'The source has restricted this media. Xovra does not bypass those protections.';
  if (/timed out|timeout/i.test(text)) return 'The source took too long to respond. Try again later.';
  return 'The source could not be analyzed. Check the link and try again.';
}

async function findBinary(name, args) {
  const candidates = [];
  const bundledEngineDir = process.env.XOVRA_ENGINE_DIR;
  if (name === 'yt-dlp') {
    const configured = process.env.XOVRA_YTDLP;
    if (configured) candidates.push(configured);
    if (bundledEngineDir) candidates.push(path.join(bundledEngineDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'));
    candidates.push(path.join(DATA_DIR, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'));
    candidates.push(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  } else if (name === 'ffprobe') {
    const executable = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    const configured = process.env.XOVRA_FFPROBE;
    if (configured) candidates.push(configured);
    if (process.env.XOVRA_FFMPEG && path.isAbsolute(process.env.XOVRA_FFMPEG)) candidates.push(path.join(path.dirname(process.env.XOVRA_FFMPEG), executable));
    if (bundledEngineDir) candidates.push(path.join(bundledEngineDir, executable));
    candidates.push(executable);
  } else {
    const configured = process.env.XOVRA_FFMPEG;
    if (configured) candidates.push(configured);
    if (bundledEngineDir) candidates.push(path.join(bundledEngineDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
    candidates.push(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  }
  for (const command of candidates) {
    if (path.isAbsolute(command) && !existsSync(command)) continue;
    try {
      const result = await run(command, args, { timeout: 8000, maxOutput: 100_000 });
      return { path: command, version: (result.stdout || result.stderr).split(/\r?\n/).find(Boolean)?.trim() || 'Available' };
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.status === 504) continue;
    }
  }
  return null;
}

async function engineStatus() {
  const [ytDlp, ffmpeg] = await Promise.all([findBinary('yt-dlp', ['--version']), findBinary('ffmpeg', ['-version'])]);
  return { ready: Boolean(ytDlp), desktop: process.env.XOVRA_DESKTOP === '1', ytdlp: ytDlp ? { available: true, version: ytDlp.version } : { available: false }, ffmpeg: ffmpeg ? { available: true, version: ffmpeg.version } : { available: false }, downloadDirectory: DOWNLOAD_DIR };
}

function fileSize(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function normalizeFormat(format) {
  if (!format || typeof format.format_id !== 'string' || !/^[\w.+/\-]{1,100}$/.test(format.format_id)) return null;
  return {
    id: format.format_id,
    ext: typeof format.ext === 'string' ? format.ext : null,
    note: typeof format.format_note === 'string' ? format.format_note : null,
    width: Number.isFinite(format.width) ? format.width : null,
    height: Number.isFinite(format.height) ? format.height : null,
    fps: Number.isFinite(format.fps) ? format.fps : null,
    vcodec: typeof format.vcodec === 'string' ? format.vcodec : 'none',
    acodec: typeof format.acodec === 'string' ? format.acodec : 'none',
    hasVideo: Boolean(format.vcodec && format.vcodec !== 'none'),
    hasAudio: Boolean(format.acodec && format.acodec !== 'none'),
    size: fileSize(format.filesize),
    approximateSize: fileSize(format.filesize_approx),
    bitrate: Number.isFinite(format.tbr) ? format.tbr : null,
    protocol: typeof format.protocol === 'string' ? format.protocol : null
  };
}

function publicThumbnail(info) {
  const candidates = Array.isArray(info.thumbnails) ? info.thumbnails.map(item => item?.url).filter(Boolean) : [];
  if (info.thumbnail) candidates.unshift(info.thumbnail);
  for (const candidate of candidates.reverse()) {
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (url.protocol === 'https:' && net.isIP(host) === 0 && host !== 'localhost' && !host.endsWith('.local') && !host.endsWith('.internal')) return url.href;
    } catch {}
  }
  return null;
}

function normalizeInfo(info, sourceUrl) {
  if (!info || typeof info !== 'object') throw fail(502, 'The extractor returned no media information.', 'invalid_engine_response');
  const formats = (Array.isArray(info.formats) ? info.formats : []).map(normalizeFormat).filter(item => item && (item.hasVideo || item.hasAudio));
  if (!formats.length) throw fail(422, 'The source did not provide any downloadable formats.', 'no_formats');
  const visibleFormats = formats.slice(0, 100);
  for (const candidate of [formats.filter(format => format.hasVideo).at(-1), formats.filter(format => format.hasAudio && !format.hasVideo).at(-1)]) {
    if (candidate && !visibleFormats.some(format => format.id === candidate.id)) {
      if (visibleFormats.length >= 100) visibleFormats.pop();
      visibleFormats.push(candidate);
    }
  }
  const analysisId = randomUUID();
  analyses.set(analysisId, { sourceUrl, duration: Number.isFinite(info.duration) ? info.duration : null, title: typeof info.title === 'string' ? info.title.slice(0, 400) : 'Media link', formatIds: new Map(formats.map(format => [format.id, format])), createdAt: Date.now() });
  while (analyses.size > 50) analyses.delete(analyses.keys().next().value);
  return {
    analysisId,
    url: sourceUrl,
    title: typeof info.title === 'string' ? info.title.slice(0, 400) : 'Media link',
    creator: [info.uploader, info.channel].find(value => typeof value === 'string' && value.trim())?.slice(0, 200) || null,
    provider: typeof info.extractor_key === 'string' ? info.extractor_key : (typeof info.extractor === 'string' ? info.extractor : 'Source'),
    duration: Number.isFinite(info.duration) ? info.duration : null,
    hasVideo: formats.some(format => format.hasVideo),
    hasAudio: formats.some(format => format.hasAudio),
    formatCount: formats.length,
    thumbnail: publicThumbnail(info),
    webpageUrl: typeof info.webpage_url === 'string' ? info.webpage_url : sourceUrl,
    formats: visibleFormats
  };
}

async function analyzeUrl(raw) {
  const url = await validateMediaUrl(raw);
  const binary = await findBinary('yt-dlp', ['--version']);
  if (!binary) throw fail(503, 'yt-dlp is not installed. Run npm run setup:engine, then restart Xovra.', 'ytdlp_missing');
  if (activeAnalyses >= MAX_ANALYSES) throw fail(429, 'Xovra is already analyzing several links. Try again in a moment.', 'analysis_busy');
  activeAnalyses++;
  try {
    const result = await run(binary.path, ['--ignore-config', '--no-playlist', '--no-warnings', '--skip-download', '--dump-single-json', '--socket-timeout', '20', url], { timeout: ANALYSIS_TIMEOUT, maxOutput: 16 * 1024 * 1024 });
    let info;
    try { info = JSON.parse(result.stdout.trim()); } catch { throw fail(502, 'The extractor returned unreadable media information.', 'invalid_engine_response'); }
    return normalizeInfo(info, url);
  } finally { activeAnalyses--; }
}

const MEDIA_FILE_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.ts', '.3gp', '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma', '.aiff', '.alac']);

function cleanMediaFileName(value) {
  const decoded = (() => { try { return decodeURIComponent(value || ''); } catch { return value || ''; } })();
  const leaf = path.basename(String(decoded).replace(/[\\/]/g, '_'));
  return leaf.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim().slice(0, 180) || 'Local media';
}

async function receiveMediaUpload(req) {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_MEDIA_UPLOAD_BYTES) { req.resume(); throw fail(413, 'Choose a media file smaller than 4 GB.', 'media_upload_too_large'); }
  const originalName = cleanMediaFileName(req.headers['x-xovra-filename']);
  const extension = path.extname(originalName).toLowerCase();
  if (!MEDIA_FILE_EXTENSIONS.has(extension)) { req.resume(); throw fail(415, 'Choose a supported audio or video file.', 'unsupported_media_file'); }
  const probe = await findBinary('ffprobe', ['-version']);
  if (!probe) { req.resume(); throw fail(503, 'FFprobe is required to inspect files. Install it alongside FFmpeg, then restart Xovra.', 'ffprobe_missing'); }
  await mkdir(UPLOAD_DIR, { recursive: true });
  const id = randomUUID();
  const filePath = path.join(UPLOAD_DIR, `${id}${extension}`);
  let size = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > MAX_MEDIA_UPLOAD_BYTES) callback(fail(413, 'Choose a media file smaller than 4 GB.', 'media_upload_too_large'));
    else callback(null, chunk);
  } });
  try {
    await pipeline(req, limit, createWriteStream(filePath, { flags: 'wx' }));
    if (size === 0) throw fail(400, 'The selected file is empty.', 'empty_media_file');
    const result = await run(probe.path, ['-v', 'error', '-show_entries', 'format=duration:format_tags=title:stream=codec_type,width,height:stream_disposition=attached_pic', '-of', 'json', filePath], {
      timeout: 30_000, maxOutput: 1024 * 1024,
      failureFormatter: () => 'Xovra could not read this file. Try an MP4, MOV, MKV, WebM, MP3, M4A, WAV or FLAC file.'
    });
    let metadata;
    try { metadata = JSON.parse(result.stdout); } catch { throw fail(422, 'Xovra could not read this media file.', 'invalid_media_file'); }
    const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
    const hasVideo = streams.some(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const hasAudio = streams.some(stream => stream.codec_type === 'audio');
    if (!hasVideo && !hasAudio) throw fail(422, 'This file does not contain a playable audio or video track.', 'unsupported_media_tracks');
    const durationValue = Number(metadata.format?.duration);
    const title = typeof metadata.format?.tags?.title === 'string' && metadata.format.tags.title.trim()
      ? metadata.format.tags.title.trim().slice(0, 400)
      : path.basename(originalName, extension).slice(0, 400);
    const media = { id, filePath, originalName, title, duration: Number.isFinite(durationValue) && durationValue > 0 ? durationValue : null, hasVideo, hasAudio, size, createdAt: Date.now() };
    uploadedMedia.set(id, media);
    return { media: { localMediaId: id, title, provider: 'This device', duration: media.duration, hasVideo, hasAudio, thumbnail: null, fileName: originalName } };
  } catch (error) {
    await rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
}

async function cleanupStagedMedia() {
  const now = Date.now();
  const activeIds = new Set([...clipJobs.values(), ...mediaToolJobs.values()]
    .filter(job => ['queued', 'downloading', 'processing'].includes(job.status) && job.localMediaId)
    .map(job => job.localMediaId));
  for (const [id, media] of uploadedMedia) {
    if (now - media.createdAt > MEDIA_UPLOAD_TTL && !activeIds.has(id)) {
      await rm(media.filePath, { force: true }).catch(() => {});
      uploadedMedia.delete(id);
    }
  }
  const files = await readdir(UPLOAD_DIR).catch(() => []);
  const knownPaths = new Set([...uploadedMedia.values()].map(media => path.resolve(media.filePath)));
  for (const name of files) {
    const filePath = path.join(UPLOAD_DIR, name);
    if (knownPaths.has(path.resolve(filePath))) continue;
    const details = await stat(filePath).catch(() => null);
    if (details?.isFile() && now - details.mtimeMs > MEDIA_UPLOAD_TTL) await rm(filePath, { force: true }).catch(() => {});
  }
}

async function persistJobs() {
  const snapshot = [...jobs.values()].slice(-100).map(({ process: _process, ...job }) => job);
  persistChain = persistChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const temporary = `${JOBS_FILE}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8');
    await rename(temporary, JOBS_FILE);
  }).catch(() => {});
  return persistChain;
}

async function loadJobs() {
  try {
    const saved = JSON.parse(await readFile(JOBS_FILE, 'utf8'));
    if (!Array.isArray(saved)) return;
    for (const job of saved.slice(-100)) {
      if (!job || typeof job.id !== 'string') continue;
      if (['queued', 'analyzing', 'downloading', 'processing'].includes(job.status)) {
        job.status = 'failed';
        job.error = 'Xovra closed before this download finished. You can start it again.';
      }
      jobs.set(job.id, job);
    }
    await persistJobs();
  } catch {}
}

function updateJob(job, changes) {
  Object.assign(job, changes, { updatedAt: new Date().toISOString() });
  void persistJobs();
}

function parseProgress(line, job) {
  if (line.startsWith('XOVRA_FILE:')) {
    const output = line.slice('XOVRA_FILE:'.length).trim();
    if (output && path.isAbsolute(output)) job.outputPath = output;
    return;
  }
  if (line.startsWith('download:')) {
    const parts = line.slice('download:'.length).split('|');
    const percent = Number.parseFloat((parts[0] || '').replace('%', '').trim());
    const speed = (parts[1] || '').trim();
    const eta = (parts[2] || '').trim();
    updateJob(job, { status: 'downloading', progress: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : job.progress, speed: speed && speed !== 'NA' ? speed : null, eta: eta && eta !== 'NA' ? eta : null });
  } else if (/merging|post-process|fixup|convert/i.test(line)) updateJob(job, { status: 'processing', statusText: 'Preparing file' });
}

function chooseFormat(analysis, id, mode, outputFormat) {
  if (id === 'best') return mode === 'audio' ? 'bestaudio/best' : 'bestvideo*+bestaudio/best';
  const format = analysis.formatIds.get(id);
  if (!format) throw fail(400, 'That format is no longer available. Analyze the link again.', 'format_missing');
  if (mode === 'audio' && !format.hasAudio) throw fail(400, 'Choose an audio format for audio-only downloads.', 'invalid_format');
  if (mode === 'video' && !format.hasVideo) throw fail(400, 'Choose a video format for video downloads.', 'invalid_format');
  if (mode === 'video' && format.hasVideo && !format.hasAudio) return `${id}+bestaudio/best`;
  if (mode === 'audio') return id;
  return id;
}

async function createDownload(body) {
  const analysis = analyses.get(body.analysisId);
  if (!analysis || analysis.createdAt < Date.now() - 60 * 60 * 1000) throw fail(400, 'Analyze this link again before downloading.', 'analysis_expired');
  const mode = body.mode === 'audio' ? 'audio' : 'video';
  const outputFormat = typeof body.outputFormat === 'string' ? body.outputFormat.toLowerCase() : '';
  if (outputFormat && !['mp3', 'm4a', 'opus', 'wav', 'flac'].includes(outputFormat)) throw fail(400, 'That audio output format is not supported.', 'invalid_output_format');
  const formatExpression = chooseFormat(analysis, String(body.formatId || 'best'), mode, outputFormat);
  const status = await engineStatus();
  if (!status.ytdlp.available) throw fail(503, 'yt-dlp is missing. Run npm run setup:engine and restart Xovra.', 'ytdlp_missing');
  if (!status.ffmpeg.available && (mode === 'video' || outputFormat || formatExpression.includes('+'))) throw fail(503, 'FFmpeg is required to save video downloads as MP4 or convert audio. Install FFmpeg and restart Xovra.', 'ffmpeg_missing');
  const pending = [...jobs.values()].filter(job => ['queued', 'downloading', 'processing'].includes(job.status)).length;
  if (pending >= MAX_QUEUE) throw fail(429, 'The download queue is full. Wait for a job to finish first.', 'queue_full');
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const id = randomUUID();
  const job = {
    id, analysisId: body.analysisId, url: analysis.sourceUrl, title: typeof body.title === 'string' ? body.title.slice(0, 200) : 'Media download',
    formatId: String(body.formatId || 'best'), mode, outputFormat: outputFormat || null,
    status: 'queued', progress: 0, speed: null, eta: null, outputPath: null, error: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  jobs.set(id, job); queue.push({ job, formatExpression, analysis });
  void persistJobs();
  void pumpQueue();
  return job;
}

async function pumpQueue() {
  while (activeDownloads < DOWNLOAD_CONCURRENCY && queue.length) {
    const entry = queue.shift();
    if (entry.job.status !== 'queued') continue;
    activeDownloads++;
    void runDownload(entry).finally(() => { activeDownloads--; void pumpQueue(); });
  }
}

async function runDownload({ job, formatExpression }) {
  const binary = await findBinary('yt-dlp', ['--version']);
  if (!binary) { updateJob(job, { status: 'failed', error: 'yt-dlp is missing. Run npm run setup:engine.' }); return; }
  const ffmpeg = await findBinary('ffmpeg', ['-version']);
  const template = path.join(DOWNLOAD_DIR, '%(title).180B [%(id)s].%(ext)s');
  const args = ['--ignore-config', '--no-playlist', '--no-warnings', '--no-colors', '--newline', '--progress', '--progress-template', 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s', '--print', 'after_move:XOVRA_FILE:%(filepath)s', '--format', formatExpression, '--output', template, '--windows-filenames', '--trim-filenames', '180', '--socket-timeout', '20'];
  if (ffmpeg && path.isAbsolute(ffmpeg.path)) args.push('--ffmpeg-location', ffmpeg.path);
  if (job.mode === 'audio') {
    args.push('--extract-audio');
    if (job.outputFormat) args.push('--audio-format', job.outputFormat);
  } else args.push('--recode-video', 'mp4');
  args.push(job.url);
  updateJob(job, { status: 'downloading', statusText: 'Starting download' });
  try {
    const result = await run(binary.path, args, { timeout: DOWNLOAD_TIMEOUT, maxOutput: 2 * 1024 * 1024, onLine: line => parseProgress(line, job), onStart: child => activeProcesses.set(job.id, child) });
    if (job.status === 'cancelled') return;
    if (!job.outputPath) {
      const line = result.stdout.split(/\r?\n/).find(item => item.startsWith('XOVRA_FILE:'));
      if (line) job.outputPath = line.slice('XOVRA_FILE:'.length).trim();
    }
    updateJob(job, { status: 'completed', progress: 100, speed: null, eta: null, statusText: 'Download complete', completedAt: new Date().toISOString(), error: null });
  } catch (error) {
    if (job.status === 'cancelled') return;
    updateJob(job, { status: 'failed', speed: null, eta: null, error: error.message || 'Download failed.' });
  } finally { activeProcesses.delete(job.id); }
}

function publicClipJob(job) {
  return { id: job.id, status: job.status, progress: job.progress, fileName: job.fileName, outputName: job.outputPath ? path.basename(job.outputPath) : job.outputName, start: job.start, end: job.end, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt };
}

function updateClipJob(job, changes) {
  Object.assign(job, changes, { updatedAt: new Date().toISOString() });
}

function clipProgress(line, job) {
  if (line.startsWith('XOVRA_FILE:')) {
    const output = line.slice('XOVRA_FILE:'.length).trim();
    if (output && path.isAbsolute(output)) job.outputPath = output;
    return;
  }
  if (line.startsWith('download:')) {
    const percent = Number.parseFloat((line.slice('download:'.length).split('|')[0] || '').replace('%', '').trim());
    updateClipJob(job, { status: 'downloading', progress: Number.isFinite(percent) ? Math.max(0, Math.min(99, percent)) : job.progress });
  } else {
    const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
    if (match && job.localMediaId) {
      const elapsed = Number(match[1]) / 1_000_000;
      const duration = job.end - job.start;
      if (Number.isFinite(elapsed) && duration > 0) updateClipJob(job, { status: 'processing', progress: Math.min(99, Math.max(0, elapsed / duration * 100)) });
    } else if (line === 'progress=end') updateClipJob(job, { status: 'processing', progress: 99 });
    else if (/merging|post-process|fixup|convert|cutting/i.test(line)) updateClipJob(job, { status: 'processing' });
  }
}

function friendlyClipError(raw) {
  const text = String(raw || '').replace(/\u001b\[[0-9;]*m/g, '');
  if (/private|members.only|sign in|login required|authentication/i.test(text)) return 'This video is private or requires access that Xovra does not provide.';
  if (/unsupported url/i.test(text)) return 'This video source is not supported by the installed extractor.';
  if (/requested format is not available|no video formats/i.test(text)) return 'The source did not provide a video format that Xovra can clip.';
  if (/ffmpeg.*not found|ffmpeg.*missing/i.test(text)) return 'FFmpeg is required to cut the video. Install it, then restart Xovra.';
  if (/section|download sections|ffmpeg/i.test(text)) return 'The source could not cut that section. Try another time range or a different supported link.';
  return 'Xovra could not fetch this clip. Check that the link is available and try again.';
}

function clipTimestamp(seconds) {
  const totalMilliseconds = Math.round(seconds * 1000);
  const wholeSeconds = Math.floor(totalMilliseconds / 1000);
  const milliseconds = totalMilliseconds % 1000;
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor(wholeSeconds / 60) % 60;
  const remainingSeconds = wholeSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

async function runClip(job, binaryPath, ffmpegPath) {
  const section = `*${clipTimestamp(job.start)}-${clipTimestamp(job.end)}`;
  const template = path.join(CLIP_DIR, `%(title).120B [%(id)s] clip-${job.id.slice(0, 8)}.%(ext)s`);
  let command = binaryPath;
  let args;
  if (job.localMediaId) {
    job.outputPath = path.join(CLIP_DIR, `${safeToolFileBase(job.fileName)} clip-${job.id.slice(0, 8)}.mp4`);
    command = ffmpegPath;
    args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-i', job.inputPath, '-ss', String(job.start), '-t', String(job.end - job.start), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', job.outputPath];
    updateClipJob(job, { status: 'processing', progress: 0 });
  } else {
    args = ['--ignore-config', '--no-playlist', '--no-warnings', '--no-colors', '--newline', '--progress', '--progress-template', 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s', '--download-sections', section, '--force-keyframes-at-cuts', '--recode-video', 'mp4', '--print', 'after_move:XOVRA_FILE:%(filepath)s', '--format', 'bestvideo*+bestaudio/best', '--output', template, '--windows-filenames', '--trim-filenames', '140', '--socket-timeout', '20'];
    if (ffmpegPath && path.isAbsolute(ffmpegPath)) args.push('--ffmpeg-location', ffmpegPath);
    args.push(job.url);
    updateClipJob(job, { status: 'downloading', progress: 0 });
  }
  try {
    const result = await run(command, args, { timeout: DOWNLOAD_TIMEOUT, maxOutput: 2 * 1024 * 1024, onLine: line => clipProgress(line, job), onStart: child => activeProcesses.set(job.id, child), failureFormatter: friendlyClipError });
    if (job.status === 'cancelled') return;
    if (!job.outputPath) {
      const line = result.stdout.split(/\r?\n/).find(item => item.startsWith('XOVRA_FILE:'));
      if (line) job.outputPath = line.slice('XOVRA_FILE:'.length).trim();
    }
    const resolved = job.outputPath && path.resolve(job.outputPath);
    if (!resolved || !resolved.startsWith(`${CLIP_DIR}${path.sep}`) || !existsSync(resolved)) throw fail(500, 'The media engine finished without creating the clip.', 'clip_output_missing');
    updateClipJob(job, { status: 'completed', progress: 100, error: null });
  } catch (error) {
    if (job.status !== 'cancelled') updateClipJob(job, { status: 'failed', error: error.message || 'Could not create this clip.' });
  } finally {
    activeProcesses.delete(job.id);
    if (activeClipId === job.id) activeClipId = null;
  }
}

async function createClip(body) {
  if (activeClipId) throw fail(429, 'Finish or cancel the current clip before starting another.', 'clip_busy');
  const localMediaId = typeof body.localMediaId === 'string' ? body.localMediaId : null;
  const localMedia = localMediaId ? uploadedMedia.get(localMediaId) : null;
  if (localMediaId && !localMedia) throw fail(400, 'Choose the local file again before making a clip.', 'local_media_expired');
  const analysis = localMedia ? null : analyses.get(body.analysisId);
  if (!localMedia && (!analysis || analysis.createdAt < Date.now() - 60 * 60 * 1000)) throw fail(400, 'Load this link again before making a clip.', 'analysis_expired');
  if (localMedia ? !localMedia.hasVideo : ![...analysis.formatIds.values()].some(format => format.hasVideo)) throw fail(422, 'This media does not contain a video track. Choose a video link or file.', 'video_track_missing');
  const start = Number(body.start);
  const end = Number(body.end);
  const duration = localMedia?.duration ?? analysis?.duration;
  if (!Number.isFinite(duration) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration || end - start > MAX_CLIP_SECONDS) throw fail(400, 'Choose a valid range within this video. Clips can be up to 30 minutes long.', 'invalid_clip_range');
  const binary = localMedia ? null : await findBinary('yt-dlp', ['--version']);
  if (!localMedia && !binary) throw fail(503, 'yt-dlp is missing. Run npm run setup:engine and restart Xovra.', 'ytdlp_missing');
  const ffmpeg = await findBinary('ffmpeg', ['-version']);
  if (!ffmpeg) throw fail(503, 'FFmpeg is required to clip videos. Install FFmpeg and restart Xovra.', 'ffmpeg_missing');
  await mkdir(CLIP_DIR, { recursive: true });
  if (activeClipId) throw fail(429, 'Finish or cancel the current clip before starting another.', 'clip_busy');
  const id = randomUUID();
  const job = { id, status: 'queued', progress: 0, fileName: localMedia?.title || analysis.title, outputName: null, outputPath: null, url: analysis?.sourceUrl || null, localMediaId, inputPath: localMedia?.filePath || null, start, end, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  activeClipId = id;
  clipJobs.set(id, job);
  void runClip(job, binary?.path || null, ffmpeg.path);
  return publicClipJob(job);
}

function publicMediaToolJob(job) {
  return { id: job.id, operation: job.operation, status: job.status, progress: job.progress, outputName: job.outputPath ? path.basename(job.outputPath) : null, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt };
}

function updateMediaToolJob(job, changes) {
  Object.assign(job, changes, { updatedAt: new Date().toISOString() });
}

function safeToolFileBase(value) {
  const safe = String(value || 'Media').normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/[. ]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
  return safe || 'Media';
}

function mediaToolProgress(line, job) {
  if (line.startsWith('XOVRA_FILE:')) {
    const sourcePath = line.slice('XOVRA_FILE:'.length).trim();
    if (sourcePath && path.isAbsolute(sourcePath)) job.inputPath = sourcePath;
    updateMediaToolJob(job, { status: 'processing', progress: Math.max(job.progress, 65) });
    return;
  }
  if (line.startsWith('download:')) {
    const percent = Number.parseFloat((line.slice('download:'.length).split('|')[0] || '').replace('%', '').trim());
    updateMediaToolJob(job, { status: 'downloading', progress: Number.isFinite(percent) ? Math.min(65, Math.max(0, percent * 0.65)) : job.progress });
    return;
  }
  const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
  if (match && Number.isFinite(job.duration) && job.duration > 0) {
    const elapsed = Number(match[1]) / 1_000_000;
    if (Number.isFinite(elapsed)) updateMediaToolJob(job, { status: 'processing', progress: Math.min(99, 65 + Math.max(0, elapsed / job.duration) * 34) });
  } else if (line === 'progress=end') updateMediaToolJob(job, { status: 'processing', progress: 99 });
}

function friendlyMediaToolError(raw) {
  const text = String(raw || '').replace(/\u001b\[[0-9;]*m/g, '');
  if (/private|members.only|sign in|login required|authentication/i.test(text)) return 'This media is private or requires access that Xovra does not provide.';
  if (/unsupported url/i.test(text)) return 'This source is not supported by the installed extractor.';
  if (/ffmpeg.*not found|ffmpeg.*missing/i.test(text)) return 'FFmpeg is required for this tool. Install it, then restart Xovra.';
  if (/unknown encoder|encoder .* not found/i.test(text)) return 'This FFmpeg build does not include the encoder needed for that output format.';
  if (/no audio|matches no streams/i.test(text)) return 'The source does not contain the audio or video track needed for this tool.';
  if (/requested format is not available|no formats/i.test(text)) return 'This link does not expose the audio or video format this tool needs.';
  return 'Xovra could not process this link. Check that it is available and try again.';
}

function mediaToolFfmpegArgs(job, inputPath) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-i', inputPath];
  if (job.operation === 'audio') {
    args.push('-map', '0:a:0', '-vn');
    if (job.outputFormat === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', '2');
    else if (job.outputFormat === 'm4a') args.push('-c:a', 'aac', '-b:a', '192k');
    else if (job.outputFormat === 'opus') args.push('-c:a', 'libopus', '-b:a', '128k');
    else if (job.outputFormat === 'wav') args.push('-c:a', 'pcm_s16le');
    else if (job.outputFormat === 'flac') args.push('-c:a', 'flac');
    return [...args, job.outputPath];
  }
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');
  if (job.operation === 'compress') {
    const crf = { smaller: '30', balanced: '26', higher: '22' }[job.quality] || '26';
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', crf, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart');
  } else if (job.outputFormat === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k');
    if (job.outputFormat === 'mp4') args.push('-movflags', '+faststart');
  }
  return [...args, job.outputPath];
}

async function runMediaTool(job, ytdlpPath, ffmpegPath) {
  const workDir = path.join(TOOL_WORK_DIR, job.id);
  try {
    await mkdir(workDir, { recursive: true });
    if (job.status === 'cancelled') return;
    let resolvedInput;
    if (job.localMediaId) {
      const localMedia = uploadedMedia.get(job.localMediaId);
      if (!localMedia || !existsSync(localMedia.filePath)) throw fail(404, 'That uploaded file expired. Choose it again from your device.', 'local_media_missing');
      resolvedInput = localMedia.filePath;
      updateMediaToolJob(job, { status: 'processing', progress: 5 });
    } else {
      const sourceTemplate = path.join(workDir, 'source.%(ext)s');
      const sourceFormat = job.operation === 'audio' ? 'bestaudio/best' : 'bestvideo*+bestaudio/best';
      const downloadArgs = ['--ignore-config', '--no-playlist', '--no-warnings', '--no-colors', '--newline', '--progress', '--progress-template', 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s', '--print', 'after_move:XOVRA_FILE:%(filepath)s', '--format', sourceFormat, '--output', sourceTemplate, '--windows-filenames', '--socket-timeout', '20'];
      if (path.isAbsolute(ffmpegPath)) downloadArgs.push('--ffmpeg-location', ffmpegPath);
      downloadArgs.push(job.url);
      updateMediaToolJob(job, { status: 'downloading', progress: 0 });
      const downloadResult = await run(ytdlpPath, downloadArgs, { timeout: DOWNLOAD_TIMEOUT, maxOutput: 2 * 1024 * 1024, onLine: line => mediaToolProgress(line, job), onStart: child => activeProcesses.set(job.id, child), failureFormatter: friendlyMediaToolError });
      if (job.status === 'cancelled') return;
      if (!job.inputPath) {
        const line = downloadResult.stdout.split(/\r?\n/).find(item => item.startsWith('XOVRA_FILE:'));
        if (line) job.inputPath = line.slice('XOVRA_FILE:'.length).trim();
      }
      resolvedInput = job.inputPath && path.resolve(job.inputPath);
      if (!resolvedInput || !resolvedInput.startsWith(`${workDir}${path.sep}`) || !existsSync(resolvedInput)) throw fail(500, 'The media engine did not finish downloading the source.', 'tool_input_missing');
    }
    const base = safeToolFileBase(job.title);
    const operationLabel = job.operation === 'audio' ? 'audio' : job.operation === 'compress' ? 'compressed' : 'converted';
    job.outputPath = path.join(TOOL_OUTPUT_DIR, `${base} - ${operationLabel} ${job.id.slice(0, 8)}.${job.outputFormat}`);
    updateMediaToolJob(job, { status: 'processing', progress: Math.max(job.progress, 65) });
    await run(ffmpegPath, mediaToolFfmpegArgs(job, resolvedInput), { timeout: DOWNLOAD_TIMEOUT, maxOutput: 2 * 1024 * 1024, onLine: line => mediaToolProgress(line, job), onStart: child => activeProcesses.set(job.id, child), failureFormatter: friendlyMediaToolError });
    if (job.status === 'cancelled') return;
    if (!existsSync(job.outputPath)) throw fail(500, 'FFmpeg finished without creating the output file.', 'tool_output_missing');
    updateMediaToolJob(job, { status: 'completed', progress: 100, error: null });
  } catch (error) {
    if (job.status !== 'cancelled') updateMediaToolJob(job, { status: 'failed', error: error.message || 'Could not process this link.' });
  } finally {
    activeProcesses.delete(job.id);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (['cancelled', 'failed'].includes(job.status) && job.outputPath) await rm(job.outputPath, { force: true }).catch(() => {});
    if (activeMediaToolId === job.id) activeMediaToolId = null;
  }
}

async function createMediaToolJob(body) {
  if (activeMediaToolId) throw fail(429, 'Finish or cancel the current media tool before starting another.', 'media_tool_busy');
  const localMediaId = typeof body.localMediaId === 'string' ? body.localMediaId : null;
  const localMedia = localMediaId ? uploadedMedia.get(localMediaId) : null;
  if (localMediaId && !localMedia) throw fail(400, 'Choose the local file again before running this tool.', 'local_media_expired');
  const analysis = localMedia ? null : analyses.get(body.analysisId);
  if (!localMedia && (!analysis || analysis.createdAt < Date.now() - 60 * 60 * 1000)) throw fail(400, 'Load this link again before running the tool.', 'analysis_expired');
  const operation = String(body.operation || '');
  if (!['compress', 'convert', 'audio'].includes(operation)) throw fail(400, 'Choose a supported media tool.', 'invalid_tool');
  if (localMedia) {
    if (operation === 'audio' && !localMedia.hasAudio) throw fail(422, 'This file does not have an audio track. Choose another file.', 'audio_track_missing');
    if (operation !== 'audio' && !localMedia.hasVideo) throw fail(422, 'This file does not have a video track. Choose another file.', 'video_track_missing');
  } else if (operation === 'audio') {
    if (![...analysis.formatIds.values()].some(format => format.hasAudio || format.hasVideo)) throw fail(422, 'This link does not provide a media track to extract audio from.', 'audio_track_missing');
  } else if (![...analysis.formatIds.values()].some(format => format.hasVideo)) throw fail(422, 'This link does not provide a video track.', 'video_track_missing');
  const outputFormat = operation === 'audio' ? String(body.outputFormat || 'mp3') : operation === 'convert' ? String(body.outputFormat || 'mp4') : 'mp4';
  if (operation === 'audio' && !['mp3', 'm4a', 'opus', 'wav', 'flac'].includes(outputFormat)) throw fail(400, 'Choose a supported audio format.', 'invalid_audio_format');
  if (operation === 'convert' && !['mp4', 'webm', 'mov', 'mkv'].includes(outputFormat)) throw fail(400, 'Choose a supported video format.', 'invalid_video_format');
  const quality = ['smaller', 'balanced', 'higher'].includes(body.quality) ? body.quality : 'balanced';
  const binary = localMedia ? null : await findBinary('yt-dlp', ['--version']);
  if (!localMedia && !binary) throw fail(503, 'yt-dlp is missing. Run npm run setup:engine and restart Xovra.', 'ytdlp_missing');
  const ffmpeg = await findBinary('ffmpeg', ['-version']);
  if (!ffmpeg) throw fail(503, 'FFmpeg is required for media tools. Install it and restart Xovra.', 'ffmpeg_missing');
  await Promise.all([mkdir(TOOL_OUTPUT_DIR, { recursive: true }), mkdir(TOOL_WORK_DIR, { recursive: true })]);
  if (activeMediaToolId) throw fail(429, 'Finish or cancel the current media tool before starting another.', 'media_tool_busy');
  const id = randomUUID();
  const job = { id, operation, outputFormat, quality, title: localMedia?.title || analysis.title, url: analysis?.sourceUrl || null, duration: localMedia?.duration ?? analysis?.duration ?? null, localMediaId, status: 'queued', progress: 0, inputPath: localMedia?.filePath || null, outputPath: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  activeMediaToolId = id;
  mediaToolJobs.set(id, job);
  void runMediaTool(job, binary?.path || null, ffmpeg.path);
  return publicMediaToolJob(job);
}

function localRequest(req) {
  let host;
  try { host = new URL(`http://${req.headers.host}`).hostname.toLowerCase(); } catch { return false; }
  if (!['127.0.0.1', 'localhost'].includes(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return false;
  return true;
}

async function readJson(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().includes('application/json')) throw fail(415, 'Send a JSON request body.', 'invalid_content_type');
  const length = Number(req.headers['content-length'] || 0);
  if (length > MAX_BODY) throw fail(413, 'The request is too large.', 'body_too_large');
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString('utf8');
    if (Buffer.byteLength(body) > MAX_BODY) throw fail(413, 'The request is too large.', 'body_too_large');
  }
  try { return JSON.parse(body || '{}'); } catch { throw fail(400, 'The request body is not valid JSON.', 'invalid_json'); }
}

async function handleApi(req, res, pathname) {
  if (!localRequest(req)) return json(res, 403, { error: 'This local engine only accepts requests from Xovra.', code: 'origin_rejected' });
  if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, await engineStatus());
  if (req.method === 'GET' && pathname === '/api/jobs') return json(res, 200, { jobs: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) });
  if (req.method === 'POST' && pathname === '/api/media/upload') return json(res, 201, await receiveMediaUpload(req));
  if (req.method === 'POST' && pathname === '/api/analyze') {
    const body = await readJson(req);
    const media = await analyzeUrl(body.url);
    return json(res, 200, { media });
  }
  if (req.method === 'POST' && pathname === '/api/tools/clip') {
    const body = await readJson(req);
    const job = await createClip(body);
    return json(res, 202, { job });
  }
  const clipMatch = pathname.match(/^\/api\/tools\/clip\/([a-f0-9-]{36})$/i);
  if (req.method === 'GET' && clipMatch) {
    const job = clipJobs.get(clipMatch[1]);
    if (!job) return json(res, 404, { error: 'That clip job has expired. Create the clip again.', code: 'clip_job_missing' });
    return json(res, 200, { job: publicClipJob(job) });
  }
  const clipActionMatch = pathname.match(/^\/api\/tools\/clip\/([a-f0-9-]{36})\/(cancel|reveal)$/i);
  if (req.method === 'POST' && clipActionMatch) {
    const job = clipJobs.get(clipActionMatch[1]);
    if (!job) return json(res, 404, { error: 'That clip job has expired.', code: 'clip_job_missing' });
    const action = clipActionMatch[2].toLowerCase();
    if (action === 'cancel') {
      if (['queued', 'downloading', 'processing'].includes(job.status)) {
        updateClipJob(job, { status: 'cancelled', error: null });
        activeProcesses.get(job.id)?.kill('SIGTERM');
        if (!activeProcesses.has(job.id) && activeClipId === job.id) activeClipId = null;
      }
      return json(res, 200, { job: publicClipJob(job) });
    }
    if (job.status !== 'completed' || !job.outputPath) return json(res, 409, { error: 'The clip is not ready yet.', code: 'clip_not_ready' });
    const resolved = path.resolve(job.outputPath);
    if (!resolved.startsWith(`${CLIP_DIR}${path.sep}`) || !existsSync(resolved)) return json(res, 404, { error: 'The clip file could not be found.', code: 'clip_file_missing' });
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? [`/select,${resolved}`] : process.platform === 'darwin' ? ['-R', resolved] : [path.dirname(resolved)];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.unref();
    return json(res, 200, { opened: true });
  }
  if (req.method === 'POST' && pathname === '/api/tools/process') {
    const body = await readJson(req);
    const job = await createMediaToolJob(body);
    return json(res, 202, { job });
  }
  const toolMatch = pathname.match(/^\/api\/tools\/process\/([a-f0-9-]{36})$/i);
  if (req.method === 'GET' && toolMatch) {
    const job = mediaToolJobs.get(toolMatch[1]);
    if (!job) return json(res, 404, { error: 'That media tool job has expired. Run the tool again.', code: 'media_tool_job_missing' });
    return json(res, 200, { job: publicMediaToolJob(job) });
  }
  const toolActionMatch = pathname.match(/^\/api\/tools\/process\/([a-f0-9-]{36})\/(cancel|reveal)$/i);
  if (req.method === 'POST' && toolActionMatch) {
    const job = mediaToolJobs.get(toolActionMatch[1]);
    if (!job) return json(res, 404, { error: 'That media tool job has expired.', code: 'media_tool_job_missing' });
    const action = toolActionMatch[2].toLowerCase();
    if (action === 'cancel') {
      if (['queued', 'downloading', 'processing'].includes(job.status)) {
        updateMediaToolJob(job, { status: 'cancelled', error: null });
        activeProcesses.get(job.id)?.kill('SIGTERM');
        if (!activeProcesses.has(job.id) && activeMediaToolId === job.id) activeMediaToolId = null;
      }
      return json(res, 200, { job: publicMediaToolJob(job) });
    }
    if (job.status !== 'completed' || !job.outputPath) return json(res, 409, { error: 'The processed file is not ready yet.', code: 'media_tool_not_ready' });
    const resolved = path.resolve(job.outputPath);
    if (!resolved.startsWith(`${TOOL_OUTPUT_DIR}${path.sep}`) || !existsSync(resolved)) return json(res, 404, { error: 'The processed file could not be found.', code: 'media_tool_file_missing' });
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? [`/select,${resolved}`] : process.platform === 'darwin' ? ['-R', resolved] : [path.dirname(resolved)];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.unref();
    return json(res, 200, { opened: true });
  }
  if (req.method === 'POST' && pathname === '/api/downloads') {
    const body = await readJson(req);
    const job = await createDownload(body);
    return json(res, 202, { job });
  }
  const cancelMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/cancel$/i);
  if (req.method === 'POST' && cancelMatch) {
    const job = jobs.get(cancelMatch[1]);
    if (!job) return json(res, 404, { error: 'That download no longer exists.', code: 'job_missing' });
    if (job.status === 'queued') {
      updateJob(job, { status: 'cancelled', statusText: 'Cancelled' });
      return json(res, 200, { job });
    }
    if (['downloading', 'processing'].includes(job.status)) {
      updateJob(job, { status: 'cancelled', statusText: 'Cancelling…' });
      activeProcesses.get(job.id)?.kill('SIGTERM');
    }
    return json(res, 200, { job });
  }
  const revealMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/reveal$/i);
  if (req.method === 'POST' && revealMatch) {
    const job = jobs.get(revealMatch[1]);
    if (!job || job.status !== 'completed' || !job.outputPath) return json(res, 409, { error: 'This download is not ready to reveal yet.', code: 'file_not_ready' });
    const resolved = path.resolve(job.outputPath);
    if (!resolved.startsWith(`${DOWNLOAD_DIR}${path.sep}`) || !existsSync(resolved)) return json(res, 404, { error: 'The downloaded file could not be found.', code: 'file_missing' });
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? [`/select,${resolved}`] : process.platform === 'darwin' ? ['-R', resolved] : [path.dirname(resolved)];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.unref();
    return json(res, 200, { opened: true });
  }
  return json(res, 404, { error: 'That local engine route does not exist.', code: 'route_missing' });
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return json(res, 400, { error: 'Invalid path.' }); }
  if (decoded.includes('..') || decoded.includes('\\') || decoded.startsWith('/.')) return json(res, 404, { error: 'Not found.' });
  const relative = decoded === '/' ? 'index.html' : decoded.slice(1);
  if (!['index.html', 'app.css', 'app.js'].includes(relative) && !relative.startsWith('assets/')) return json(res, 404, { error: 'Not found.' });
  const fullPath = path.resolve(ROOT, relative);
  if (!fullPath.startsWith(`${ROOT}${path.sep}`)) return json(res, 404, { error: 'Not found.' });
  try {
    const data = await readFile(fullPath);
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(fullPath)] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end(); else res.end(data);
  } catch { json(res, 404, { error: 'Not found.' }); }
}

async function startServer({ port = Number(process.env.XOVRA_PORT || 4317) } = {}) {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });
  await loadJobs();
  await cleanupStagedMedia();
  const mediaCleanupTimer = setInterval(() => { void cleanupStagedMedia(); }, 60 * 60 * 1000);
  mediaCleanupTimer.unref();
  const server = createServer(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    let pathname;
    try { pathname = new URL(req.url, `http://${HOST}:${PORT}`).pathname; }
    catch { return json(res, 400, { error: 'Invalid request URL.' }); }
    try {
      if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
      else await serveStatic(req, res, pathname);
    } catch (error) {
      json(res, error.status || 500, { error: error.message || 'Unexpected local engine error.', code: error.code || 'internal_error' });
    }
  });
  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.off('error', onError);
      PORT = server.address().port;
      console.log(`Xovra is running at http://${HOST}:${PORT}`);
      resolve();
    });
  });
  const [status, ffprobe] = await Promise.all([engineStatus(), findBinary('ffprobe', ['-version'])]);
  console.log(`yt-dlp: ${status.ytdlp.available ? status.ytdlp.version : 'not installed'}`);
  console.log(`FFmpeg: ${status.ffmpeg.available ? status.ffmpeg.version : 'not installed'}`);
  console.log(`FFprobe: ${ffprobe ? ffprobe.version : 'not installed (local-file tools need it)'}`);
  if (!status.ytdlp.available && !process.env.XOVRA_DESKTOP) console.log('Run "npm run setup:engine" once to install the verified yt-dlp binary.');

  let closed = false;
  return {
    port: PORT,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(mediaCleanupTimer);
      for (const child of activeProcesses.values()) child.kill('SIGTERM');
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const runningServer = await startServer();
  const shutdown = () => { void runningServer.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export { startServer };
