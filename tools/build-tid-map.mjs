// tools/build-tid-map.mjs
// 生成 src/tid-region.json：二级分区 tid → 分区名。
//
// 为什么需要它：/x/web-interface/view 现在（2026-11 实测）无论登录与否都返回
// tname=""、tname_v2=""，只给 tid。rcmd 流本身又不带分区字段，于是采集时只能拿
// 到 tid，靠 api.js 里那 29 条硬编码兜底，剩下的全变成「分区230」这种占位名，
// parentOf() 认不出、统统落进「其他」，推荐流的分区分布直接失真。
//
// 反查通道：x/web-interface/ranking/region?rid=<tid>&day=3 返回的 typename
// 就是该 tid 的分区名（实测 33/33 命中）。旧接口，不需要 WBI 签名。
//
// 用法：
//   node tools/build-tid-map.mjs                 # 扫 data/cocoon.db 里所有「分区NNN」的 tid
//   node tools/build-tid-map.mjs --tid 17,173    # 补指定 tid
//   node tools/build-tid-map.mjs --tid all       # 扫库里的全部 tid（含已知的，用于校验）
//
// 设计原则：只增不删、失败不写。某个 tid 查不到就跳过并警告，绝不用猜测的名字覆盖。

import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DB_PATH = path.join(ROOT, 'data', 'cocoon.db');
const OUT_PATH = path.join(ROOT, 'src', 'tid-region.json');
const REGION_MAP_PATH = path.join(ROOT, 'src', 'region-map.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DELAY_MS = 1100; // ranking/region 比主接口更容易触发风控，慢一点
const RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 反查单个 tid 的分区名。名字冲突或空结果都视为失败（不猜）。 */
async function fetchTypeName(tid) {
  const url = `https://api.bilibili.com/x/web-interface/ranking/region?rid=${tid}&day=3`;
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      });
      const json = await res.json();
      if (json.code !== 0) throw new Error(`code=${json.code} ${json.message ?? ''}`);
      const list = Array.isArray(json.data) ? json.data : [];
      const names = [...new Set(list.map((it) => it.typename).filter(Boolean))];
      if (names.length === 0) throw new Error('返回 0 条视频（分区可能过冷）');
      if (names.length > 1) throw new Error(`名字冲突：${names.join(' / ')}`);
      return names[0];
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(DELAY_MS);
    }
  }
  throw lastErr;
}

/** 从命令行 / 数据库收集待查询的 tid。 */
function collectTids(argv) {
  const idx = argv.indexOf('--tid');
  if (idx !== -1) {
    const raw = String(argv[idx + 1] ?? '').trim();
    if (!raw) throw new Error('--tid 后面要跟 tid，逗号分隔');
    if (raw === 'all') return { tids: [], mode: 'all' };
    const tids = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    if (!tids.length) throw new Error('--tid 里没有合法数字');
    return { tids, mode: 'explicit' };
  }
  return { tids: [], mode: 'unknown' };
}

function tidsFromDb(mode) {
  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (err) {
    throw new Error(`打不开 ${DB_PATH}：${err.message}`);
  }
  try {
    const sql =
      mode === 'all'
        ? 'SELECT DISTINCT tid FROM snapshot WHERE tid IS NOT NULL ORDER BY tid'
        : "SELECT DISTINCT tid FROM snapshot WHERE tid IS NOT NULL AND tname LIKE '分区%' ORDER BY tid";
    return db.prepare(sql).all().map((r) => Number(r.tid));
  } finally {
    db.close();
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const { tids: explicitTids, mode } = collectTids(process.argv.slice(2));
const tids = mode === 'explicit' ? explicitTids : tidsFromDb(mode);
if (!tids.length) {
  console.log('没有待查询的 tid。');
  process.exit(0);
}

const existing = await readJson(OUT_PATH, {});
const regionMap = await readJson(REGION_MAP_PATH, {});
const next = { ...existing };

console.log(`待查 ${tids.length} 个 tid：${tids.join(', ')}`);
const failed = [];
let added = 0;
let kept = 0;

for (const tid of tids) {
  const key = String(tid);
  if (existing[key] && mode !== 'all') {
    kept += 1;
    console.log(`  tid=${String(tid).padEnd(5)} 已有 ${existing[key]}`);
    continue;
  }
  try {
    const name = await fetchTypeName(tid);
    const prev = existing[key];
    if (prev && prev !== name) {
      console.warn(`  tid=${tid} 名字变了：${prev} → ${name}（以新值为准，旧值可能来自接口改版）`);
    }
    next[key] = name;
    added += 1;
    const parent = regionMap[name];
    console.log(`  tid=${String(tid).padEnd(5)} → ${name}${parent ? `（父级 ${parent}）` : '  ⚠ region-map 里没有这个二级名'}`);
  } catch (err) {
    failed.push({ tid, error: err.message });
    console.warn(`  tid=${String(tid).padEnd(5)} 失败：${err.message}`);
  }
  await sleep(DELAY_MS);
}

// 稳定排序输出，便于 diff
const sorted = Object.fromEntries(Object.keys(next).sort((a, b) => Number(a) - Number(b)).map((k) => [k, next[k]]));
await fs.writeFile(OUT_PATH, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');

const unmapped = Object.values(sorted).filter((name) => !regionMap[name]);
console.log(`\n写入 ${OUT_PATH}：新增 ${added}，沿用 ${kept}，总计 ${Object.keys(sorted).length} 条。`);
if (unmapped.length) {
  console.log(`⚠ 这些二级名在 region-map.json 里没有父级，会被算成「其他」：${[...new Set(unmapped)].join('、')}`);
}
if (failed.length) {
  console.log(`⚠ ${failed.length} 个 tid 没查到（保持原样，下次可重试）：${failed.map((f) => f.tid).join(', ')}`);
  process.exitCode = 1;
}
