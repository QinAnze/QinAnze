import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = process.env.OUT_DIR ?? "dist";
const TEXT = "#FF8C00";

// 按北京时间取当天日期，用 ISO 周号做种子：同一周内结果不变，每周一换签
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function hash(str) {
  let h = 2166136261;
  for (const ch of str) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const week = isoWeek(today);
const rand = hash(`${week}#fortune`) / 4294967296;

const tiers = [
  { name: "上上签", weight: 20 },
  { name: "上签", weight: 40 },
  { name: "中签", weight: 30 },
  { name: "下签", weight: 8 },
  { name: "下下签", weight: 2 },
];

let acc = 0;
const fortune = tiers.find((t) => (acc += t.weight) / 100 > rand) ?? tiers.at(-1);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="156" height="52" viewBox="0 0 156 52" role="img" aria-label="本周签运：${fortune.name}">
  <title>本周签运：${fortune.name}（${week}）</title>
  <rect x="1" y="10" width="154" height="32" rx="16" fill="none" stroke="${TEXT}" stroke-width="1.5"/>
  <text x="78" y="31" text-anchor="middle" fill="${TEXT}" font-family="'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif" font-size="13" font-weight="600">本周签运：${fortune.name}</text>
</svg>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "fortune.svg"), svg);
console.log(`fortune ${week} (${today}): ${fortune.name}`);
