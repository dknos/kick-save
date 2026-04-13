/**
 * setup.js — ffmpeg detection/auto-download + viewer detection
 */
const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = os.platform() === 'win32';

function getAppDataDir() {
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'kick-save');
  return path.join(os.homedir(), '.kick-save');
}

function getFFmpegPath() {
  // 1. In PATH
  const which = IS_WIN ? 'where' : 'which';
  try {
    const found = execSync(`${which} ffmpeg`, { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n')[0];
    if (found) return found;
  } catch (_) {}
  // 2. In app data
  const local = path.join(getAppDataDir(), IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(local)) return local;
  // 3. Common Windows paths
  if (IS_WIN) {
    const common = [
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(os.homedir(), 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(os.homedir(), 'Downloads', 'ffmpeg.exe'),
    ];
    for (const p of common) { if (fs.existsSync(p)) return p; }
  }
  // 4. For Linux — check common locations
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', `${os.homedir()}/.local/bin/ffmpeg`]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function ensureFFmpeg(log) {
  let ffpath = getFFmpegPath();
  if (ffpath) {
    log?.(`ffmpeg found: ${ffpath}`);
    return ffpath;
  }

  log?.('ffmpeg not found — downloading...');
  const appDir = getAppDataDir();
  fs.mkdirSync(appDir, { recursive: true });

  if (IS_WIN) {
    // Download ffmpeg essentials for Windows from GitHub
    const zipUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
    const zipPath = path.join(appDir, 'ffmpeg.zip');

    log?.('Downloading ffmpeg (this is a one-time setup)...');
    spawnSync('curl', ['-L', '-o', zipPath, zipUrl], { stdio: 'inherit' });

    // Extract ffmpeg.exe from the zip
    log?.('Extracting...');
    spawnSync('tar', ['-xf', zipPath, '-C', appDir, '--strip-components=2',
      'ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe'], { stdio: 'inherit' });

    try { fs.unlinkSync(zipPath); } catch (_) {}
    ffpath = path.join(appDir, 'ffmpeg.exe');
  } else {
    // Linux: download static build
    const url = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';
    const tarPath = path.join(appDir, 'ffmpeg.tar.xz');
    log?.('Downloading ffmpeg (one-time setup)...');
    spawnSync('curl', ['-L', '-o', tarPath, url], { stdio: 'inherit' });
    spawnSync('tar', ['-xf', tarPath, '-C', appDir, '--strip-components=1', '--wildcards', '*/ffmpeg'], { stdio: 'inherit' });
    try { fs.unlinkSync(tarPath); } catch (_) {}
    ffpath = path.join(appDir, 'ffmpeg');
    try { fs.chmodSync(ffpath, 0o755); } catch (_) {}
  }

  if (!fs.existsSync(ffpath)) {
    throw new Error('Failed to download ffmpeg. Please install it manually and add to PATH.');
  }
  log?.(`ffmpeg installed: ${ffpath}`);
  return ffpath;
}

// ── Viewer detection ──────────────────────────────────────────────────────
function detectViewers() {
  const viewers = [];
  const which = IS_WIN ? 'where' : 'which';

  const candidates = IS_WIN
    ? [
        { name: 'GridPlayer', cmd: 'gridplayer', check: ['where', 'gridplayer'] },
        { name: 'mpv',        cmd: 'mpv',        check: ['where', 'mpv'] },
        { name: 'VLC',        cmd: 'vlc',        check: ['where', 'vlc'] },
        { name: 'ffplay',     cmd: 'ffplay',     check: ['where', 'ffplay'] },
      ]
    : [
        { name: 'GridPlayer', cmd: 'gridplayer', check: ['which', 'gridplayer'] },
        { name: 'mpv',        cmd: 'mpv',        check: ['which', 'mpv'] },
        { name: 'VLC',        cmd: 'cvlc',       check: ['which', 'cvlc'] },
        { name: 'ffplay',     cmd: 'ffplay',     check: ['which', 'ffplay'] },
      ];

  for (const v of candidates) {
    try {
      const res = spawnSync(v.check[0], [v.check[1]], { encoding: 'utf8', stdio: 'pipe' });
      if (res.status === 0) viewers.push(v);
    } catch (_) {}
  }
  return viewers;
}

module.exports = { getFFmpegPath, ensureFFmpeg, detectViewers, getAppDataDir };
