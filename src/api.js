/**
 * api.js — Kick.com API client
 * Uses system curl for Cloudflare TLS bypass (Schannel on Windows),
 * falls back to Node.js https. Handles VODs, clips, live streams, m3u8 extraction.
 */
const { spawnSync } = require('child_process');
const https = require('https');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── HTTP helpers ──────────────────────────────────────────────────────────
function curlGet(url, accept = 'text/html') {
  const args = ['-s', '-L', '--max-time', '30', '--compressed',
    '-H', `User-Agent: ${UA}`,
    '-H', `Accept: ${accept}`,
    '-H', 'Referer: https://kick.com/',
    '-H', 'Origin: https://kick.com',
    url
  ];
  const res = spawnSync('curl', args, { maxBuffer: 10 * 1024 * 1024 });
  if (res.error) throw res.error;
  return res.stdout.toString('utf8');
}

function curlGetJSON(url) {
  const text = curlGet(url, 'application/json');
  const data = JSON.parse(text);
  if (data.error) throw new Error(data.error);
  return data;
}

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://kick.com/' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function apiGet(url) {
  try { return curlGetJSON(url); }
  catch (e) {
    try { return await httpGetJSON(url); }
    catch (e2) { throw new Error(`API blocked: ${e.message}`); }
  }
}

// ── Channel ───────────────────────────────────────────────────────────────
async function getChannel(slug) {
  const ch = await apiGet(`https://kick.com/api/v2/channels/${slug}`);
  return {
    id:          ch.id,
    slug:        ch.slug || slug,
    name:        ch.user?.username || slug,
    isLive:      !!ch.livestream?.is_live,
    streamTitle: ch.livestream?.session_title || '',
    chatroomId:  ch.chatroom?.id || null,
    viewers:     ch.livestream?.viewer_count || 0,
    playbackUrl: ch.playback_url || ch.livestream?.source || null,
    raw:         ch,
  };
}

// ── VODs ──────────────────────────────────────────────────────────────────
async function getVODs(slug, page = 1) {
  const resp = await apiGet(`https://kick.com/api/v2/channels/${slug}/videos?page=${page}&sort=date`);
  const list = resp.data || resp.videos || (Array.isArray(resp) ? resp : []);
  return list.map(v => ({
    uuid:     v.uuid || v.id,
    title:    v.session_title || v.title || 'Untitled',
    duration: v.duration || 0,
    date:     v.created_at || v.start_time || '',
    views:    v.views || v.view_count || 0,
    source:   v.source || v.playback_url || null,
  }));
}

// ── Clips ─────────────────────────────────────────────────────────────────
async function getClips(slug, cursor = '', sort = 'view', time = 'all') {
  const q = cursor ? `&cursor=${cursor}` : '';
  const resp = await apiGet(`https://kick.com/api/v2/channels/${slug}/clips?sort=${sort}&time=${time}${q}`);
  const list = resp.clips?.data || resp.data || resp.clips || [];
  const nextCursor = resp.clips?.next_cursor || resp.next_cursor || null;
  return {
    clips: list.map(c => ({
      id:        c.id || c.clip_id,
      title:     c.title || 'Untitled clip',
      duration:  c.duration || 0,
      date:      c.created_at || '',
      views:     c.view_count || c.views || 0,
      clipUrl:   c.clip_url || c.video_url || c.download_url || null,
      thumbnail: c.thumbnail_url || c.thumbnail?.src || null,
    })),
    nextCursor,
  };
}

// ── m3u8 extraction ───────────────────────────────────────────────────────
function findM3U8InText(html) {
  const urls = [];
  const re = /https:\/\/[^"'\\]*\.m3u8[^"'\\]*/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    urls.push(m[0].replace(/\\+$/g, '').replace(/[\\'"]+$/g, ''));
  }
  if (!urls.length) return null;
  return urls.find(u => u.includes('stream.kick.com'))
      || urls.find(u => u.includes('master.m3u8'))
      || urls[0];
}

function extractM3U8FromHTML(url) {
  const html = curlGet(url, 'text/html');
  return findM3U8InText(html);
}

// Playwright fallback for server/datacenter IPs blocked by Cloudflare
async function extractM3U8WithPlaywright(url) {
  let chromium;
  try {
    // Try local Playwright install (not bundled in exe — optional dep)
    const pwPaths = [
      '/home/nemoclaw/.nemoclaw/playwright/node_modules/playwright-core',
      'playwright-core', 'playwright',
    ];
    for (const p of pwPaths) {
      try { chromium = require(p).chromium; break; } catch (_) {}
    }
    if (!chromium) return null;
  } catch (_) { return null; }

  const chromiumPaths = [
    process.env.CHROMIUM_PATH,
    '/home/nemoclaw/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',
  ].filter(Boolean);
  const { existsSync } = require('fs');
  const execPath = chromiumPaths.find(p => existsSync(p));
  if (!execPath) return null;

  const browser = await chromium.launch({
    executablePath: execPath, headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    const content = await page.content();
    return findM3U8InText(content);
  } finally {
    await browser.close();
  }
}

async function getVODPlayback(slug, uuid) {
  // 1. VOD source from listing
  try {
    const vods = await getVODs(slug);
    const match = vods.find(v => v.uuid === uuid);
    if (match?.source) return match.source;
  } catch (_) {}
  // 2. Direct video API
  try {
    const data = await apiGet(`https://kick.com/api/v2/video/${uuid}`);
    if (data.source) return data.source;
    if (data.livestream?.source) return data.livestream.source;
  } catch (_) {}
  // 3. Page HTML with curl
  const url = `https://kick.com/${slug}/videos/${uuid}`;
  const m3u8 = extractM3U8FromHTML(url);
  if (m3u8) return m3u8;
  // 4. Playwright fallback (for datacenter IPs blocked by Cloudflare)
  try {
    const pw = await extractM3U8WithPlaywright(url);
    if (pw) return pw;
  } catch (_) {}
  throw new Error('Could not find playback URL — try --m3u8 flag or run on residential IP');
}

async function getLivePlayback(slug) {
  const url = `https://kick.com/${slug}`;
  // 1. curl HTML
  const m3u8 = extractM3U8FromHTML(url);
  if (m3u8) return m3u8;
  // 2. Channel API
  try {
    const ch = await getChannel(slug);
    if (ch.playbackUrl) return ch.playbackUrl;
  } catch (_) {}
  // 3. Playwright fallback
  try {
    const pw = await extractM3U8WithPlaywright(url);
    if (pw) return pw;
  } catch (_) {}
  throw new Error('Could not find live stream URL');
}

// ── URL parsing ───────────────────────────────────────────────────────────
function parseKickURL(url) {
  url = url.replace(/^https?:\/\/(www\.)?/, '').replace(/^kick\.com\//, '');
  // kick.com/channel/videos/UUID
  const vodMatch = url.match(/^([^/]+)\/videos\/([a-f0-9-]+)/);
  if (vodMatch) return { type: 'vod', slug: vodMatch[1], uuid: vodMatch[2] };
  // kick.com/channel?clip=XXXX
  const clipMatch = url.match(/^([^/?]+)\?clip=(.+)/);
  if (clipMatch) return { type: 'clip', slug: clipMatch[1], clipId: clipMatch[2] };
  // kick.com/channel/clips/XXXX
  const clipMatch2 = url.match(/^([^/]+)\/clips?\/(.+)/);
  if (clipMatch2) return { type: 'clip', slug: clipMatch2[1], clipId: clipMatch2[2] };
  // kick.com/channel
  const chMatch = url.match(/^([^/?#]+)\/?$/);
  if (chMatch) return { type: 'channel', slug: chMatch[1] };
  return { type: 'unknown', raw: url };
}

module.exports = {
  curlGet, apiGet, getChannel, getVODs, getClips,
  getVODPlayback, getLivePlayback, extractM3U8FromHTML, parseKickURL
};
