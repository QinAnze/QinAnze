#!/usr/bin/env node
// 网易云「随手一听」卡片：从播放次数最高的一批里随机挑一首 + 每日推荐里随机挑一首
//
// 环境变量:
//   NETEASE_UID           账号 uid（数字）
//   NETEASE_COOKIE        登录 cookie，至少包含 MUSIC_U
//   OUT_DIR               输出目录，默认 dist
//   PREV_HISTORY          上一次 history.json（可选）
//   NETEASE_RECORD_FILE   调试用：本地 record JSON，不走网络

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const UID = process.env.NETEASE_UID?.trim();
const COOKIE = process.env.NETEASE_COOKIE?.trim();
const OUT_DIR = process.env.OUT_DIR ?? 'dist';
const PREV_HISTORY = process.env.PREV_HISTORY ?? '';
const RECORD_FILE = process.env.NETEASE_RECORD_FILE ?? '';
const TOP_POOL = 20; // 从播放次数前 20 名里随机挑
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const today = new Date().toISOString().slice(0, 10);

function readJson(path, fallback = null) {
  if (!path || !existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function request(url, { cookie = false, parse = 'json' } = {}) {
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  if (cookie && COOKIE) headers.Cookie = COOKIE;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parse === 'json' ? await res.json() : await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

function normalize(item) {
  const song = item.song ?? item;
  const artist = (song.ar ?? song.artists ?? []).map((a) => a.name).join(' / ');
  const count = Number(item.playCount ?? item.played ?? item.count ?? 0);
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
    : await request(`https://music.163.com/api/v1/play/record?uid=${UID}&type=0`, { cookie: true });
  if (!data || data.code !== 200) {
    throw new Error(`听歌排行返回 code=${data?.code} ${data?.msg ?? ''}（cookie 可能已失效或被风控）`);
  }

  let source = 'all';
  let songs = (data.allData ?? []).filter((x) => x && (x.song ?? x).name).map(normalize);
  if (songs.length === 0) {
    songs = (data.weekData ?? []).filter((x) => x && (x.song ?? x).name).map(normalize);
    source = 'week';
  }
  if (songs.length === 0) {
    await diagnose(data);
    throw new Error('听歌排行为空：cookie 可能不完整，或该账号的听歌排行没有数据');
  }
  songs.sort((a, b) => b.playCount - a.playCount);
  return { songs, source };
}

async function diagnose(recordData) {
  const first = recordData?.allData?.[0] ?? recordData?.weekData?.[0] ?? null;
  const song = first?.song ?? first ?? null;
  console.error(
    `[diag] record: code=${recordData?.code} keys=${Object.keys(recordData ?? {}).join('|')} ` +
      `allData=${recordData?.allData ? recordData.allData.length : 'null'} ` +
      `weekData=${recordData?.weekData ? recordData.weekData.length : 'null'}`,
  );
  console.error(
    `[diag] item keys=${first ? Object.keys(first).join('|') : 'n/a'} song keys=${song ? Object.keys(song).join('|') : 'n/a'}`,
  );
  if (RECORD_FILE || !COOKIE) return;
  try {
    const acc = await request('https://music.163.com/api/w/nuser/account/get', { cookie: true });
    const id = acc?.profile?.userId ?? acc?.account?.id ?? 'n/a';
    console.error(`[diag] cookie belongs to uid=${id} (workflow 里配置的 uid=${UID})`);
  } catch (err) {
    console.error(`[diag] account probe failed: ${err.message}`);
  }
}

async function loadRecommend() {
  const data = await request('https://music.163.com/api/v1/discovery/recommend/songs', { cookie: true });
  if (!data || data.code !== 200) {
    throw new Error(`每日推荐返回 code=${data?.code} ${data?.msg ?? ''}（cookie 可能已失效或被风控）`);
  }
  const list = (data.recommend ?? []).map(normalize);
  if (list.length === 0) throw new Error('每日推荐为空');
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

// 专辑封面内联成 data URI：SVG 作为 <img> 渲染时无法加载外链图片，只能内嵌
async function fetchCover(url) {
  if (!url) return null;
  const clean = url.replace(/^http:/, 'https:');
  try {
    const buf = await request(`${clean}?param=120y120`, { parse: 'bin' });
    if (!buf || buf.byteLength === 0 || buf.byteLength > 80 * 1024) return null;
    return Buffer.from(buf).toString('base64');
  } catch {
    return null;
  }
}

function renderSong({ song, label, cover, x, y }) {
  const parts = [];
  const size = 52;
  if (cover) {
    parts.push(`<clipPath id="clip-${song.id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="6"/></clipPath>`);
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
  parts.push(`<text x="${tx}" y="${y + 16}" font-size="13" font-weight="600" fill="#57606a">${esc(clip(song.name, 34))}</text>`);
  parts.push(`<text x="${tx}" y="${y + 33}" font-size="11" fill="#8b949e">${esc(clip(song.artist, 30))}</text>`);
  parts.push(`<text x="${tx}" y="${y + 48}" font-size="10" fill="#c20c0c">${esc(label)}</text>`);
  return parts.join('\n');
}

function renderSvg({ topSong, recSong, topCover, recCover, source }) {
  const W = 380;
  const H = 150;
  const topLabel =
    topSong.playCount > 0
      ? `${source === 'week' ? 'MOST PLAYED 7D' : 'MOST PLAYED'} · ${fmt(topSong.playCount)} plays`
      : 'MOST PLAYED';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Noto Sans,Helvetica,Arial,sans-serif">`,
    `<title>Now listening ${today}</title>`,
    `<text x="0" y="14" font-size="10" letter-spacing="1.2" fill="#8b949e">NOW PLAYING</text>`,
    `<text x="${W}" y="14" font-size="10" fill="#8b949e" text-anchor="end">${today}</text>`,
    `<line x1="0" y1="24" x2="${W}" y2="24" stroke="#8b949e" stroke-opacity="0.35"/>`,
    renderSong({ song: topSong, label: topLabel, cover: topCover, x: 0, y: 36 }),
    `<line x1="0" y1="100" x2="${W}" y2="100" stroke="#8b949e" stroke-opacity="0.2"/>`,
    renderSong({ song: recSong, label: 'DAILY RECOMMENDATION', cover: recCover, x: 0, y: 108 }),
    '</svg>',
  ].join('\n');
}

async function main() {
  if (!RECORD_FILE && (!UID || !COOKIE)) throw new Error('缺少环境变量 NETEASE_UID 或 NETEASE_COOKIE');

  const { songs, source } = await loadTopSongs();
  const topCandidates = songs.slice(0, Math.min(TOP_POOL, songs.length));
  const topSong = pick(topCandidates);

  const recommend = RECORD_FILE ? [] : await loadRecommend();
  const recSong = RECORD_FILE
    ? { id: 0, name: 'Mock recommendation', artist: 'Mock artist', playCount: 0, picUrl: null }
    : pick(recommend);

  const [topCover, recCover] = await Promise.all([fetchCover(topSong.picUrl), fetchCover(recSong.picUrl)]);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'latest.svg'),
    renderSvg({ topSong, recSong, topCover, recCover, source }),
  );

  const history = readJson(PREV_HISTORY, []) ?? [];
  if (!history.some((h) => h.date === today)) {
    history.push({ date: today, top: topSong.name, recommend: recSong.name, source });
  }
  writeFileSync(join(OUT_DIR, 'history.json'), JSON.stringify(history, null, 2));

  console.log(
    `ok: top="${topSong.name}" (${topSong.playCount}, ${source}) recommend="${recSong.name}" days=${history.length}`,
  );
}

main().catch((err) => {
  console.error(`failed: ${err.message}`);
  process.exit(1);
});
