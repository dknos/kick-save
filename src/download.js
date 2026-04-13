/**
 * download.js — HLS parsing, segment downloading, time-range clipping, live recording
 */
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { curlGet } = require('./api');
const { getFFmpegPath } = require('./setup');

const CURL_HEADERS = [
  '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  '-H', 'Referer: https://kick.com/',
  '-H', 'Origin: https://kick.com',
];

// ── Time parsing ──────────────────────────────────────────────────────────
function parseTimestamp(str) {
  if (!str || !str.trim()) return null;
  const parts = str.trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function parseTimeRange(str) {
  if (!str || !str.trim()) return null;
  const [startStr, endStr] = str.split('-').map(s => s.trim());
  const start = parseTimestamp(startStr);
  const end = parseTimestamp(endStr);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTimestamp(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── HLS parsing ───────────────────────────────────────────────────────────
function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const streams = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const playlistLine = lines[i + 1];
    if (!playlistLine || playlistLine.startsWith('#')) continue;
    const bw  = lines[i].match(/BANDWIDTH=(\d+)/);
    const res = lines[i].match(/RESOLUTION=(\d+x\d+)/);
    const fps = lines[i].match(/FRAME-RATE=([\d.]+)/);
    const url = playlistLine.startsWith('http') ? playlistLine : new URL(playlistLine, baseUrl).href;
    // Derive quality label from URL path (e.g. "720p60")
    const labelMatch = playlistLine.match(/([\dp]+)/);
    streams.push({
      bandwidth:  bw ? parseInt(bw[1]) : 0,
      resolution: res ? res[1] : '?',
      fps:        fps ? parseFloat(fps[1]) : 30,
      url,
      label:      labelMatch ? labelMatch[1] : (res ? res[1] : '?'),
    });
  }
  streams.sort((a, b) => b.bandwidth - a.bandwidth);
  return streams;
}

function parseSegmentPlaylist(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim());
  const segments = [];
  let duration = 0;
  for (let i = 0; i < lines.length; i++) {
    const durMatch = lines[i].match(/^#EXTINF:([\d.]+)/);
    if (durMatch) {
      duration = parseFloat(durMatch[1]);
      continue;
    }
    if (lines[i] && !lines[i].startsWith('#')) {
      const url = lines[i].startsWith('http') ? lines[i] : new URL(lines[i], baseUrl).href;
      segments.push({ url, duration });
    }
  }
  return segments;
}

// ── Fetch & parse m3u8 ────────────────────────────────────────────────────
function fetchM3U8(url) {
  return curlGet(url, '*/*');
}

function getQualities(m3u8Url) {
  const text = fetchM3U8(m3u8Url);
  if (!text.includes('#EXTM3U')) throw new Error('Invalid m3u8');
  if (text.includes('#EXT-X-STREAM-INF')) {
    return { type: 'master', streams: parseMasterPlaylist(text, m3u8Url) };
  }
  return { type: 'segments', segments: parseSegmentPlaylist(text, m3u8Url) };
}

// ── Time-range segment selection ──────────────────────────────────────────
function selectSegments(segments, timeRange) {
  if (!timeRange) return { selected: segments, trimStart: 0, trimEnd: 0 };

  let cumulative = 0;
  let startIdx = -1, endIdx = -1;
  let trimStart = 0;

  for (let i = 0; i < segments.length; i++) {
    const segStart = cumulative;
    const segEnd = cumulative + segments[i].duration;

    if (startIdx === -1 && segEnd > timeRange.start) {
      startIdx = i;
      trimStart = timeRange.start - segStart;
    }
    if (segStart < timeRange.end) {
      endIdx = i;
    }
    cumulative += segments[i].duration;
  }

  if (startIdx === -1 || endIdx === -1) throw new Error('Time range outside video bounds');

  const selected = segments.slice(startIdx, endIdx + 1);
  const totalDuration = timeRange.end - timeRange.start;
  return { selected, trimStart, totalDuration };
}

// ── Parallel segment download ─────────────────────────────────────────────
async function downloadSegments(segments, tmpDir, concurrency = 8, onProgress) {
  const segFiles = [];
  let done = 0;
  const total = segments.length;

  for (let i = 0; i < total; i += concurrency) {
    const batch = segments.slice(i, i + concurrency);
    await Promise.all(batch.map((seg, bi) => {
      const idx = i + bi;
      const dest = path.join(tmpDir, `seg${String(idx).padStart(6, '0')}.ts`);
      segFiles[idx] = dest;
      return new Promise((resolve, reject) => {
        const proc = spawn('curl', [
          '-s', '-L', '--max-time', '120', '--retry', '3',
          ...CURL_HEADERS, seg.url, '-o', dest
        ]);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`curl seg ${idx} exit ${code}`)));
        proc.on('error', reject);
      });
    }));
    done += batch.length;
    if (onProgress) onProgress(done, total);
  }
  return segFiles;
}

// ── ffmpeg remux ──────────────────────────────────────────────────────────
function remux(segFiles, outputFile, { trimStart = 0, totalDuration = 0 } = {}) {
  const tmpDir = path.dirname(segFiles[0]);
  const concatList = path.join(tmpDir, 'concat.txt');
  fs.writeFileSync(concatList, segFiles.map(f => `file '${f}'`).join('\n'));

  const ffmpeg = getFFmpegPath();
  const args = ['-f', 'concat', '-safe', '0', '-i', concatList];

  if (trimStart > 0) args.push('-ss', String(trimStart));
  if (totalDuration > 0) args.push('-t', String(totalDuration));

  args.push('-c', 'copy', '-movflags', '+faststart', '-y', outputFile);

  const res = spawnSync(ffmpeg, args, { stdio: 'pipe', timeout: 600000 });
  if (res.status !== 0) {
    const err = res.stderr?.toString().slice(-500) || '';
    throw new Error(`ffmpeg failed (exit ${res.status}): ${err}`);
  }
  return fs.statSync(outputFile).size;
}

// ── Full VOD download pipeline ────────────────────────────────────────────
async function downloadVOD({ m3u8Url, qualityLabel, outputFile, timeRange, onProgress, onStatus }) {
  onStatus?.('Fetching stream info...');
  const info = getQualities(m3u8Url);

  let segPlaylistUrl = m3u8Url;
  let qualities = [];

  if (info.type === 'master') {
    qualities = info.streams;
    // Pick requested quality or best
    const match = info.streams.find(s => s.url.includes(qualityLabel));
    segPlaylistUrl = match ? match.url : info.streams[0].url;
    onStatus?.(`Quality: ${match?.resolution || info.streams[0].resolution}`);
  }

  onStatus?.('Fetching segment list...');
  const segText = fetchM3U8(segPlaylistUrl);
  let segments = parseSegmentPlaylist(segText, segPlaylistUrl);
  const fullDuration = segments.reduce((s, seg) => s + seg.duration, 0);
  onStatus?.(`Full duration: ${formatDuration(fullDuration)} (${segments.length} segments)`);

  // Apply time range
  let trimOpts = { trimStart: 0, totalDuration: 0 };
  if (timeRange) {
    const result = selectSegments(segments, timeRange);
    segments = result.selected;
    trimOpts = { trimStart: result.trimStart, totalDuration: result.totalDuration };
    onStatus?.(`Time range: ${formatTimestamp(timeRange.start)} → ${formatTimestamp(timeRange.end)} (${segments.length} segments)`);
  }

  // Download segments
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-'));
  try {
    onStatus?.('Downloading segments...');
    const segFiles = await downloadSegments(segments, tmpDir, 8, onProgress);

    onStatus?.('Remuxing to MP4...');
    const size = remux(segFiles, outputFile, trimOpts);
    return { size, duration: trimOpts.totalDuration || fullDuration, qualities };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── Live stream recording ─────────────────────────────────────────────────
function recordLive(m3u8Url, outputFile, { duration, onStatus, onData }) {
  const ffmpeg = getFFmpegPath();
  const args = [
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    '-headers', 'Referer: https://kick.com/\r\n',
    '-rw_timeout', '10000000',
    '-i', m3u8Url
  ];
  if (duration) args.push('-t', String(duration));
  args.push('-c', 'copy', '-movflags', '+faststart', '-y', outputFile);

  onStatus?.(`Recording live → ${outputFile}` + (duration ? ` (${formatDuration(duration)})` : ' (Ctrl+C to stop)'));

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let lastLine = '';
    proc.stderr.on('data', chunk => {
      lastLine = chunk.toString().trim().split('\n').pop();
      const timeMatch = lastLine.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (timeMatch) onData?.(timeMatch[1]);
    });
    proc.on('close', code => {
      if (code === 0 || code === 255) {
        const size = fs.existsSync(outputFile) ? fs.statSync(outputFile).size : 0;
        resolve({ size });
      } else reject(new Error(`ffmpeg exit ${code}`));
    });
    proc.on('error', reject);

    // Allow Ctrl+C to gracefully stop
    process.on('SIGINT', () => { proc.stdin.write('q'); });
  });
}

// ── Clip download ─────────────────────────────────────────────────────────
async function downloadClip(clipUrl, outputFile, onProgress) {
  // Clips are typically direct MP4 or short HLS
  if (clipUrl.endsWith('.mp4') || clipUrl.includes('.mp4?')) {
    // Direct MP4 download
    return new Promise((resolve, reject) => {
      const proc = spawn('curl', [
        '-s', '-L', '--max-time', '300', '--retry', '3',
        ...CURL_HEADERS, clipUrl, '-o', outputFile
      ]);
      proc.on('close', code => {
        if (code === 0) {
          resolve({ size: fs.statSync(outputFile).size });
        } else reject(new Error(`curl exit ${code}`));
      });
      proc.on('error', reject);
    });
  }
  // HLS clip
  return downloadVOD({ m3u8Url: clipUrl, qualityLabel: '720p60', outputFile, onProgress });
}

module.exports = {
  parseTimestamp, parseTimeRange, formatDuration, formatTimestamp,
  parseMasterPlaylist, parseSegmentPlaylist, getQualities, fetchM3U8,
  downloadVOD, recordLive, downloadClip, downloadSegments, remux,
};
