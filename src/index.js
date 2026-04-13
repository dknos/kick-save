#!/usr/bin/env node
/**
 * kick-save — Kick.com Stream Downloader
 * Download VODs, clips, live streams with chat capture
 * https://github.com/dknos/kick-save
 */
const { program } = require('commander');
const inquirer = require('inquirer');
const chalk = require('chalk');
const cliProgress = require('cli-progress');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const api = require('./api');
const dl = require('./download');
const { ChatCapture } = require('./chat');
const setup = require('./setup');

// ── CLI args ──────────────────────────────────────────────────────────────
program
  .name('kick-save')
  .description('Kick.com stream downloader — VODs, clips, live, chat')
  .version('1.0.0')
  .argument('[url]', 'Kick channel, VOD, or clip URL')
  .option('-q, --quality <quality>', 'Video quality (720p60, 480p30, 360p30, 160p30)', '720p60')
  .option('-o, --output <dir>', 'Output directory', '.')
  .option('-t, --time <range>', 'Time range (e.g. 2:35:35-3:00:35)')
  .option('-c, --chat', 'Capture chat alongside video')
  .option('--list', 'List available VODs/clips without downloading')
  .option('--m3u8 <url>', 'Direct m3u8 URL (skip extraction)')
  .parse();

const opts = program.opts();
const urlArg = program.args[0];

// ── Banner ────────────────────────────────────────────────────────────────
function banner() {
  console.log(chalk.green.bold(`
  ╔═══════════════════════════════════════════╗
  ║         KICK STREAM SAVER v1.0            ║
  ║   VODs · Clips · Live · Chat · Multi      ║
  ╚═══════════════════════════════════════════╝`));
  console.log();
}

// ── Helpers ───────────────────────────────────────────────────────────────
function sanitizeFilename(s) {
  return s.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0, 100);
}

function parseSelection(input, max) {
  if (input.trim().toLowerCase() === 'all') return Array.from({ length: max }, (_, i) => i);
  const indices = [];
  for (const part of input.split(',')) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = parseInt(range[1]) - 1, hi = parseInt(range[2]) - 1;
      for (let i = lo; i <= hi && i < max; i++) if (i >= 0) indices.push(i);
    } else {
      const n = parseInt(part.trim()) - 1;
      if (n >= 0 && n < max) indices.push(n);
    }
  }
  return [...new Set(indices)].sort((a, b) => a - b);
}

function makeProgressBar(label) {
  return new cliProgress.SingleBar({
    format: `  ${chalk.cyan(label)} |${chalk.green('{bar}')}| {percentage}% | seg {value}/{total}`,
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
  });
}

function log(msg) { console.log(chalk.gray('  ' + msg)); }
function logOk(msg) { console.log(chalk.green('  ✓ ' + msg)); }
function logErr(msg) { console.log(chalk.red('  ✗ ' + msg)); }

// ── VOD table ─────────────────────────────────────────────────────────────
function printVODTable(vods) {
  console.log();
  console.log(chalk.bold('  #   Title                                          Duration     Date              Views'));
  console.log(chalk.gray('  ─── ────────────────────────────────────────────── ──────────── ───────────────── ──────'));
  vods.forEach((v, i) => {
    const num = chalk.cyan(String(i + 1).padStart(3));
    const title = (v.title || 'Untitled').slice(0, 46).padEnd(46);
    const dur = dl.formatDuration(v.duration).padEnd(12);
    const date = (v.date || '').slice(0, 16).padEnd(17);
    const views = String(v.views || 0).padStart(6);
    console.log(`  ${num} ${title} ${dur} ${date} ${views}`);
  });
  console.log();
}

function printClipTable(clips) {
  console.log();
  console.log(chalk.bold('  #   Title                                          Duration  Views'));
  console.log(chalk.gray('  ─── ────────────────────────────────────────────── ──────── ──────'));
  clips.forEach((c, i) => {
    const num = chalk.cyan(String(i + 1).padStart(3));
    const title = (c.title || 'Untitled').slice(0, 46).padEnd(46);
    const dur = dl.formatDuration(c.duration).padEnd(8);
    const views = String(c.views || 0).padStart(6);
    console.log(`  ${num} ${title} ${dur} ${views}`);
  });
  console.log();
}

// ── Download one VOD ──────────────────────────────────────────────────────
async function downloadOneVOD(slug, vod, options = {}) {
  const { quality = '720p60', timeRange = null, captureChat = false, outputDir = '.' } = options;

  const dateStr = (vod.date || '').slice(0, 10).replace(/-/g, '');
  const baseName = sanitizeFilename(`${slug}-${vod.title}-${dateStr}`);
  const outputFile = path.join(outputDir, baseName + '.mp4');

  console.log();
  console.log(chalk.bold(`  ── ${vod.title} ──`));

  // Get m3u8 URL
  let m3u8;
  try {
    if (vod.source) {
      m3u8 = vod.source;
    } else {
      log('Extracting stream URL...');
      m3u8 = await api.getVODPlayback(slug, vod.uuid);
    }
  } catch (e) {
    logErr(`Failed to get stream URL: ${e.message}`);
    return false;
  }

  // Start chat capture in parallel if requested
  let chatCapture = null;
  if (captureChat && options.chatroomId) {
    chatCapture = new ChatCapture(options.chatroomId, path.join(outputDir, baseName));
    chatCapture.onStatus = log;
    chatCapture.connect().catch(() => {});
  }

  // Download
  const bar = makeProgressBar(vod.title.slice(0, 20));
  let barStarted = false;

  try {
    const result = await dl.downloadVOD({
      m3u8Url: m3u8,
      qualityLabel: quality,
      outputFile,
      timeRange,
      onProgress: (done, total) => {
        if (!barStarted) { bar.start(total, 0); barStarted = true; }
        bar.update(done);
      },
      onStatus: log,
    });
    if (barStarted) bar.stop();
    logOk(`${path.basename(outputFile)} (${(result.size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (e) {
    if (barStarted) bar.stop();
    logErr(`Download failed: ${e.message}`);
    return false;
  }

  if (chatCapture) {
    const count = chatCapture.stop();
    if (count > 0) logOk(`Chat: ${count} messages saved`);
  }
  return true;
}

// ── Record live stream ────────────────────────────────────────────────────
async function recordLiveStream(slug, options = {}) {
  const { quality = '720p60', duration = null, captureChat = false, outputDir = '.', chatroomId = null } = options;

  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const baseName = sanitizeFilename(`${slug}-live-${ts}`);
  const outputFile = path.join(outputDir, baseName + '.mp4');

  console.log();
  console.log(chalk.bold(`  ── Recording live: ${slug} ──`));

  let m3u8;
  try {
    m3u8 = await api.getLivePlayback(slug);
  } catch (e) {
    logErr(`Could not get live stream URL: ${e.message}`);
    return false;
  }

  // Pick quality from master m3u8
  try {
    const info = dl.getQualities(m3u8);
    if (info.type === 'master') {
      const match = info.streams.find(s => s.url.includes(quality));
      if (match) m3u8 = match.url;
      else m3u8 = info.streams[0].url;
      log(`Quality: ${match?.resolution || info.streams[0].resolution}`);
    }
  } catch (_) {}

  // Chat capture
  let chatCapture = null;
  if (captureChat && chatroomId) {
    chatCapture = new ChatCapture(chatroomId, path.join(outputDir, baseName));
    chatCapture.onStatus = log;
    chatCapture.connect().catch(() => {});
  }

  log(`Output: ${outputFile}`);
  log(duration ? `Duration: ${dl.formatDuration(duration)}` : 'Press Ctrl+C to stop recording');

  try {
    const result = await dl.recordLive(m3u8, outputFile, {
      duration,
      onStatus: log,
      onData: (time) => process.stdout.write(`\r  ${chalk.cyan('REC')} ${chalk.red('●')} ${time}   `),
    });
    console.log();
    logOk(`${path.basename(outputFile)} (${(result.size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (e) {
    console.log();
    logErr(`Recording error: ${e.message}`);
  }

  if (chatCapture) {
    const count = chatCapture.stop();
    if (count > 0) logOk(`Chat: ${count} messages saved`);
  }
  return true;
}

// ── Browse channel ────────────────────────────────────────────────────────
async function browseChannel(slug) {
  if (!slug) {
    const { input } = await inquirer.prompt([{
      type: 'input', name: 'input',
      message: 'Enter channel name or URL:',
      validate: v => v.trim() ? true : 'Required',
    }]);
    const parsed = api.parseKickURL(input.trim());
    slug = parsed.slug || input.trim().replace(/^.*kick\.com\//, '').replace(/\/.*/,'');
  }

  log(`Fetching channel: ${slug}...`);
  let channel;
  try {
    channel = await api.getChannel(slug);
  } catch (e) {
    logErr(`Could not fetch channel: ${e.message}`);
    return;
  }

  while (true) {
    const liveLabel = channel.isLive
      ? chalk.red.bold(` ● LIVE NOW — "${channel.streamTitle}" (${channel.viewers} viewers)`)
      : chalk.gray(' (offline)');

    console.log();
    console.log(chalk.bold(`  Channel: ${slug}`) + liveLabel);

    const choices = [
      { name: 'Browse VODs', value: 'vods' },
      { name: 'Browse clips', value: 'clips' },
    ];
    if (channel.isLive) {
      choices.unshift({ name: chalk.red('Record live stream'), value: 'live' });
    }
    choices.push(
      { name: 'Multi-stream viewer', value: 'viewer' },
      new inquirer.Separator(),
      { name: 'Back', value: 'back' },
    );

    const { action } = await inquirer.prompt([{
      type: 'list', name: 'action', message: 'Select:', choices,
    }]);

    if (action === 'back') return;

    if (action === 'live') {
      const liveOpts = await promptDownloadOptions({ isLive: true });
      await recordLiveStream(slug, { ...liveOpts, chatroomId: channel.chatroomId, outputDir: opts.output });
    }

    if (action === 'vods') {
      await browseVODs(slug, channel);
    }

    if (action === 'clips') {
      await browseClips(slug);
    }

    if (action === 'viewer') {
      await multiViewer(slug);
    }
  }
}

// ── Browse VODs ───────────────────────────────────────────────────────────
async function browseVODs(slug, channel) {
  log('Fetching VODs...');
  let vods;
  try {
    vods = await api.getVODs(slug);
  } catch (e) {
    logErr(`Could not fetch VODs: ${e.message}`);
    return;
  }

  if (!vods.length) {
    log('No VODs found for this channel.');
    return;
  }

  printVODTable(vods);

  const { selection } = await inquirer.prompt([{
    type: 'input', name: 'selection',
    message: `Select VODs to download (e.g. 1,3,5-7 or "all"):`,
    validate: v => {
      if (!v.trim()) return 'Enter at least one number';
      const indices = parseSelection(v, vods.length);
      return indices.length > 0 ? true : 'Invalid selection';
    }
  }]);

  const indices = parseSelection(selection, vods.length);
  console.log(chalk.bold(`\n  Selected ${indices.length} VOD(s)`));

  // Per-VOD options
  const downloads = [];
  for (const idx of indices) {
    const vod = vods[idx];
    console.log(chalk.bold(`\n  ── Options for: ${vod.title.slice(0, 50)} ──`));

    const vodOpts = await promptDownloadOptions({ isLive: false, duration: vod.duration });
    downloads.push({ vod, ...vodOpts });
  }

  // Execute downloads
  console.log(chalk.bold(`\n  Starting ${downloads.length} download(s)...\n`));
  let success = 0;
  for (const { vod, ...options } of downloads) {
    const ok = await downloadOneVOD(slug, vod, {
      ...options,
      chatroomId: channel?.chatroomId,
      outputDir: opts.output,
    });
    if (ok) success++;
  }
  console.log(chalk.bold(`\n  Done: ${success}/${downloads.length} completed\n`));
}

// ── Browse clips ──────────────────────────────────────────────────────────
async function browseClips(slug) {
  log('Fetching clips...');
  let clipData;
  try {
    clipData = await api.getClips(slug);
  } catch (e) {
    logErr(`Could not fetch clips: ${e.message}`);
    return;
  }

  if (!clipData.clips.length) {
    log('No clips found.');
    return;
  }

  printClipTable(clipData.clips);

  const { selection } = await inquirer.prompt([{
    type: 'input', name: 'selection',
    message: 'Select clips to download (e.g. 1,3,5-7 or "all"):',
    validate: v => parseSelection(v, clipData.clips.length).length > 0 || 'Invalid selection',
  }]);

  const indices = parseSelection(selection, clipData.clips.length);
  console.log(chalk.bold(`\n  Downloading ${indices.length} clip(s)...\n`));

  let success = 0;
  for (const idx of indices) {
    const clip = clipData.clips[idx];
    const baseName = sanitizeFilename(`${slug}-clip-${clip.title}`);
    const outputFile = path.join(opts.output, baseName + '.mp4');

    if (!clip.clipUrl) {
      logErr(`No download URL for clip: ${clip.title}`);
      continue;
    }

    log(`Downloading: ${clip.title}...`);
    try {
      const result = await dl.downloadClip(clip.clipUrl, outputFile);
      logOk(`${path.basename(outputFile)} (${(result.size / 1024 / 1024).toFixed(1)} MB)`);
      success++;
    } catch (e) {
      logErr(`Failed: ${e.message}`);
    }
  }
  console.log(chalk.bold(`\n  Done: ${success}/${indices.length} clips downloaded\n`));
}

// ── Download options prompt ───────────────────────────────────────────────
async function promptDownloadOptions({ isLive = false, duration = 0 }) {
  const questions = [];

  // Quality
  questions.push({
    type: 'list', name: 'quality',
    message: 'Quality:',
    choices: [
      { name: '720p 60fps (best)', value: '720p60' },
      { name: '480p 30fps', value: '480p30' },
      { name: '360p 30fps', value: '360p30' },
      { name: '160p 30fps (smallest)', value: '160p30' },
    ],
    default: '720p60',
  });

  // Time range (not for live)
  if (!isLive && duration > 0) {
    questions.push({
      type: 'input', name: 'timeRangeStr',
      message: `Time range (blank = full ${dl.formatDuration(duration)}, e.g. 2:35:35-3:00:35):`,
      default: '',
    });
  }

  // Duration for live
  if (isLive) {
    questions.push({
      type: 'input', name: 'durationStr',
      message: 'Record duration (blank = until Ctrl+C, e.g. 30:00 or 1:30:00):',
      default: '',
    });
  }

  // Chat
  questions.push({
    type: 'confirm', name: 'captureChat',
    message: 'Capture chat?',
    default: false,
  });

  const answers = await inquirer.prompt(questions);

  const result = { quality: answers.quality, captureChat: answers.captureChat };

  if (answers.timeRangeStr) {
    result.timeRange = dl.parseTimeRange(answers.timeRangeStr);
    if (answers.timeRangeStr.trim() && !result.timeRange) {
      console.log(chalk.yellow('  Invalid time range, downloading full video'));
    }
  }

  if (answers.durationStr) {
    result.duration = dl.parseTimestamp(answers.durationStr);
  }

  return result;
}

// ── Multi-stream viewer ───────────────────────────────────────────────────
async function multiViewer(initialSlug) {
  const viewers = setup.detectViewers();
  if (!viewers.length) {
    console.log(chalk.yellow('\n  No video player found. Install one of: GridPlayer, mpv, VLC, ffplay'));
    console.log(chalk.gray('  GridPlayer: https://github.com/vzhd1701/gridplayer'));
    console.log(chalk.gray('  mpv: https://mpv.io   VLC: https://videolan.org'));
    return;
  }

  const { channels } = await inquirer.prompt([{
    type: 'input', name: 'channels',
    message: 'Enter channel names to watch (comma-separated):',
    default: initialSlug || '',
    validate: v => v.trim() ? true : 'Enter at least one channel',
  }]);

  const slugs = channels.split(',').map(s => s.trim()).filter(Boolean);
  const streamUrls = [];

  for (const slug of slugs) {
    try {
      log(`Checking ${slug}...`);
      const m3u8 = await api.getLivePlayback(slug);
      streamUrls.push({ slug, url: m3u8 });
      logOk(`${slug} — stream found`);
    } catch (e) {
      logErr(`${slug} — ${e.message}`);
    }
  }

  if (!streamUrls.length) {
    logErr('No live streams found');
    return;
  }

  // Pick viewer
  let viewer = viewers[0];
  if (viewers.length > 1) {
    const { choice } = await inquirer.prompt([{
      type: 'list', name: 'choice',
      message: 'Select video player:',
      choices: viewers.map(v => ({ name: v.name, value: v })),
    }]);
    viewer = choice;
  }

  // Also ask if they want to record
  const { record } = await inquirer.prompt([{
    type: 'confirm', name: 'record',
    message: 'Also record these streams?',
    default: false,
  }]);

  // Launch viewer
  log(`Opening ${streamUrls.length} stream(s) in ${viewer.name}...`);
  const urls = streamUrls.map(s => s.url);

  if (viewer.name === 'GridPlayer') {
    spawn(viewer.cmd, urls, { detached: true, stdio: 'ignore' }).unref();
  } else if (viewer.name === 'mpv') {
    // mpv: one window per stream, or use --lavfi-complex for grid
    for (let i = 0; i < urls.length; i++) {
      const cols = Math.ceil(Math.sqrt(urls.length));
      const row = Math.floor(i / cols);
      const col = i % cols;
      const w = Math.floor(1280 / cols);
      const h = Math.floor(720 / cols);
      spawn(viewer.cmd, [
        `--geometry=${w}x${h}+${col * w}+${row * h}`,
        `--title=${streamUrls[i].slug}`,
        '--no-terminal',
        urls[i]
      ], { detached: true, stdio: 'ignore' }).unref();
    }
  } else {
    // VLC / ffplay
    for (const s of streamUrls) {
      spawn(viewer.cmd, [s.url], { detached: true, stdio: 'ignore' }).unref();
    }
  }

  logOk(`Opened ${streamUrls.length} stream(s) in ${viewer.name}`);

  // Start recording if requested
  if (record) {
    console.log(chalk.bold('\n  Recording all streams... (Ctrl+C to stop)\n'));
    const recordings = streamUrls.map(s => {
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const outFile = path.join(opts.output, sanitizeFilename(`${s.slug}-live-${ts}`) + '.mp4');
      return recordLiveStream(s.slug, { outputDir: opts.output });
    });
    await Promise.allSettled(recordings);
  }
}

// ── Direct URL handler ────────────────────────────────────────────────────
async function handleDirectURL(rawUrl) {
  const parsed = api.parseKickURL(rawUrl);

  if (parsed.type === 'channel') {
    await browseChannel(parsed.slug);
    return;
  }

  if (parsed.type === 'vod') {
    const dlOpts = opts.time
      ? { quality: opts.quality, timeRange: dl.parseTimeRange(opts.time), captureChat: opts.chat }
      : await promptDownloadOptions({ isLive: false, duration: 0 });

    const vod = { uuid: parsed.uuid, title: parsed.uuid, source: null, date: '', views: 0, duration: 0 };
    await downloadOneVOD(parsed.slug, vod, { ...dlOpts, outputDir: opts.output });
    return;
  }

  if (parsed.type === 'clip') {
    log(`Downloading clip: ${parsed.clipId}`);
    const outFile = path.join(opts.output, sanitizeFilename(`${parsed.slug}-clip-${parsed.clipId}`) + '.mp4');
    // Try to get clip URL from clips API
    try {
      const clipData = await api.getClips(parsed.slug);
      const clip = clipData.clips.find(c => String(c.id) === String(parsed.clipId));
      if (clip?.clipUrl) {
        await dl.downloadClip(clip.clipUrl, outFile);
        logOk(`Saved: ${outFile}`);
        return;
      }
    } catch (_) {}
    logErr('Could not find clip download URL');
    return;
  }

  logErr(`Unknown URL format: ${rawUrl}`);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  banner();

  // Ensure ffmpeg
  try {
    await setup.ensureFFmpeg(log);
  } catch (e) {
    logErr(e.message);
    process.exit(1);
  }

  // Direct m3u8 mode (bypass extraction)
  if (opts.m3u8) {
    const outFile = urlArg ? urlArg : 'kick-download.mp4';
    const timeRange = opts.time ? dl.parseTimeRange(opts.time) : null;
    await dl.downloadVOD({
      m3u8Url: opts.m3u8, qualityLabel: opts.quality, outputFile: outFile, timeRange,
      onProgress: (done, total) => process.stdout.write(`\r  seg ${done}/${total}`),
      onStatus: log,
    });
    console.log();
    logOk(`Saved: ${outFile}`);
    return;
  }

  // Direct URL mode
  if (urlArg) {
    await handleDirectURL(urlArg);
    return;
  }

  // Interactive mode
  while (true) {
    const { action } = await inquirer.prompt([{
      type: 'list', name: 'action',
      message: 'What do you want to do?',
      choices: [
        { name: 'Browse channel (VODs, clips, live)', value: 'browse' },
        { name: 'Enter direct VOD/clip URL', value: 'direct' },
        { name: 'Multi-stream viewer', value: 'viewer' },
        new inquirer.Separator(),
        { name: 'Quit', value: 'quit' },
      ]
    }]);

    if (action === 'quit') break;

    if (action === 'browse') {
      await browseChannel();
    }

    if (action === 'direct') {
      const { url } = await inquirer.prompt([{
        type: 'input', name: 'url',
        message: 'Enter Kick VOD or clip URL:',
        validate: v => v.trim() ? true : 'Required',
      }]);
      await handleDirectURL(url.trim());
    }

    if (action === 'viewer') {
      await multiViewer();
    }
  }

  console.log(chalk.gray('\n  Goodbye!\n'));
}

main().catch(e => {
  console.error(chalk.red(`\n  Fatal: ${e.message}\n`));
  process.exit(1);
});
