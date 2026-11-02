// tools/build-region-map.mjs
// 重建 src/region-map.json：把「二级分区名 → 一级分区名」的映射从排行榜接口反推出来。
//
// 原理：ranking/v2?rid=<一级分区 id> 返回的条目里带 tname（二级分区名），
// 于是「该 rid 下出现的所有 tname」就属于这个一级分区。
//
// 注意：番剧(13)/综艺(71)/国创(167)/资讯(202) 这几个 rid 排行榜会返回 -400，
// 映射表里没有它们，运行时落到「其他」。
//
// 用法：node tools/build-region-map.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requestJson } from '../src/wbi.js';

const PARENTS = {
  1: '动画', 3: '音乐', 4: '游戏', 5: '娱乐', 11: '电视剧', 13: '番剧', 23: '电影',
  36: '知识', 71: '综艺', 119: '鬼畜', 129: '舞蹈', 155: '时尚', 160: '生活',
  167: '国创', 177: '纪录片', 181: '影视', 188: '科技', 202: '资讯', 211: '美食',
  217: '动物', 223: '汽车', 234: '运动',
};

const out = {};
let ok = 0;

for (const [rid, parent] of Object.entries(PARENTS)) {
  try {
    const json = await requestJson(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`, {});
    if (json.code !== 0) {
      console.log(`rid=${rid} ${parent}: code=${json.code}（跳过）`);
      continue;
    }
    ok += 1;
    for (const item of json.data.list ?? []) {
      if (item.tname && item.tname !== parent) out[item.tname] = parent;
    }
    console.log(`rid=${rid} ${parent}: ${new Set((json.data.list ?? []).map((i) => i.tname)).size} 个二级分区`);
  } catch (error) {
    console.log(`rid=${rid} ${parent}: ${error.code ?? error.message}（跳过）`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'src', 'region-map.json');
await fs.writeFile(target, `${JSON.stringify(out, null, 1)}\n`, 'utf8');
console.log(`\n覆盖 ${ok} 个一级分区，${Object.keys(out).length} 个二级分区 → ${target}`);
