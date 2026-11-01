#!/usr/bin/env node
// 网易云听歌报告：抓取「全部时间 Top 100 听歌排行」→ 与上一次快照做差 → 渲染 SVG 卡片
//
// 环境变量:
//   NETEASE_UID        账号 uid（数字）
//   NETEASE_COOKIE     登录 cookie，至少包含 MUSIC_U（可选 __csrf）
//   PREV_SNAPSHOT      上一次的 snapshot.json 路径（不存在则视为首次运行）
//   PREV_HISTORY       上一次的 history.json 路径（可选）
//   OUT_DIR            输出目录，默认 dist
//   NETEASE_RECORD_FILE  调试用：直接读取本地 record JSON，不走网络

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const UID = process.env.NETEASE_UID?.trim();
const COOKIE = process.env.NETEASE_COOKIE?.trim();
const OUT_DIR = process.env.OUT_DIR ?? 'dist';
const PREV_SNAPSHOT = process.env.PREV_SNAPSHOT ?? '';
const PREV_HISTORY = process.env.PREV_HISTORY ?? '';
const RECORD_FILE = process.env.NETEASE_RECORD_FILE ?? '';
const MAX_ROWS = 10;
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

async function fetchJson(url) {
  const headers = {
    'User-Agent': UA,
    Referer: 'https://music.163.com/',
    Accept: 'application/json',
  };
  if (COOKIE) headers.Cookie = COOKIE;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSong(item) {
  const song = item.song ?? {};
  const artist = (song.ar ?? song.artists ?? []).map((a) => a.name).join(' / ');
  return {
    id: song.id,
    name: song.name ?? '(unknown)',
    artist: artist || '(unknown)',
    playCount: Number(item.playCount ?? 0),
  };
}

async function loadRecord() {
  if (RECORD_FILE) return readJson(RECORD_FILE);
  if (!UID) throw new Error('缺少环境变量 NETEASE_UID');
  const url = `https://music.163.com/api/v1/play/record?uid=${UID}&type=0`;
  const data = await fetchJson(url);
  if (data.code !== 200) {
    throw new Error(
      `接口返回 code=${data.code} msg=${data.msg ?? ''}。常见原因：cookie 过期/被风控，或该账号的听歌排行未公开。`,
    );
  }
  return data;
}

async function loadListenSongs() {
  if (RECORD_FILE || !UID) return null;
  try {
    const data = await fetchJson(`https://music.163.com/api/v1/user/detail/${UID}`);
    return Number(data?.listenSongs ?? 0) || null;
  } catch {
    return null;
  }
}

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// 按显示宽度（中日韩字符算 2）截断
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

function buildDiff(songs, prev) {
  const prevMap = new Map((prev?.songs ?? []).map((s) => [s.id, s]));
  const prevRank = new Map((prev?.songs ?? []).map((s, i) => [s.id, i + 1]));
  const hasPrev = (prev?.songs ?? []).length > 0;

  const rows = songs.map((s, i) => {
    const old = prevMap.get(s.id);
    return {
      ...s,
      rank: i + 1,
      isNew: hasPrev ? !old : false,
      playDelta: old ? s.playCount - old.playCount : null,
      rankDelta: hasPrev ? (old ? prevRank.get(s.id) - (i + 1) : null) : null,
    };
  });

  const totals = {
    playTotal: songs.reduce((a, s) => a + s.playCount, 0),
    prevPlayTotal: prev?.playTotal ?? null,
    newCount: rows.filter((r) => r.isNew).length,
  };
  return { rows, totals, hasPrev };
}

function renderSvg({ rows, totals, hasPrev, listenSongs, history }) {
  const W = 800;
  const padX = 24;
  const headY = 44;
  const statY = 76;
  const statH = 62;
  const tableY = statY + statH + 34;
  const rowH = 26;
  const H = tableY + MAX_ROWS * rowH + 40;

  const c = {
    title: '#57606a',
    label: '#8b949e',
    value: '#c20c0c',
    text: '#57606a',
    dim: '#8b949e',
    rule: '#8b949e',
  };

  const totalDelta =
    totals.prevPlayTotal === null ? null : totals.playTotal - totals.prevPlayTotal;
  const stats = [
    { label: 'TOP100 PLAYS', value: fmt(totals.playTotal) },
    {
      label: hasPrev ? 'ADDED TODAY' : 'ADDED TODAY',
      value: totalDelta === null ? '—' : (totalDelta > 0 ? '+' : '') + fmt(totalDelta),
    },
    {
      label: 'SONGS EVER PLAYED',
      value: listenSongs === null ? '—' : fmt(listenSongs),
    },
    {
      label: 'NEW ENTRIES',
      value: hasPrev ? fmt(totals.newCount) : '—',
    },
  ];

  const statW = (W - padX * 2 - 12 * (stats.length - 1)) / stats.length;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Noto Sans,Helvetica,Arial,sans-serif">`,
  );
  parts.push(`<title>NetEase listening report ${today}</title>`);

  // 标题
  parts.push(
    `<text x="${padX}" y="${headY}" font-size="20" font-weight="600" fill="${c.title}">Listening Report</text>`,
  );
  parts.push(
    `<text x="${W - padX}" y="${headY}" font-size="12" fill="${c.label}" text-anchor="end">${today}</text>`,
  );
  parts.push(
    `<line x1="${padX}" y1="${headY + 14}" x2="${W - padX}" y2="${headY + 14}" stroke="${c.rule}" stroke-opacity="0.35"/>`,
  );

  // 四个指标块
  stats.forEach((s, i) => {
    const x = padX + i * (statW + 12);
    parts.push(
      `<rect x="${x}" y="${statY}" width="${statW}" height="${statH}" rx="8" fill="none" stroke="${c.rule}" stroke-opacity="0.35"/>`,
    );
    parts.push(
      `<text x="${x + 14}" y="${statY + 24}" font-size="10" letter-spacing="0.8" fill="${c.label}">${esc(s.label)}</text>`,
    );
    parts.push(
      `<text x="${x + 14}" y="${statY + 50}" font-size="22" font-weight="600" fill="${c.value}">${esc(s.value)}</text>`,
    );
  });

  // 表头
  const colRank = padX;
  const colName = padX + 26;
  const colArtist = padX + 400;
  const colPlays = W - padX - 74;
  const colDelta = W - padX;
  parts.push(
    `<text x="${colRank}" y="${tableY - 10}" font-size="10" letter-spacing="0.8" fill="${c.label}">#</text>`,
  );
  parts.push(
    `<text x="${colName}" y="${tableY - 10}" font-size="10" letter-spacing="0.8" fill="${c.label}">SONG</text>`,
  );
  parts.push(
    `<text x="${colArtist}" y="${tableY - 10}" font-size="10" letter-spacing="0.8" fill="${c.label}">ARTIST</text>`,
  );
  parts.push(
    `<text x="${colPlays}" y="${tableY - 10}" font-size="10" letter-spacing="0.8" fill="${c.label}" text-anchor="end">PLAYS</text>`,
  );
  parts.push(
    `<text x="${colDelta}" y="${tableY - 10}" font-size="10" letter-spacing="0.8" fill="${c.label}" text-anchor="end">TODAY</text>`,
  );

  rows.slice(0, MAX_ROWS).forEach((r, i) => {
    const y = tableY + 10 + i * rowH;
    const delta =
      r.isNew || r.playDelta === null
        ? { text: hasPrev ? 'NEW' : '—', fill: c.value }
        : {
            text: (r.playDelta > 0 ? '+' : '') + r.playDelta,
            fill: r.playDelta > 0 ? c.value : c.dim,
          };
    parts.push(`<text x="${colRank}" y="${y}" font-size="12" fill="${c.dim}">${r.rank}</text>`);
    parts.push(`<text x="${colName}" y="${y}" font-size="13" fill="${c.text}">${esc(clip(r.name, 48))}</text>`);
    parts.push(`<text x="${colArtist}" y="${y}" font-size="12" fill="${c.dim}">${esc(clip(r.artist, 30))}</text>`);
    parts.push(
      `<text x="${colPlays}" y="${y}" font-size="13" fill="${c.text}" text-anchor="end">${fmt(r.playCount)}</text>`,
    );
    parts.push(
      `<text x="${colDelta}" y="${y}" font-size="12" font-weight="600" fill="${delta.fill}" text-anchor="end">${esc(delta.text)}</text>`,
    );
    if (i < MAX_ROWS - 1) {
      parts.push(
        `<line x1="${padX}" y1="${y + 9}" x2="${W - padX}" y2="${y + 9}" stroke="${c.rule}" stroke-opacity="0.12"/>`,
      );
    }
  });

  parts.push(
    `<text x="${padX}" y="${H - 12}" font-size="10" fill="${c.label}">data: netease user/record (all-time top 100) · updated daily</text>`,
  );
  parts.push(
    `<text x="${W - padX}" y="${H - 12}" font-size="10" fill="${c.label}" text-anchor="end">${history.length} day(s) tracked</text>`,
  );
  parts.push('</svg>');
  return parts.join('\n');
}

async function main() {
  const record = await loadRecord();
  const songs = (record.allData ?? []).map(normalizeSong);
  if (songs.length === 0) throw new Error('allData 为空：请确认 cookie 有效且听歌排行对处于可见状态');

  songs.sort((a, b) => b.playCount - a.playCount);
  const prev = readJson(PREV_SNAPSHOT);
  const { rows, totals, hasPrev } = buildDiff(songs, prev);
  const listenSongs = await loadListenSongs();

  const history = readJson(PREV_HISTORY, []) ?? [];
  if (!history.some((h) => h.date === today)) {
    history.push({ date: today, playTotal: totals.playTotal, listenSongs });
  }

  const snapshot = {
    date: today,
    uid: UID ?? null,
    listenSongs,
    playTotal: totals.playTotal,
    songs: songs.map(({ id, name, artist, playCount }) => ({ id, name, artist, playCount })),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'latest.svg'), renderSvg({ rows, totals, hasPrev, listenSongs, history }));
  writeFileSync(join(OUT_DIR, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  writeFileSync(join(OUT_DIR, 'history.json'), JSON.stringify(history, null, 2));

  const delta = totals.prevPlayTotal === null ? 'n/a' : totals.playTotal - totals.prevPlayTotal;
  console.log(
    `ok: ${songs.length} songs, plays=${totals.playTotal}, delta=${delta}, new=${totals.newCount}, days=${history.length}`,
  );
}

main().catch((err) => {
  console.error(`failed: ${err.message}`);
  process.exit(1);
});
