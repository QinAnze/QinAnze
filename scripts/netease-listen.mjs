#!/usr/bin/env node
// 网易云「随手一听」卡片：播放次数最高的一批里随机一首 + 每日推荐里随机一首
//
// 数据来源必须是 weapi 加密接口，明文的 /api/v1/play/record 只返回歌曲对象、没有 playCount
//
// 环境变量:
//   NETEASE_UID           账号 uid（数字）
//   NETEASE_COOKIE        登录 cookie，至少包含 MUSIC_U（有 __csrf 更好）
//   OUT_DIR               输出目录，默认 dist
//   PREV_HISTORY          上一次 history.json（可选）
//   NETEASE_RECORD_FILE   调试用：本地 record JSON，不走网络

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';

const UID = process.env.NETEASE_UID?.trim();
const COOKIE = process.env.NETEASE_COOKIE?.trim();
const OUT_DIR = process.env.OUT_DIR ?? 'dist';
const PREV_HISTORY = process.env.PREV_HISTORY ?? '';
const RECORD_FILE = process.env.NETEASE_RECORD_FILE ?? '';
const TOP_POOL = 20;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 固定常量，来自社区实现 util/crypto.js
const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

const today = new Date().toISOString().slice(0, 10);

function aesCbc(text, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(IV));
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

function rsaNoPadding(str) {
  // 等价于 node-forge 的 publicKey.encrypt(str, 'NONE')：密钥按 128 字节左补零再裸 RSA
  const size = 128;
  const body = Buffer.from(str, 'utf8');
  const padded = Buffer.concat([Buffer.alloc(size - body.length), body]);
  return crypto.publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded).toString('hex');
}

function weapi(object) {
  const text = JSON.stringify(object);
  let secretKey = '';
  for (let i = 0; i < 16; i++) secretKey += BASE62[crypto.randomInt(BASE62.length)];
  return {
    params: aesCbc(aesCbc(text, PRESET_KEY), secretKey),
    encSecKey: rsaNoPadding([...secretKey].reverse().join('')),
  };
}

function csrfToken() {
  const m = (COOKIE ?? '').match(/__csrf=([^;]+)/);
  return m ? m[1] : '';
}

async function weapiPost(apiPath, data, { cookie = true } = {}) {
  const { params, encSecKey } = weapi(data);
  const headers = {
    'User-Agent': UA,
    Referer: 'https://music.163.com/',
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (cookie && COOKIE) headers.Cookie = COOKIE;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(`https://music.163.com${apiPath}?csrf_token=${csrfToken()}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ params, encSecKey }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} @ ${apiPath}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function readJson(path, fallback = null) {
  if (!path || !existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalize(item) {
  const song = item.song ?? item;
  const artist = (song.ar ?? song.artists ?? []).map((a) => a.name).join(' / ');
  const count = Number(item.playCount ?? item.played ?? 0);
  return {
    id: song.id,
    name: song.name ?? '(unknown)',
    artist: artist || '(unknown)',
    playCount: Number.isFinite(count) ? count : 0,
    score: Number(item.score ?? 0),
    picUrl: song.al?.picUrl ?? song.album?.picUrl ?? song.picUrl ?? null,
  };
}

async function loadTopSongs() {
  const data = RECORD_FILE
    ? readJson(RECORD_FILE)
    : await weapiPost('/weapi/v1/play/record', { uid: UID, type: 0 });
  if (!data || data.code !== 200) {
    throw new Error(`听歌排行返回 code=${data?.code} ${data?.msg ?? ''}（cookie 可能已失效或被风控）`);
  }
  const songs = (data.allData ?? []).filter((x) => x && (x.song ?? x).name).map(normalize);
  if (songs.length === 0) {
    throw new Error('听歌排行为空：该账号没有听歌记录，或「听歌排行」被设为不可见');
  }
  songs.sort((a, b) => b.playCount - a.playCount);
  return songs;
}

async function loadRecommend() {
  const data = await weapiPost('/weapi/v3/discovery/recommend/songs', {});
  if (!data || data.code !== 200) {
    throw new Error(`每日推荐返回 code=${data?.code} ${data?.msg ?? ''}（cookie 可能已失效或被风控）`);
  }
  const list = (data.data?.dailySongs ?? data.recommend ?? []).map(normalize);
  if (list.length === 0) throw new Error('每日推荐为空：cookie 可能不完整');
  return list;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function clip(str, maxWidth) {
  let out = '';
  let w = 0;
  for (const ch of String(str)) {
    const wide = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE00-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch);
    const cw = wide ? 2 : 1;
    if (w + cw > maxWidth) return out.trimEnd() + '…';
    out += ch;
    w += cw;
  }
  return out;
}

const fmt = (n) => Number(n).toLocaleString('en-US');

// 封面必须内联成 data URI：SVG 被当 <img> 渲染时浏览器不允许加载外链图片
async function fetchCover(url) {
  if (!url) return null;
  const clean = url.replace(/^http:/, 'https:');
  try {
    const res = await fetch(`${clean}?param=120y120`, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 80 * 1024) return null;
    return buf.toString('base64');
  } catch {
    return null;
  }
}

function renderSong({ song, label, cover, x, y }) {
  const parts = [];
  const size = 52;
  if (cover) {
    parts.push(
      `<clipPath id="clip-${song.id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="6"/></clipPath>`,
    );
    parts.push(
      `<image href="data:image/jpeg;base64,${cover}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#clip-${song.id})"/>`,
    );
  } else {
    parts.push(`<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="6" fill="#8b949e" fill-opacity="0.18"/>`);
    parts.push(
      `<text x="${x + size / 2}" y="${y + size / 2 + 6}" font-size="18" fill="#8b949e" text-anchor="middle">♪</text>`,
    );
  }
  const tx = x + size + 14;
  parts.push(
    `<text x="${tx}" y="${y + 16}" font-size="13" font-weight="600" fill="#57606a">${esc(clip(song.name, 34))}</text>`,
  );
  parts.push(`<text x="${tx}" y="${y + 33}" font-size="11" fill="#8b949e">${esc(clip(song.artist, 30))}</text>`);
  parts.push(`<text x="${tx}" y="${y + 48}" font-size="10" fill="#c20c0c">${esc(label)}</text>`);
  return parts.join('\n');
}

function renderSvg({ topSong, recSong, topCover, recCover }) {
  const W = 700;
  const H = 84;
  const pad = 20;
  const gap = 24;
  const blockW = (W - pad * 2 - gap) / 2;
  const rx = H / 2;
  const w2 = W - 2;
  const h2 = H - 2;
  const r2 = rx - 1;
  // 圆角矩形周长 = 两条直边 + 两个圆弧
  const perimeter = 2 * (w2 - 2 * r2) + 2 * (h2 - 2 * r2) + 2 * Math.PI * r2;
  const dash = 130;
  const topLabel = topSong.playCount > 0 ? `TOP 100 · ${fmt(topSong.playCount)} plays` : 'TOP 100';

  const capsule = (stroke, extra = '', children = '') =>
    `<rect x="1" y="1" width="${w2}" height="${h2}" rx="${r2}" fill="none" stroke="${stroke}" ${extra}>${children}</rect>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Noto Sans,Helvetica,Arial,sans-serif">`,
    `<title>Now listening ${today}</title>`,
    capsule('#8b949e', 'stroke-width="2.5"'),
    capsule(
      '#FF0000',
      `stroke-width="3" stroke-linecap="round" stroke-dasharray="${dash} ${perimeter - dash}"`,
      `<animate attributeName="stroke-dashoffset" values="${perimeter};${perimeter / 2};0" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.55 0 0.45 1;0.55 0 0.45 1" dur="6s" repeatCount="indefinite"/>`,
    ),
    renderSong({ song: recSong, label: 'DAILY RECOMMENDATION', cover: recCover, x: pad, y: 16 }),
    renderSong({ song: topSong, label: topLabel, cover: topCover, x: pad + blockW + gap, y: 16 }),
    '</svg>',
  ].join('\n');
}

async function main() {
  if (process.env.NETEASE_SELFTEST) {
    const { params, encSecKey } = weapi({ uid: '1', type: 0 });
    console.log(`selftest: params=${params.length} chars, encSecKey=${encSecKey.length} hex chars`);
    return;
  }
  if (!RECORD_FILE && (!UID || !COOKIE)) throw new Error('缺少环境变量 NETEASE_UID 或 NETEASE_COOKIE');

  const songs = await loadTopSongs();
  const topSong = pick(songs.slice(0, Math.min(TOP_POOL, songs.length)));

  const recSong = RECORD_FILE
    ? { id: 0, name: 'Mock recommendation', artist: 'Mock artist', playCount: 0, picUrl: null }
    : pick(await loadRecommend());

  const [topCover, recCover] = await Promise.all([fetchCover(topSong.picUrl), fetchCover(recSong.picUrl)]);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'latest.svg'), renderSvg({ topSong, recSong, topCover, recCover }));

  const history = readJson(PREV_HISTORY, []) ?? [];
  if (!history.some((h) => h.date === today)) {
    history.push({ date: today, top: topSong.name, recommend: recSong.name });
  }
  writeFileSync(join(OUT_DIR, 'history.json'), JSON.stringify(history, null, 2));

  console.log(`ok: top="${topSong.name}" (${topSong.playCount}) recommend="${recSong.name}" days=${history.length}`);
}

main().catch((err) => {
  console.error(`failed: ${err.message}`);
  process.exit(1);
});
