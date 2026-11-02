import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = process.env.OUT_DIR ?? "dist";
const TEXT = "#FF8C00";

// 按北京时间取当天日期，同一天内多次运行结果不变，跨天自动换签
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

function hash(str) {
  let h = 2166136261;
  for (const ch of str) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const rand = hash(`${today}#fortune`) / 4294967296;

const tiers = [
  { name: "上上签", weight: 20 },
  { name: "上签", weight: 40 },
  { name: "中签", weight: 30 },
  { name: "下签", weight: 8 },
  { name: "下下签", weight: 2 },
];

let acc = 0;
const fortune = tiers.find((t) => (acc += t.weight) / 100 > rand) ?? tiers.at(-1);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="156" height="56" viewBox="0 0 156 56" role="img" aria-label="今日签运：${fortune.name}">
  <title>今日签运：${fortune.name}（${today}）</title>
  <rect x="1" y="12" width="154" height="32" rx="16" fill="none" stroke="${TEXT}" stroke-width="1.5"/>
  <text x="78" y="33" text-anchor="middle" fill="${TEXT}" font-family="'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif" font-size="13" font-weight="600">今日签运：${fortune.name}</text>
</svg>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "fortune.svg"), svg);
console.log(`fortune ${today}: ${fortune.name}`);
