const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const input = $('#media-url');
const composer = $('#url-composer');
const message = $('#form-message');
const historyKey = 'xovra-recent-v2';
const sourceNames = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', x: 'X', facebook: 'Facebook', dailymotion: 'Dailymotion', reddit: 'Reddit', vimeo: 'Vimeo', twitch: 'Twitch', soundcloud: 'SoundCloud' };
const pageNames = { analyzer: 'Analyzer', downloads: 'Downloads', tools: 'Media tools', history: 'History', settings: 'Settings' };
let batchMode = false;
let busy = false;
let currentPage = 'analyzer';
let sourceMode = 'auto';
let manualSource = 'auto';
let engineState = null;
let toastTimer;
let clipState = { url: '', source: 'link', media: null, start: 0, end: null, jobId: null, status: 'idle', progress: 0, error: null, analyzing: false, uploading: false, uploadProgress: 0, syncRangeFields: false };
let clipPollTimer = null;
let clipGeneration = 0;
let clipRoot = null;
let selectedMediaTool = 'clip';
let urlToolState = { url: '', source: 'link', media: null, jobId: null, outputName: null, status: 'idle', progress: 0, error: null, analyzing: false, uploading: false, uploadProgress: 0 };
let urlToolPollTimer = null;
let urlToolGeneration = 0;

async function api(path, options = {}) {
  if (location.protocol === 'file:') throw new Error('Start Xovra with “npm start”, then open http://127.0.0.1:4317.');
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
      signal: options.signal || AbortSignal.timeout(100_000)
    });
  } catch {
    throw new Error('Xovra’s local engine is not running. Start it with “npm start”.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('The local engine returned an unreadable response.'); }
  if (!response.ok) throw new Error(data.error || 'The local engine could not complete that request.');
  return data;
}

function sourceFromUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
    if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'x';
    if (host === 'fb.watch' || host === 'facebook.com' || host.endsWith('.facebook.com')) return 'facebook';
    if (host === 'dailymotion.com' || host.endsWith('.dailymotion.com')) return 'dailymotion';
    if (host === 'reddit.com' || host.endsWith('.reddit.com')) return 'reddit';
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) return 'vimeo';
    if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) return 'twitch';
    if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return 'soundcloud';
  } catch {}
  return null;
}

function validWebUrl(value) {
  try { const url = new URL(value.trim()); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname; }
  catch { return false; }
}

function setSource(source, mode = 'manual') {
  sourceMode = mode;
  manualSource = mode === 'manual' ? source : 'auto';
  if (['reddit', 'vimeo', 'twitch', 'soundcloud'].includes(source)) $('#source-override').value = source;
  else $('#source-override').value = 'more';
  updateSourceSelection();
}

function updateSourceSelection() {
  const raw = batchMode ? $('#batch-urls').value.split(/\r?\n/).find(line => line.trim())?.trim() || '' : input.value.trim();
  const detected = sourceFromUrl(raw);
  const selected = sourceMode === 'manual' ? manualSource : (detected || 'auto');
  const isOther = ['reddit', 'vimeo', 'twitch', 'soundcloud'].includes(selected);
  $('#source-override').value = sourceMode === 'manual' && isOther ? selected : (sourceMode === 'auto' && isOther ? selected : 'more');
  $$('.source-option[data-source]').forEach(button => {
    const active = button.dataset.source === selected;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('.more-source').classList.toggle('selected', isOther);
}

function showMessage(text, state = '') {
  message.textContent = text;
  message.className = `form-message${state ? ` ${state}` : ''}`;
  message.hidden = false;
}
function hideMessage() { message.hidden = true; message.textContent = ''; message.className = 'form-message'; }
function notify(text) {
  const toast = $('#toast'); toast.textContent = text; toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function readHistory() {
  try {
    const data = JSON.parse(localStorage.getItem(historyKey) || '[]');
    return Array.isArray(data) ? data.filter(item => item && typeof item.url === 'string') : [];
  } catch { return []; }
}
function writeHistory(items) {
  try { localStorage.setItem(historyKey, JSON.stringify(items.slice(0, 30))); return true; }
  catch { return false; }
}
function saveMedia(media) {
  const items = readHistory().filter(item => item.url !== media.url);
  items.unshift({ url: media.url, title: media.title, source: sourceFromUrl(media.url), savedAt: new Date().toISOString() });
  writeHistory(items);
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Saved locally' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function addFavicon(container, url) {
  const box = document.createElement('span'); box.className = 'recent-favicon';
  const image = document.createElement('img');
  try { image.src = new URL('/favicon.ico', url).href; } catch { image.hidden = true; }
  image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => {
    image.remove();
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M10 13.5a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.7 1.7M14 10.5a4.5 4.5 0 0 0-6.4 0l-3 3A4.5 4.5 0 0 0 11 20l1.7-1.7'); icon.append(path); box.append(icon);
  }, { once: true });
  box.append(image); container.append(box);
}
function renderHistory(target, emptyText = 'Links you check will appear here.') {
  target.replaceChildren();
  const items = readHistory();
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'recent-empty'; empty.textContent = emptyText; target.append(empty); return;
  }
  for (const item of items) {
    const row = document.createElement('article'); row.className = 'recent-row'; addFavicon(row, item.url);
    const main = document.createElement('div'); main.className = 'recent-main';
    const title = document.createElement('span'); title.className = 'recent-title'; title.textContent = item.title || item.url; title.title = item.url;
    const source = document.createElement('span'); source.className = 'recent-source'; source.textContent = sourceNames[item.source] || 'Other';
    const url = document.createElement('span'); url.className = 'recent-url'; url.textContent = item.url;
    const time = document.createElement('span'); time.className = 'recent-time'; time.textContent = formatDate(item.savedAt);
    main.append(title, source, url, time);
    const use = document.createElement('button'); use.className = 'recent-use'; use.type = 'button'; use.textContent = 'Use link';
    use.addEventListener('click', () => { input.value = item.url; setSource('auto', 'auto'); $('#clear-input').hidden = false; hideMessage(); showPage('analyzer'); input.focus(); });
    row.append(main, use); target.append(row);
  }
}
function renderRecent() {
  renderHistory($('#recent-list'));
  $('#clear-recent').hidden = readHistory().length === 0;
}

function bytesLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Size unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let value = bytes; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
function durationLabel(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const min = Math.floor(seconds / 60); const sec = Math.floor(seconds % 60);
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}:${String(sec).padStart(2, '0')}`;
}
function formatClipTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const remaining = whole % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
}
function parseClipTime(value) {
  const text = String(value || '').trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some(part => part.trim() === '' || !/^\d+(?:\.\d+)?$/.test(part.trim()))) return null;
  const numbers = parts.map(Number);
  const seconds = numbers.at(-1);
  const minutes = numbers.length === 3 ? numbers[1] : numbers[0];
  if (seconds >= 60 || (numbers.length === 3 && minutes >= 60)) return null;
  return numbers.length === 3 ? numbers[0] * 3600 + numbers[1] * 60 + seconds : numbers[0] * 60 + seconds;
}
function uploadMediaFile(file, onProgress = () => {}) {
  if (location.protocol === 'file:') throw new Error('Start Xovra with “npm start”, then open http://127.0.0.1:4317.');
  if (!file) throw new Error('Choose a media file first.');
  if (file.size > 4 * 1024 * 1024 * 1024) throw new Error('Choose a media file smaller than 4 GB.');
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/media/upload');
    request.timeout = 2 * 60 * 60 * 1000;
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-Xovra-Filename', encodeURIComponent(file.name));
    request.upload.addEventListener('progress', event => { if (event.lengthComputable) onProgress(event.loaded / event.total); });
    request.addEventListener('load', () => {
      let result;
      try { result = JSON.parse(request.responseText); } catch { reject(new Error('The local engine returned an unreadable response.')); return; }
      if (request.status < 200 || request.status >= 300) { reject(new Error(result.error || 'Xovra could not read this file.')); return; }
      resolve(result);
    });
    request.addEventListener('error', () => reject(new Error('Xovra’s local engine is not running. Start it with “npm start”.')));
    request.addEventListener('timeout', () => reject(new Error('The file upload took too long. Try a smaller file or a faster drive.')));
    request.send(file);
  });
}
function formatLabel(format) {
  const parts = [];
  if (format.height) parts.push(`${format.height}p`);
  if (format.fps) parts.push(`${Math.round(format.fps)} fps`);
  if (format.ext) parts.push(format.ext.toUpperCase());
  const codec = format.hasVideo ? format.vcodec : format.acodec;
  if (codec && codec !== 'none') parts.push(codec.split('.')[0].toUpperCase());
  const size = format.size || format.approximateSize;
  if (size) parts.push(bytesLabel(size));
  if (format.hasVideo && !format.hasAudio) parts.push('+ audio');
  return parts.join(' · ');
}

function groupedFormats(formats, mode) {
  const groups = new Map();
  for (const format of formats) {
    let key;
    if (mode === 'video') {
      key = format.height
        ? `video:${format.height}:${Math.round(format.fps || 0)}`
        : `video:unknown:${format.ext || ''}:${format.vcodec || ''}`;
    } else {
      const rate = format.bitrate ? Math.round(format.bitrate / 32) * 32 : 0;
      key = `audio:${format.ext || ''}:${rate || 'default'}`;
    }
    const previous = groups.get(key);
    const score = item => (item.hasAudio ? 1_000_000 : 0)
      + (item.ext === 'mp4' || item.ext === 'm4a' ? 100_000 : 0)
      + (item.size || item.approximateSize ? 10_000 : 0)
      + (item.bitrate || 0);
    if (!previous || score(format) > score(previous)) groups.set(key, format);
  }
  return [...groups.values()].sort((a, b) =>
    (b.height || 0) - (a.height || 0)
    || (b.fps || 0) - (a.fps || 0)
    || (b.bitrate || 0) - (a.bitrate || 0)
  );
}

function addFormatResult(media, index) {
  const card = document.createElement('article'); card.className = 'media-card'; card.dataset.analysisId = media.analysisId;
  const header = document.createElement('div'); header.className = 'media-card-header';
  if (media.thumbnail) {
    const image = document.createElement('img'); image.className = 'media-thumbnail'; image.src = media.thumbnail; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), { once: true }); header.append(image);
  } else {
    const placeholder = document.createElement('div'); placeholder.className = 'media-thumbnail-placeholder'; placeholder.setAttribute('aria-hidden', 'true'); placeholder.textContent = '▶'; header.append(placeholder);
  }
  const info = document.createElement('div'); info.className = 'media-info';
  const provider = document.createElement('span'); provider.className = 'provider-label'; provider.textContent = sourceNames[sourceFromUrl(media.url)] || media.provider || 'Media source';
  const title = document.createElement('h4'); title.textContent = media.title || 'Media link';
  const detail = document.createElement('p'); detail.textContent = [media.creator, durationLabel(media.duration)].filter(Boolean).join(' · ') || new URL(media.url).hostname;
  info.append(provider, title, detail); header.append(info); card.append(header);

  const controls = document.createElement('div'); controls.className = 'format-controls';
  const modeGroup = document.createElement('div'); modeGroup.className = 'mode-switch'; modeGroup.setAttribute('role', 'group'); modeGroup.setAttribute('aria-label', 'Media type');
  const video = document.createElement('button'); video.type = 'button'; video.className = 'mode-button active'; video.dataset.mode = 'video'; video.textContent = 'Video'; video.setAttribute('aria-pressed', 'true');
  const audio = document.createElement('button'); audio.type = 'button'; audio.className = 'mode-button'; audio.dataset.mode = 'audio'; audio.textContent = 'Audio'; audio.setAttribute('aria-pressed', 'false');
  modeGroup.append(video, audio);
  const formatLabelEl = document.createElement('label'); formatLabelEl.className = 'format-choice';
  const fieldTitle = document.createElement('span'); fieldTitle.textContent = 'Format';
  const select = document.createElement('select'); select.className = 'format-select'; select.setAttribute('aria-label', 'Available media format');
  const output = document.createElement('select'); output.className = 'audio-output'; output.setAttribute('aria-label', 'Audio output type');
  for (const [value, label] of [['source', 'Original audio'], ['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'Opus'], ['wav', 'WAV'], ['flac', 'FLAC']]) { const opt = document.createElement('option'); opt.value = value; opt.textContent = label; output.append(opt); }
  formatLabelEl.append(fieldTitle, select); controls.append(modeGroup, formatLabelEl, output);
  const download = document.createElement('button'); download.type = 'button'; download.className = 'download-action'; download.textContent = 'Download';
  const formatCount = media.formatCount || media.formats.length;
  const note = document.createElement('p'); note.className = 'format-note';
  const status = document.createElement('p'); status.className = 'result-status'; status.hidden = true;
  card.append(controls, note, download, status);

  let mode = 'video';
  const populate = () => {
    const choices = media.formats.filter(format => mode === 'video' ? format.hasVideo : format.hasAudio);
    const qualityChoices = groupedFormats(choices, mode);
    select.replaceChildren();
    const best = document.createElement('option'); best.value = 'best'; best.textContent = mode === 'video' ? 'Best available video + audio' : 'Best available audio'; select.append(best);
    for (const format of qualityChoices) {
      const option = document.createElement('option'); option.value = format.id; option.textContent = formatLabel(format); select.append(option);
    }
    note.textContent = mode === 'video'
      ? `${formatCount} formats from the source · ${qualityChoices.length} quality choices · saved as MP4.`
      : `${formatCount} formats from the source · ${qualityChoices.length} audio choices.`;
    download.disabled = choices.length === 0;
    fieldTitle.textContent = mode === 'video' ? 'Video quality' : 'Audio quality';
    output.hidden = mode !== 'audio';
    video.classList.toggle('active', mode === 'video'); video.setAttribute('aria-pressed', String(mode === 'video'));
    audio.classList.toggle('active', mode === 'audio'); audio.setAttribute('aria-pressed', String(mode === 'audio'));
  };
  video.addEventListener('click', () => { mode = 'video'; populate(); });
  audio.addEventListener('click', () => { mode = 'audio'; populate(); });
  download.addEventListener('click', async () => {
    download.disabled = true; download.textContent = 'Adding…'; status.hidden = true;
    try {
      const result = await api('/downloads', { method: 'POST', body: JSON.stringify({ analysisId: media.analysisId, formatId: select.value, mode, outputFormat: mode === 'audio' && output.value !== 'source' ? output.value : undefined, title: media.title }) });
      download.textContent = 'Added to queue'; status.textContent = 'Queued on this device.'; status.className = 'result-status success'; status.hidden = false;
      notify('Download added to your queue.'); void refreshJobs();
    } catch (error) {
      download.textContent = 'Download'; download.disabled = false; status.textContent = error.message; status.className = 'result-status error'; status.hidden = false;
    }
  });
  populate();
  return card;
}

function renderMediaResults(mediaItems) {
  const list = $('#formats-list'); list.replaceChildren();
  mediaItems.forEach((media, index) => list.append(addFormatResult(media, index)));
  $('#formats-result').hidden = mediaItems.length === 0;
}
window.xovraShowFormats = renderMediaResults;

function setBusy(value) {
  busy = value;
  const button = $('.analyze-button'); button.disabled = value; button.setAttribute('aria-busy', String(value));
  $('span', button).textContent = value ? 'Analyzing' : 'Analyze link';
}
async function analyze() {
  if (busy) return;
  const urls = (batchMode ? $('#batch-urls').value.split(/\r?\n/) : [input.value]).map(value => value.trim()).filter(Boolean);
  if (!urls.length) { composer.classList.add('invalid'); showMessage('Paste a link to continue.', 'error'); (batchMode ? $('#batch-urls') : input).focus(); return; }
  if (urls.some(value => !validWebUrl(value))) { composer.classList.add('invalid'); showMessage('Enter a complete http:// or https:// link.', 'error'); (batchMode ? $('#batch-urls') : input).focus(); return; }
  if (urls.length > 10) { showMessage('Analyze up to 10 links at a time.', 'error'); return; }
  composer.classList.remove('invalid'); $('#formats-result').hidden = true; setBusy(true);
  const results = []; const errors = [];
  try {
    for (let index = 0; index < urls.length; index++) {
      showMessage(urls.length === 1 ? 'Checking this link for available formats…' : `Analyzing link ${index + 1} of ${urls.length}…`, 'loading');
      try {
        const response = await api('/analyze', { method: 'POST', body: JSON.stringify({ url: urls[index] }) });
        results.push(response.media); saveMedia(response.media);
      } catch (error) { errors.push(`${urls[index]} — ${error.message}`); }
    }
    renderRecent(); renderMediaResults(results);
    if (results.length && errors.length) showMessage(`${results.length} analyzed; ${errors.length} could not be read. ${errors[0].split(' — ').slice(1).join(' — ')}`, 'success');
    else if (results.length) showMessage(`${results.length === 1 ? 'Formats are ready' : `Formats are ready for ${results.length} links`}. Choose one to download.`, 'success');
    else showMessage(errors[0]?.split(' — ').slice(1).join(' — ') || 'The link could not be analyzed.', 'error');
  } finally { setBusy(false); }
}

function addButton(container, text, onClick, className = 'connect-button') {
  const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = text; button.addEventListener('click', onClick); container.append(button); return button;
}

let latestJobs = [];
function downloadStatusLabel(job) {
  if (job.status === 'downloading') {
    const progress = Number(job.progress) || 0;
    if (progress <= 0 && !job.speed) return 'Connecting to source…';
    return `Downloading · ${Math.round(progress)}%`;
  }
  if (job.status === 'processing') return job.statusText || 'Preparing file';
  if (job.status === 'completed') return 'Complete';
  if (job.status === 'failed') return 'Failed';
  if (job.status === 'cancelled') return 'Cancelled';
  return 'Waiting';
}
function makeJobRow(job) {
  const row = document.createElement('article'); row.className = `job-row job-${job.status}`;
  const details = document.createElement('div'); details.className = 'job-details';
  const title = document.createElement('strong'); title.textContent = job.title || 'Media download';
  const meta = document.createElement('span'); meta.textContent = `${sourceNames[sourceFromUrl(job.url)] || 'Media'} · ${job.mode === 'audio' ? 'Audio' : 'Video'} · ${downloadStatusLabel(job)}`;
  details.append(title, meta); row.append(details);
  if (['queued', 'downloading', 'processing'].includes(job.status)) {
    const progress = document.createElement('div'); progress.className = 'job-progress'; progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100');
    const indeterminate = job.status === 'downloading' && !(Number(job.progress) > 0);
    if (indeterminate) { progress.classList.add('indeterminate'); progress.setAttribute('aria-valuetext', 'Connecting to source'); }
    else { progress.setAttribute('aria-valuenow', String(Math.round(job.progress || 0))); }
    const bar = document.createElement('span');
    if (!indeterminate) bar.style.width = `${Math.max(3, Math.min(100, job.progress || 0))}%`;
    progress.append(bar); row.append(progress);
    const stats = document.createElement('span'); stats.className = 'job-stats'; stats.textContent = [job.speed, job.eta ? `ETA ${job.eta}` : null].filter(Boolean).join(' · '); row.append(stats);
    addButton(row, 'Cancel', () => cancelJob(job.id), 'job-button');
  } else if (job.status === 'completed') addButton(row, 'Show in folder', () => revealJob(job.id), 'job-button');
  else if (job.status === 'failed') { const error = document.createElement('p'); error.className = 'job-error'; error.textContent = job.error || 'Download failed.'; row.append(error); }
  return row;
}
function renderDownloads() {
  const count = latestJobs.filter(job => ['queued', 'downloading', 'processing'].includes(job.status)).length;
  const countEl = $('#download-count'); countEl.textContent = String(count); countEl.hidden = count === 0;
  if (currentPage !== 'downloads') return;
  const content = $('#secondary-content'); content.replaceChildren();
  if (!latestJobs.length) { const empty = document.createElement('p'); empty.className = 'secondary-empty'; empty.textContent = 'Your download queue is clear. Analyze a media link to start.'; content.append(empty); addButton(content, 'Back to analyzer', () => showPage('analyzer')); return; }
  const path = document.createElement('p'); path.className = 'download-path'; path.textContent = `Files save to ${engineState?.downloadDirectory || 'your Downloads/Xovra folder'}.`; content.append(path);
  const list = document.createElement('div'); list.className = 'job-list';
  for (const job of latestJobs) list.append(makeJobRow(job));
  content.append(list);
}
async function refreshJobs() {
  if (location.protocol === 'file:') return;
  try { const data = await api('/jobs', { signal: AbortSignal.timeout(5000) }); latestJobs = data.jobs || []; renderDownloads(); }
  catch { /* keep the last queue snapshot while the local server reconnects */ }
}
async function cancelJob(id) {
  try { await api(`/jobs/${id}/cancel`, { method: 'POST', body: '{}' }); await refreshJobs(); }
  catch (error) { notify(error.message); }
}
async function revealJob(id) {
  try { await api(`/jobs/${id}/reveal`, { method: 'POST', body: '{}' }); }
  catch (error) { notify(error.message); }
}

function clipRangeUi(root) {
  const media = clipState.media;
  if (!media || !Number.isFinite(media.duration)) return { valid: false, start: null, end: null };
  const duration = media.duration;
  const startInput = $('#clip-start', root);
  const endInput = $('#clip-end', root);
  const startRange = $('#clip-start-range', root);
  const endRange = $('#clip-end-range', root);
  let start = parseClipTime(startInput.value);
  let end = parseClipTime(endInput.value);
  if (start !== null && end !== null && end <= start) {
    if (document.activeElement === startInput) {
      endInput.value = formatClipTime(Math.min(duration, start + 1));
      end = parseClipTime(endInput.value);
    } else if (document.activeElement === endInput) {
      startInput.value = formatClipTime(Math.max(0, end - 1));
      start = parseClipTime(startInput.value);
    }
  }
  const endMax = Math.max(1, Math.floor(duration));
  startRange.max = String(Math.max(0, endMax - 1));
  endRange.max = String(endMax);
  if (start !== null) {
    startRange.value = String(Math.min(Math.max(0, endMax - 1), Math.max(0, Math.floor(start))));
    $('#clip-start-range-label', root).textContent = formatClipTime(start);
  }
  if (end !== null) {
    endRange.min = String(Math.min(endMax, Number(startRange.value) + 1));
    endRange.value = String(Math.min(endMax, Math.max(Number(endRange.min), Math.floor(end))));
    $('#clip-end-range-label', root).textContent = formatClipTime(end);
  }
  const length = start === null || end === null ? null : end - start;
  const maxLength = $('#clip-output-format', root).value === 'gif' ? 15 : 1800;
  const valid = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= duration && length <= maxLength;
  if (valid) { clipState.start = start; clipState.end = end; }
  $('#clip-range-summary', root).textContent = start === null || end === null
    ? 'Enter a time like 00:01:25 (hours:minutes:seconds).'
    : length <= 0 ? 'The end time must come after the start time.'
      : end > duration ? 'The end time must be within the video.'
        : length > maxLength ? ($('#clip-output-format', root).value === 'gif' ? 'GIF clips can be up to 15 seconds.' : 'A clip can be up to 30 minutes long.')
          : `Selected clip: ${durationLabel(length)} · ${formatClipTime(start)} to ${formatClipTime(end)}`;
  return { valid, start, end };
}

function clipProgressUi(root) {
  if (!root?.isConnected) return;
  const busyNow = ['queued', 'downloading', 'processing'].includes(clipState.status);
  const isLocal = Boolean(clipState.media?.localMediaId);
  const mediaVisible = Boolean(clipState.media && (clipState.source === 'file') === isLocal);
  $('#clip-link-form', root).hidden = clipState.source !== 'link';
  $('#clip-file-form', root).hidden = clipState.source !== 'file';
  $$('[data-clip-source]', root).forEach(button => {
    const active = button.dataset.clipSource === clipState.source;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); button.disabled = busyNow || clipState.analyzing;
  });
  $('#clip-workspace', root).hidden = !mediaVisible;
  $('#clip-load', root).disabled = clipState.analyzing || busyNow;
  $('#clip-url', root).disabled = clipState.analyzing || busyNow;
  $('#clip-load span', root).textContent = clipState.analyzing ? (clipState.uploading ? 'Uploading…' : 'Checking link…') : 'Load link';
  $('#clip-file', root).disabled = clipState.analyzing || busyNow;
  $('#clip-file-load', root).disabled = clipState.analyzing || busyNow || !$('#clip-file', root).files?.length;
  $('#clip-file-load span', root).textContent = clipState.uploading ? `Uploading ${Math.round(clipState.uploadProgress * 100)}%…` : 'Use this video';
  const exportButton = $('#clip-export', root);
  if (mediaVisible) {
    $('#clip-name', root).textContent = clipState.media.title || 'Video link';
    $('#clip-provider', root).textContent = clipState.media.provider || (isLocal ? 'This device' : 'Supported source');
    $('#clip-duration', root).textContent = `Video length ${durationLabel(clipState.media.duration)}`;
    const thumbnail = $('#clip-thumbnail', root);
    if (clipState.media.thumbnail) { thumbnail.src = clipState.media.thumbnail; thumbnail.hidden = false; }
    else { thumbnail.removeAttribute('src'); thumbnail.hidden = true; }
    const preview = $('#clip-preview', root);
    if (clipState.media.localPreviewUrl) {
      if (preview.dataset.objectUrl !== clipState.media.localPreviewUrl) { preview.src = clipState.media.localPreviewUrl; preview.dataset.objectUrl = clipState.media.localPreviewUrl; }
      preview.hidden = false;
    } else { preview.pause(); preview.removeAttribute('src'); delete preview.dataset.objectUrl; preview.hidden = true; }
    if (clipState.syncRangeFields) {
      $('#clip-start', root).value = formatClipTime(clipState.start ?? 0);
      $('#clip-end', root).value = formatClipTime(clipState.end ?? Math.min(30, clipState.media.duration));
      clipState.syncRangeFields = false;
    }
  }
  const range = mediaVisible ? clipRangeUi(root) : { valid: false };
  const outputFormat = $('#clip-output-format', root).value;
  const gifMode = outputFormat === 'gif';
  if (gifMode && mediaVisible && clipState.end - clipState.start > 15) { clipState.end = Math.min(clipState.start + 15, clipState.media.duration); clipState.syncRangeFields = true; }
  $('#clip-export span', root).textContent = gifMode ? 'Make GIF' : 'Make clip';
  $('#clip-output-note', root).textContent = gifMode ? 'GIFs are limited to 15 seconds.' : 'Only clip media you have permission to use.';
  $('#clip-output-format', root).disabled = busyNow;
  exportButton.disabled = busyNow || !range.valid;
  for (const selector of ['#clip-start', '#clip-end', '#clip-start-range', '#clip-end-range']) $(selector, root).disabled = busyNow || !mediaVisible;
  $('#clip-progress-wrap', root).hidden = !busyNow;
  $('#clip-cancel', root).hidden = !busyNow;
  $('#clip-complete', root).hidden = clipState.status !== 'completed';
  if (busyNow) {
    const label = Math.max(0, Math.min(100, Math.round(clipState.progress || 0)));
    const gifMode = $('#clip-output-format', root).value === 'gif';
    $('#clip-status-text', root).textContent = clipState.status === 'queued' ? (gifMode ? 'Preparing your GIF…' : 'Preparing your clip…') : clipState.status === 'downloading' ? 'Fetching and cutting the selected section…' : (gifMode ? 'Rendering your GIF…' : 'Making your MP4 clip…');
    $('#clip-progress-label', root).textContent = `${label}%`;
    $('#clip-progress-bar', root).style.width = `${label}%`;
    $('.job-progress', root).setAttribute('aria-valuenow', String(label));
  }
  const message = $('#clip-message', root);
  message.hidden = !clipState.error && clipState.status !== 'cancelled';
  message.className = `clip-message${clipState.status === 'cancelled' ? ' neutral' : ''}`;
  message.textContent = clipState.status === 'cancelled' ? 'Clip export cancelled.' : (clipState.error || 'The clip could not be created.');
}

function mountClipper(root) {
  clipRoot = root;
  const mountGeneration = ++clipGeneration;
  clipState.syncRangeFields = true;
  $('#clip-link-form', root).addEventListener('submit', event => { event.preventDefault(); void analyzeClipLink(root, mountGeneration); });
  $('#clip-file-form', root).addEventListener('submit', event => { event.preventDefault(); void loadClipFile(root); });
  $('#clip-url', root).value = clipState.url;
  $('#clip-url', root).addEventListener('input', event => {
    const nextUrl = event.target.value.trim();
    if (nextUrl === clipState.url) return;
    if (clipState.media?.localPreviewUrl) URL.revokeObjectURL(clipState.media.localPreviewUrl);
    clipState.url = nextUrl; clipState.media = null; clipState.status = 'idle'; clipState.jobId = null; clipState.error = null;
    clipProgressUi(root);
  });
  $('#clip-file', root).addEventListener('change', () => clipProgressUi(root));
  $('#clip-output-format', root).addEventListener('change', event => { selectedMediaTool = event.target.value === 'gif' ? 'gif' : 'clip'; if (event.target.value === 'gif' && clipState.media) { clipState.end = Math.min(clipState.start + 15, clipState.media.duration); clipState.syncRangeFields = true; } updateMediaToolsUi(root); });
  $$('[data-clip-source]', root).forEach(button => button.addEventListener('click', () => {
    clipState.source = button.dataset.clipSource;
    if (clipState.status === 'failed' || clipState.status === 'cancelled') { clipState.status = 'idle'; clipState.error = null; }
    clipProgressUi(root);
  }));
  for (const selector of ['#clip-start', '#clip-end']) {
    $(selector, root).addEventListener('input', () => {
      if (clipState.status === 'failed' || clipState.status === 'cancelled') { clipState.status = 'idle'; clipState.error = null; }
      clipProgressUi(root);
    });
    $(selector, root).addEventListener('change', event => {
      const value = parseClipTime(event.target.value);
      if (value !== null) event.target.value = formatClipTime(value);
      clipProgressUi(root);
    });
  }
  $('#clip-start-range', root).addEventListener('input', event => {
    const start = Number(event.target.value);
    const endInput = $('#clip-end', root);
    const oldEnd = parseClipTime(endInput.value);
    $('#clip-start', root).value = formatClipTime(start);
    if (oldEnd === null || oldEnd <= start) endInput.value = formatClipTime(Math.min(clipState.media.duration, start + 1));
    clipProgressUi(root);
  });
  $('#clip-end-range', root).addEventListener('input', event => {
    const end = Number(event.target.value);
    const startInput = $('#clip-start', root);
    const oldStart = parseClipTime(startInput.value);
    $('#clip-end', root).value = formatClipTime(end);
    if (oldStart === null || oldStart >= end) startInput.value = formatClipTime(Math.max(0, end - 1));
    clipProgressUi(root);
  });
  $('#clip-export', root).addEventListener('click', () => exportClip(root));
  $('#clip-cancel', root).addEventListener('click', () => cancelClip(root));
  $('#clip-reveal', root).addEventListener('click', () => revealClip());
  clipProgressUi(root);
  if (['queued', 'downloading', 'processing'].includes(clipState.status) && clipState.jobId) void pollClip(root, mountGeneration);
}

async function loadClipFile(root) {
  if (clipState.analyzing || ['queued', 'downloading', 'processing'].includes(clipState.status)) return;
  const file = $('#clip-file', root).files?.[0];
  if (!file) return;
  if (clipState.media?.localPreviewUrl) URL.revokeObjectURL(clipState.media.localPreviewUrl);
  clipState.media = null; clipState.jobId = null; clipState.analyzing = true; clipState.uploading = true; clipState.uploadProgress = 0; clipState.status = 'idle'; clipState.error = null;
  clipProgressUi(root);
  try {
    const response = await uploadMediaFile(file, progress => { clipState.uploadProgress = progress; clipProgressUi(clipRoot?.isConnected ? clipRoot : root); });
    const media = response.media;
    if (!media?.hasVideo) throw new Error('That file does not contain video. Choose a video file to clip.');
    if (!Number.isFinite(media.duration) || media.duration <= 0) throw new Error('Xovra could not read this video’s duration, so it cannot set clip points.');
    if (clipState.media?.localPreviewUrl) URL.revokeObjectURL(clipState.media.localPreviewUrl);
    clipState.source = 'file';
    clipState.media = { ...media, localPreviewUrl: URL.createObjectURL(file) };
    clipState.start = 0; clipState.end = Math.min(30, media.duration); clipState.jobId = null; clipState.progress = 0; clipState.syncRangeFields = true;
  } catch (error) { clipState.status = 'failed'; clipState.error = error.message; }
  finally { clipState.analyzing = false; clipState.uploading = false; clipState.uploadProgress = 0; clipProgressUi(clipRoot?.isConnected ? clipRoot : root); }
}

async function analyzeClipLink(root, generation) {
  if (!root.isConnected || clipState.analyzing || ['queued', 'downloading', 'processing'].includes(clipState.status)) return;
  const url = $('#clip-url', root).value.trim();
  if (!url) return;
  clipState.source = 'link'; clipState.url = url; clipState.media = null; clipState.jobId = null; clipState.status = 'idle'; clipState.progress = 0; clipState.error = null; clipState.analyzing = true;
  clipProgressUi(root);
  try {
    const data = await api('/analyze', { method: 'POST', body: JSON.stringify({ url }) });
    if (generation !== clipGeneration) return;
    if (!data.media?.hasVideo) throw new Error('This link contains audio only. Add a video link to use the clipper.');
    if (!Number.isFinite(data.media?.duration) || data.media.duration <= 0) throw new Error('This link does not provide a video duration, so Xovra cannot set clip points for it.');
    clipState.media = data.media;
    clipState.start = 0;
    clipState.end = Math.min(30, data.media.duration);
    clipState.syncRangeFields = true;
  } catch (error) {
    if (generation === clipGeneration) { clipState.status = 'failed'; clipState.error = error.message; }
  } finally {
    clipState.analyzing = false;
    const activeRoot = clipRoot?.isConnected ? clipRoot : root;
    if (activeRoot.isConnected) clipProgressUi(activeRoot);
  }
}

async function exportClip(root) {
  if (!clipState.media || !root.isConnected || ['queued', 'downloading', 'processing'].includes(clipState.status)) return;
  const start = parseClipTime($('#clip-start', root).value);
  const end = parseClipTime($('#clip-end', root).value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > clipState.media.duration || end - start > 1800) {
    clipState.status = 'failed'; clipState.error = 'Choose a valid time range within this video. Clips can be up to 30 minutes.'; clipProgressUi(root); return;
  }
  clipState.start = start; clipState.end = end; clipState.jobId = null; clipState.status = 'queued'; clipState.progress = 0; clipState.error = null;
  const generation = ++clipGeneration;
  clipProgressUi(root);
  try {
    const body = { start, end, outputFormat: $('#clip-output-format', root).value };
    if (clipState.media.localMediaId) body.localMediaId = clipState.media.localMediaId;
    else body.analysisId = clipState.media.analysisId;
    const response = await api('/tools/clip', { method: 'POST', body: JSON.stringify(body) });
    const job = response.job;
    clipState.jobId = job.id; clipState.status = job.status; clipState.progress = job.progress || 0;
    const activeRoot = clipRoot?.isConnected ? clipRoot : root;
    clipProgressUi(activeRoot);
    await pollClip(activeRoot, clipGeneration);
  } catch (error) {
    clipState.status = error.message === 'Clip export cancelled.' ? 'cancelled' : 'failed';
    clipState.error = error.message; clipProgressUi(root);
  }
}

async function pollClip(root, generation) {
  while (generation === clipGeneration && clipState.jobId && ['queued', 'downloading', 'processing'].includes(clipState.status)) {
    try {
      const result = await api(`/tools/clip/${clipState.jobId}`, { signal: AbortSignal.timeout(6000) });
      clipState.status = result.job.status; clipState.progress = result.job.progress || 0; clipState.error = result.job.error || null;
      if (root.isConnected) clipProgressUi(root);
      if (!['queued', 'downloading', 'processing'].includes(clipState.status)) break;
    } catch (error) {
      clipState.status = 'failed'; clipState.error = error.message; if (root.isConnected) clipProgressUi(root); break;
    }
    await new Promise(resolve => { clipPollTimer = setTimeout(() => { clipPollTimer = null; resolve(); }, 700); });
  }
}

async function cancelClip(root) {
  if (!clipState.jobId) return;
  try { const result = await api(`/tools/clip/${clipState.jobId}/cancel`, { method: 'POST', body: '{}' }); clipState.status = result.job.status; clipState.error = result.job.error || null; clipProgressUi(root); }
  catch (error) { clipState.status = 'failed'; clipState.error = error.message; clipProgressUi(root); }
}

async function revealClip() {
  if (!clipState.jobId) return;
  try { await api(`/tools/clip/${clipState.jobId}/reveal`, { method: 'POST', body: '{}' }); }
  catch (error) { notify(error.message); }
}

const urlToolDetails = {
  compress: { title: 'Compress video', copy: 'Make a smaller MP4 while keeping the picture clear.', action: 'Compress video', output: 'MP4 output · Saved in Downloads/Xovra/Tools', icon: '<path d="M4 7V4h3m10 0h3v3M4 17v3h3m10 0h3v-3M8 12h8m-4-4v8"/>' },
  convert: { title: 'Convert video', copy: 'Make a copy in another common video format.', action: 'Convert video', output: 'Choose MP4, WebM, MOV or MKV · Saved locally', icon: '<path d="M4 7h14l-3-3m5 13H6l3 3M18 7l2-3M6 17l-2 3"/>' },
  audio: { title: 'Extract audio', copy: 'Save audio from a supported link or a file on your device.', action: 'Extract audio', output: 'Choose MP3, M4A, Opus, WAV or FLAC · Saved locally', icon: '<path d="M4 10v4m4-8v12m4-15v18m4-14v10m4-7v4"/>' }
};
const toolBusyStatuses = ['queued', 'downloading', 'processing'];
let urlToolRoot = null;

function updateMediaToolsUi(root) {
  if (!root?.isConnected) return;
  const tabs = $$('[data-tool]', root);
  const clipPanel = $('#clipper-panel', root);
  const toolPanel = $('#url-tool-panel', root);
  const isClip = selectedMediaTool === 'clip' || selectedMediaTool === 'gif';
  clipPanel.hidden = !isClip;
  toolPanel.hidden = isClip;
  if (isClip) {
    const gifMode = selectedMediaTool === 'gif';
    $('#clip-output-format', root).value = gifMode ? 'gif' : 'mp4';
    $('#clipper-heading', root).textContent = gifMode ? 'GIF maker' : 'Video clipper';
    $('#clipper-copy', root).textContent = gifMode ? 'Select a short section and save it as a looping GIF.' : 'Paste a video link, choose a section and save the clip.';
    if (gifMode && clipState.media && clipState.end - clipState.start > 15) { clipState.end = Math.min(clipState.start + 15, clipState.media.duration); clipState.syncRangeFields = true; }
  }
  for (const tab of tabs) {
    const selected = tab.dataset.tool === selectedMediaTool;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-pressed', String(selected));
    tab.disabled = (toolBusyStatuses.includes(urlToolState.status) || toolBusyStatuses.includes(clipState.status)) && !selected;
  }
  if (isClip) { clipProgressUi(root); return; }
  const details = urlToolDetails[selectedMediaTool] || urlToolDetails.compress;
  $('#url-tool-heading', root).textContent = details.title;
  $('#url-tool-copy', root).textContent = details.copy;
  $('#url-tool-run span', root).textContent = details.action;
  $('#url-tool-output-note', root).textContent = details.output;
  $('#url-tool-icon', root).innerHTML = details.icon;
  $$('[data-option]', root).forEach(option => { option.hidden = option.dataset.option !== selectedMediaTool; });
  const busyNow = toolBusyStatuses.includes(urlToolState.status);
  const media = urlToolState.media;
  const mediaIsLocal = Boolean(media?.localMediaId);
  const mediaVisible = Boolean(media && (urlToolState.source === 'file') === mediaIsLocal);
  $('#url-tool-form', root).hidden = urlToolState.source !== 'link';
  $('#url-tool-file-form', root).hidden = urlToolState.source !== 'file';
  $$('[data-url-source]', root).forEach(button => {
    const active = button.dataset.urlSource === urlToolState.source;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); button.disabled = busyNow || urlToolState.analyzing;
  });
  $('#url-tool-load', root).disabled = busyNow || urlToolState.analyzing;
  $('#url-tool-url', root).disabled = busyNow || urlToolState.analyzing;
  $('#url-tool-load span', root).textContent = urlToolState.analyzing ? 'Checking link…' : 'Load link';
  $('#url-tool-file', root).disabled = busyNow || urlToolState.analyzing;
  $('#url-tool-file-load', root).disabled = busyNow || urlToolState.analyzing || !$('#url-tool-file', root).files?.length;
  $('#url-tool-file-load span', root).textContent = urlToolState.uploading ? `Uploading ${Math.round(urlToolState.uploadProgress * 100)}%…` : 'Use this file';
  $('#url-tool-workspace', root).hidden = !mediaVisible;
  if (mediaVisible) {
    $('#url-tool-name', root).textContent = media.title || 'Media link';
    $('#url-tool-provider', root).textContent = media.provider || 'Supported source';
    $('#url-tool-duration', root).textContent = Number.isFinite(media.duration) ? `${media.hasVideo ? 'Video' : 'Audio'} length ${durationLabel(media.duration)}` : (media.hasVideo ? 'Video link' : 'Audio link');
    const thumbnail = $('#url-tool-thumbnail', root);
    if (media.thumbnail) { thumbnail.src = media.thumbnail; thumbnail.hidden = false; }
    else { thumbnail.removeAttribute('src'); thumbnail.hidden = true; }
  }
  const supportsSelection = mediaVisible && (selectedMediaTool === 'audio' ? (mediaIsLocal ? media.hasAudio : media.hasAudio || media.hasVideo) : media.hasVideo);
  const unavailableMessage = mediaVisible && !supportsSelection ? (selectedMediaTool === 'audio' ? 'This file has no audio track to extract.' : 'This file contains no video to process.') : '';
  $('#url-tool-run', root).disabled = busyNow || !supportsSelection;
  $('#compress-quality', root).disabled = busyNow;
  $('#convert-format', root).disabled = busyNow;
  $('#audio-format', root).disabled = busyNow;
  $('#url-tool-progress-wrap', root).hidden = !busyNow;
  $('#url-tool-cancel', root).hidden = !busyNow;
  $('#url-tool-complete', root).hidden = urlToolState.status !== 'completed';
  $('#url-tool-complete-text', root).textContent = urlToolState.outputName ? `Saved: ${urlToolState.outputName}` : 'Your file is ready.';
  if (busyNow) {
    const percent = Math.max(0, Math.min(100, Math.round(urlToolState.progress || 0)));
    $('#url-tool-status-text', root).textContent = urlToolState.status === 'queued' ? 'Preparing the link…' : urlToolState.status === 'downloading' ? 'Downloading source video…' : 'Processing with FFmpeg…';
    $('#url-tool-progress-label', root).textContent = `${percent}%`;
    $('#url-tool-progress-bar', root).style.width = `${percent}%`;
    $('.job-progress', root).setAttribute('aria-valuenow', String(percent));
  }
  const message = $('#url-tool-message', root);
  const isCancelled = urlToolState.status === 'cancelled';
  message.hidden = !urlToolState.error && !isCancelled && !unavailableMessage;
  message.className = `clip-message${isCancelled ? ' neutral' : ''}`;
  message.textContent = isCancelled ? 'Processing cancelled.' : (urlToolState.error || unavailableMessage);
}

function mountUrlTool(root) {
  urlToolRoot = root;
  const mountGeneration = ++urlToolGeneration;
  $('#url-tool-form', root).addEventListener('submit', event => { event.preventDefault(); void analyzeUrlToolLink(root); });
  $('#url-tool-file-form', root).addEventListener('submit', event => { event.preventDefault(); void loadUrlToolFile(root); });
  $('#url-tool-file', root).addEventListener('change', () => updateMediaToolsUi(root));
  $$('[data-url-source]', root).forEach(button => button.addEventListener('click', () => {
    urlToolState.source = button.dataset.urlSource;
    if (urlToolState.status === 'failed' || urlToolState.status === 'cancelled') { urlToolState.status = 'idle'; urlToolState.error = null; }
    updateMediaToolsUi(root);
  }));
  $('#url-tool-url', root).value = urlToolState.url;
  $('#url-tool-url', root).addEventListener('input', event => {
    const nextUrl = event.target.value.trim();
    if (nextUrl === urlToolState.url) return;
    urlToolState.url = nextUrl; urlToolState.media = null; urlToolState.jobId = null; urlToolState.outputName = null; urlToolState.status = 'idle'; urlToolState.error = null;
    updateMediaToolsUi(root);
  });
  $('#url-tool-run', root).addEventListener('click', () => void runUrlTool(root));
  $('#url-tool-cancel', root).addEventListener('click', () => void cancelUrlTool(root));
  $('#url-tool-reveal', root).addEventListener('click', () => void revealUrlTool());
  if (toolBusyStatuses.includes(urlToolState.status) && urlToolState.jobId) void pollUrlTool(root, mountGeneration);
}

function mountMediaTools(root) {
  clipRoot = root;
  mountClipper(root);
  mountUrlTool(root);
  $$('[data-tool]', root).forEach(tab => tab.addEventListener('click', () => {
    selectedMediaTool = tab.dataset.tool;
    updateMediaToolsUi(root);
  }));
  updateMediaToolsUi(root);
  if (toolBusyStatuses.includes(clipState.status) && clipState.jobId) void pollClip(root, clipGeneration);
}

async function analyzeUrlToolLink(root) {
  if (!root.isConnected || urlToolState.analyzing || toolBusyStatuses.includes(urlToolState.status)) return;
  const url = $('#url-tool-url', root).value.trim();
  if (!url) return;
  const generation = ++urlToolGeneration;
  urlToolState.source = 'link'; urlToolState.url = url; urlToolState.media = null; urlToolState.jobId = null; urlToolState.outputName = null; urlToolState.status = 'idle'; urlToolState.progress = 0; urlToolState.error = null; urlToolState.analyzing = true;
  updateMediaToolsUi(root);
  try {
    const data = await api('/analyze', { method: 'POST', body: JSON.stringify({ url }) });
    if (generation !== urlToolGeneration) return;
    urlToolState.media = data.media;
  } catch (error) {
    if (generation === urlToolGeneration) { urlToolState.status = 'failed'; urlToolState.error = error.message; }
  } finally {
    urlToolState.analyzing = false;
    const activeRoot = urlToolRoot?.isConnected ? urlToolRoot : root;
    if (activeRoot.isConnected) updateMediaToolsUi(activeRoot);
  }
}

async function loadUrlToolFile(root) {
  if (urlToolState.analyzing || toolBusyStatuses.includes(urlToolState.status)) return;
  const file = $('#url-tool-file', root).files?.[0];
  if (!file) return;
  urlToolState.media = null; urlToolState.jobId = null; urlToolState.outputName = null; urlToolState.status = 'idle'; urlToolState.error = null; urlToolState.analyzing = true; urlToolState.uploading = true; urlToolState.uploadProgress = 0;
  updateMediaToolsUi(root);
  try {
    const response = await uploadMediaFile(file, progress => { urlToolState.uploadProgress = progress; updateMediaToolsUi(urlToolRoot?.isConnected ? urlToolRoot : root); });
    urlToolState.source = 'file';
    urlToolState.media = response.media;
  } catch (error) { urlToolState.status = 'failed'; urlToolState.error = error.message; }
  finally {
    urlToolState.analyzing = false; urlToolState.uploading = false; urlToolState.uploadProgress = 0;
    updateMediaToolsUi(urlToolRoot?.isConnected ? urlToolRoot : root);
  }
}

async function runUrlTool(root) {
  if (!urlToolState.media || !root.isConnected || toolBusyStatuses.includes(urlToolState.status)) return;
  const media = urlToolState.media;
  const hasRequiredTrack = selectedMediaTool === 'audio' ? (media.localMediaId ? media.hasAudio : media.hasAudio || media.hasVideo) : media.hasVideo;
  if (!hasRequiredTrack) return;
  const body = { operation: selectedMediaTool };
  if (media.localMediaId) body.localMediaId = media.localMediaId;
  else body.analysisId = media.analysisId;
  if (selectedMediaTool === 'compress') body.quality = $('#compress-quality', root).value;
  if (selectedMediaTool === 'convert') body.outputFormat = $('#convert-format', root).value;
  if (selectedMediaTool === 'audio') body.outputFormat = $('#audio-format', root).value;
  ++urlToolGeneration;
  urlToolState.status = 'queued'; urlToolState.jobId = null; urlToolState.progress = 0; urlToolState.error = null;
  updateMediaToolsUi(root);
  try {
    const response = await api('/tools/process', { method: 'POST', body: JSON.stringify(body) });
    urlToolState.jobId = response.job.id; urlToolState.outputName = response.job.outputName || null; urlToolState.status = response.job.status; urlToolState.progress = response.job.progress || 0;
    const activeRoot = urlToolRoot?.isConnected ? urlToolRoot : root;
    updateMediaToolsUi(activeRoot);
    await pollUrlTool(activeRoot, urlToolGeneration);
  } catch (error) {
    urlToolState.status = 'failed'; urlToolState.error = error.message;
    updateMediaToolsUi(urlToolRoot?.isConnected ? urlToolRoot : root);
  }
}

async function pollUrlTool(root, generation) {
  while (generation === urlToolGeneration && urlToolState.jobId && toolBusyStatuses.includes(urlToolState.status)) {
    try {
      const result = await api(`/tools/process/${urlToolState.jobId}`, { signal: AbortSignal.timeout(6000) });
      urlToolState.status = result.job.status; urlToolState.outputName = result.job.outputName || urlToolState.outputName; urlToolState.progress = result.job.progress || 0; urlToolState.error = result.job.error || null;
      if (root.isConnected) updateMediaToolsUi(root);
      if (!toolBusyStatuses.includes(urlToolState.status)) break;
    } catch (error) {
      urlToolState.status = 'failed'; urlToolState.error = error.message; if (root.isConnected) updateMediaToolsUi(root); break;
    }
    await new Promise(resolve => { urlToolPollTimer = setTimeout(() => { urlToolPollTimer = null; resolve(); }, 700); });
  }
}

async function cancelUrlTool(root) {
  if (!urlToolState.jobId) return;
  try { const result = await api(`/tools/process/${urlToolState.jobId}/cancel`, { method: 'POST', body: '{}' }); urlToolState.status = result.job.status; urlToolState.error = result.job.error || null; updateMediaToolsUi(root); }
  catch (error) { urlToolState.status = 'failed'; urlToolState.error = error.message; updateMediaToolsUi(root); }
}

async function revealUrlTool() {
  if (!urlToolState.jobId) return;
  try { await api(`/tools/process/${urlToolState.jobId}/reveal`, { method: 'POST', body: '{}' }); }
  catch (error) { notify(error.message); }
}

function showPage(page) {
  if (page !== 'tools') { clipGeneration++; urlToolGeneration++; clipRoot = null; urlToolRoot = null; }
  currentPage = page; const analyzer = page === 'analyzer';
  $('#analyzer-view').hidden = !analyzer; $('#secondary-view').hidden = analyzer;
  $('#breadcrumb-page').textContent = pageNames[page] || pageNames.analyzer;
  $$('.nav-item[data-page]').forEach(item => { const active = item.dataset.page === page; item.classList.toggle('active', active); if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
  if (analyzer) return;
  const titles = { downloads: 'Downloads', tools: 'Media tools', history: 'Recent links', settings: 'Settings' };
  const descriptions = { downloads: 'Active and completed downloads stay on this device.', tools: 'Clip, compress, convert or extract audio from a link or file.', history: 'Links and downloads are stored on this device.', settings: 'Manage your appearance and local engine.' };
  $('#secondary-title').textContent = titles[page] || 'Xovra'; $('#secondary-copy').textContent = descriptions[page] || '';
  const content = $('#secondary-content'); content.replaceChildren();
  if (page === 'history') { renderHistory(content); if (readHistory().length) addButton(content, 'Clear history', clearHistory); }
  else if (page === 'downloads') { const empty = document.createElement('p'); empty.className = 'secondary-empty'; empty.textContent = 'Loading your queue…'; content.append(empty); void refreshJobs(); }
  else if (page === 'tools') { content.append($('#clipper-template').content.cloneNode(true)); mountMediaTools(content); }
  else if (page === 'settings') {
    const themeRow = document.createElement('div'); themeRow.className = 'setting-row'; const themeInfo = document.createElement('div');
    const themeTitle = document.createElement('strong'); themeTitle.textContent = 'Appearance'; const themeDescription = document.createElement('span'); themeDescription.textContent = 'Choose light or dark theme.'; themeInfo.append(themeTitle, themeDescription);
    const theme = document.createElement('select'); theme.setAttribute('aria-label', 'Appearance');
    for (const [value, label] of [['light', 'Light'], ['dark', 'Dark']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; theme.append(option); }
    theme.value = document.documentElement.dataset.theme; theme.addEventListener('change', () => setTheme(theme.value)); themeRow.append(themeInfo, theme); content.append(themeRow);
    const engineRow = document.createElement('div'); engineRow.className = 'setting-row'; const engineInfo = document.createElement('div'); const engineTitle = document.createElement('strong'); engineTitle.textContent = 'Local engine'; const engineDescription = document.createElement('span'); engineDescription.textContent = engineState?.ready ? (engineState.ffmpeg.available ? 'Connected · yt-dlp and FFmpeg ready' : 'Connected · FFmpeg not found') : 'Not connected'; engineInfo.append(engineTitle, engineDescription); engineRow.append(engineInfo); addButton(engineRow, engineState?.desktop ? 'Engine status' : 'Engine setup', openConnect); content.append(engineRow);
    const historyRow = document.createElement('div'); historyRow.className = 'setting-row'; const historyInfo = document.createElement('div'); const historyTitle = document.createElement('strong'); historyTitle.textContent = 'Local history'; const historyDescription = document.createElement('span'); historyDescription.textContent = `${readHistory().length} saved links on this device.`; historyInfo.append(historyTitle, historyDescription); historyRow.append(historyInfo); addButton(historyRow, 'Clear history', clearHistory); content.append(historyRow);
    const updatesRow = document.createElement('div'); updatesRow.className = 'setting-row'; const updatesInfo = document.createElement('div'); const updatesTitle = document.createElement('strong'); updatesTitle.textContent = 'App updates'; const updatesDescription = document.createElement('span'); updatesDescription.textContent = engineState?.version ? `Current version ${engineState.version} · Updates install from GitHub Releases.` : 'Check GitHub Releases for the latest installer.'; updatesInfo.append(updatesTitle, updatesDescription); updatesRow.append(updatesInfo);
    const updateStatus = document.createElement('span'); updateStatus.className = 'setting-status'; updateStatus.setAttribute('aria-live', 'polite'); updatesInfo.append(updateStatus);
    const checkButton = addButton(updatesRow, 'Check for updates', async () => { checkButton.disabled = true; updateStatus.textContent = 'Checking…'; const result = await checkForAppUpdate(engineState, true); checkButton.disabled = false; updateStatus.textContent = !result ? 'Could not check right now. Try again later.' : result.updateAvailable ? `Version ${result.latestVersion} is ready to install.` : result.latestVersion ? `You’re up to date · v${result.currentVersion}.` : 'Could not check right now. Try again later.'; }, 'setting-action'); content.append(updatesRow);
    const autoRow = document.createElement('div'); autoRow.className = 'setting-row'; const autoInfo = document.createElement('div'); const autoTitle = document.createElement('strong'); autoTitle.textContent = 'Check on startup'; const autoDescription = document.createElement('span'); autoDescription.textContent = 'Show an update notice when a new desktop release is available.'; autoInfo.append(autoTitle, autoDescription); autoRow.append(autoInfo); const autoCheck = document.createElement('input'); autoCheck.type = 'checkbox'; autoCheck.className = 'setting-checkbox'; autoCheck.checked = localStorage.getItem('xovra-auto-update') !== 'false'; autoCheck.setAttribute('aria-label', 'Check for updates on startup'); autoCheck.addEventListener('change', () => { try { localStorage.setItem('xovra-auto-update', String(autoCheck.checked)); } catch {} }); autoRow.append(autoCheck); content.append(autoRow);
    const notes = document.createElement('section'); notes.className = 'release-notes'; const notesTitle = document.createElement('h2'); notesTitle.textContent = 'What’s new'; notes.append(notesTitle);
    for (const [title, description] of [['A refreshed media desk', 'A clearer link workbench, a more useful recent-links rail, and a layout shaped for both desktop and mobile.'], ['Tools one step away', 'Jump directly from Analyzer into Clip, Convert or Extract Audio.'], ['Keep your place', 'Your source choice, formats, recent links, and update settings continue to work as before.']]) { const note = document.createElement('p'); const label = document.createElement('strong'); label.textContent = title; note.append(label, document.createTextNode(description)); notes.append(note); } content.append(notes);
  }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#171a15' : '#f2f1e7';
  $('.theme-toggle').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
  try { localStorage.setItem('xovra-theme', theme); } catch {}
  if (currentPage === 'settings') showPage('settings');
}
function clearHistory() {
  try { localStorage.removeItem(historyKey); } catch {}
  renderRecent(); if (currentPage === 'history' || currentPage === 'settings') showPage(currentPage); notify('Local history cleared.');
}

function setEngineUi(status, online = true) {
  engineState = online ? status : null;
  const root = document.documentElement;
  const setupCommand = $('#engine-setup-command');
  const engineNote = $('#engine-note');
  setupCommand.hidden = Boolean(status?.desktop);
  engineNote.textContent = status?.desktop
    ? 'Xovra keeps the media engine inside its app folder. Your downloads stay on this device.'
    : 'FFmpeg and FFprobe must be installed and available on your PATH. No private or DRM-protected content is supported.';
  if (!online) {
    root.dataset.engine = 'offline';
    $('#mobile-engine-status').hidden = true;
    $('#engine-status-title').textContent = 'Local engine isn’t running.';
    $('#engine-status-copy').textContent = 'Start Xovra with npm start, then open it at 127.0.0.1:4317.';
    $('#engine-sidebar-status').textContent = 'Engine not running';
    $('#engine-banner').hidden = false;
    $('#connect-dialog-copy').textContent = 'Open a terminal in the Xovra folder and run npm start. Then visit http://127.0.0.1:4317.';
    return;
  }
  if (!status.ytdlp.available) {
    root.dataset.engine = 'missing';
    $('#mobile-engine-status').hidden = true;
    $('#engine-status-title').textContent = status.desktop ? 'The bundled extractor is missing.' : 'The extractor needs setup.';
    $('#engine-status-copy').textContent = status.desktop ? 'Reinstall Xovra to restore its media engine.' : 'Install yt-dlp once to analyze links and fetch their actual formats.';
    $('#engine-sidebar-status').textContent = 'Engine setup needed';
    $('#engine-banner').hidden = false;
    $('#connect-dialog-copy').textContent = status.desktop
      ? 'Xovra’s bundled yt-dlp engine could not be found. Reinstall the app to restore its media engine.'
      : 'Run the one-time setup command below. It downloads the official yt-dlp release and checks its SHA-256 checksum before installing it in this project.';
    return;
  }
  if (!status.ffmpeg.available) {
    root.dataset.engine = 'partial';
    $('#mobile-engine-status').hidden = true;
    $('#engine-status-title').textContent = status.desktop ? 'The bundled FFmpeg engine is missing.' : 'The analyzer is ready; FFmpeg is missing.';
    $('#engine-status-copy').textContent = status.desktop ? 'Reinstall Xovra to restore media conversion and merging.' : 'Some separate video and audio streams need FFmpeg to merge.';
    $('#engine-sidebar-status').textContent = 'FFmpeg not found';
    $('#engine-banner').hidden = false;
    $('#connect-dialog-copy').textContent = status.desktop
      ? 'Xovra’s bundled FFmpeg could not be found. Reinstall the app to restore media conversion and merging.'
      : 'yt-dlp is connected. Install FFmpeg using the instructions in the local engine README, and make sure ffmpeg is available on PATH.';
    return;
  }
  root.dataset.engine = 'ready';
  $('#mobile-engine-status').hidden = false;
  $('#engine-status-title').textContent = 'Local engine ready.';
  $('#engine-status-copy').textContent = 'Source formats will be read live; downloads stay on this device.';
  $('#engine-sidebar-status').textContent = 'Local engine ready';
  $('#engine-banner').hidden = true;
  $('#connect-dialog-copy').textContent = status.desktop
    ? 'The Xovra media engine is installed and ready on this device.'
    : 'yt-dlp and FFmpeg are available. Paste a public media link and Xovra will show the formats returned by its source.';
}
async function checkForAppUpdate(status, manual = false) {
  if (!status?.desktop && !manual) return null;
  try {
    const update = await api(manual ? '/update?refresh=1' : '/update', { signal: AbortSignal.timeout(9000) });
    if (update.updateAvailable && update.releaseUrl) {
      $('#update-banner-copy').textContent = `Version ${update.latestVersion} is ready. You have ${update.currentVersion}; install the new package to update.`;
      $('#update-banner-link').href = update.releaseUrl;
      $('#update-banner').hidden = false;
    } else if (manual) $('#update-banner').hidden = true;
    return update;
  } catch { return null; }
}
$('#dismiss-update').addEventListener('click', () => { $('#update-banner').hidden = true; });
async function refreshEngineStatus() {
  try {
    const status = await api('/status', { signal: AbortSignal.timeout(7000) });
    setEngineUi(status, true);
    if (localStorage.getItem('xovra-auto-update') !== 'false') void checkForAppUpdate(status);
  } catch { setEngineUi(null, false); }
}
function openConnect() { $('#connect-dialog').showModal(); }

// A clean first-run state keeps the Auto source chip selected until a link is detected.
setSource('auto', 'auto');
$$('.source-option[data-source]').forEach(button => button.addEventListener('click', () => button.dataset.source === 'auto' ? setSource('auto', 'auto') : setSource(button.dataset.source)));
$('#source-override').addEventListener('change', event => { const value = event.target.value; if (value !== 'more') setSource(value); else setSource('auto', 'auto'); });
input.addEventListener('input', () => { $('#clear-input').hidden = !input.value; composer.classList.remove('invalid'); hideMessage(); updateSourceSelection(); });
input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); analyze(); } });
$('#analyze-form').addEventListener('submit', event => { event.preventDefault(); analyze(); });
$('#clear-input').addEventListener('click', () => { input.value = ''; $('#clear-input').hidden = true; updateSourceSelection(); input.focus(); });
$('#batch-toggle').addEventListener('click', () => { batchMode = !batchMode; $('#batch-area').hidden = !batchMode; $('#batch-toggle').setAttribute('aria-expanded', String(batchMode)); $('#batch-toggle').textContent = batchMode ? 'Use one link' : 'Add multiple links'; if (batchMode) $('#batch-urls').focus(); updateSourceSelection(); });
$('#batch-urls').addEventListener('input', updateSourceSelection);
$('#clear-recent').addEventListener('click', clearHistory);
$$('.nav-item[data-page]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
$('.quick-tools-all').addEventListener('click', () => showPage('tools'));
$$('[data-open-tool]').forEach(button => button.addEventListener('click', () => { selectedMediaTool = button.dataset.openTool; showPage('tools'); }));
$$('.brand').forEach(brand => brand.addEventListener('click', event => { event.preventDefault(); showPage('analyzer'); }));
$('.theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
$('#connect-engine').addEventListener('click', openConnect);
$('#close-connect').addEventListener('click', () => $('#connect-dialog').close());
$('#connect-settings').addEventListener('click', () => { $('#connect-dialog').close(); showPage('settings'); });
composer.addEventListener('dragover', event => { event.preventDefault(); composer.classList.add('dragover'); });
composer.addEventListener('dragleave', () => composer.classList.remove('dragover'));
composer.addEventListener('drop', event => { event.preventDefault(); composer.classList.remove('dragover'); const value = event.dataTransfer?.getData('text/plain')?.trim(); if (value) { input.value = value; $('#clear-input').hidden = false; updateSourceSelection(); input.focus(); } });
document.addEventListener('paste', event => { if (document.activeElement === input || document.activeElement === $('#batch-urls')) return; const value = event.clipboardData?.getData('text')?.trim(); if (value && validWebUrl(value)) { input.value = value; $('#clear-input').hidden = false; updateSourceSelection(); input.focus(); } });
try { const theme = localStorage.getItem('xovra-theme'); if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme; } catch {}
if (document.documentElement.dataset.theme === 'dark') $('.theme-toggle').setAttribute('aria-label', 'Switch to light theme');
$('meta[name="theme-color"]').content = document.documentElement.dataset.theme === 'dark' ? '#171a15' : '#f2f1e7';
renderRecent(); void refreshEngineStatus(); void refreshJobs();
if (location.protocol !== 'file:') window.setInterval(() => { void refreshJobs(); }, 2500);
