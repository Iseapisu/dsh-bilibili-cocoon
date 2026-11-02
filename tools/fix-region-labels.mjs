// tools/fix-region-labels.mjs
// 数据迁移：把 snapshot 表里历史遗留的「分区<tid>」占位名，按 src/tid-region.json 改成真实分区名。
//
// 为什么需要：2026-10-30 ~ 11-02 采集的 rcmd 数据，因为 /view 不返回 tname，
// 全都落成了「分区173」这种占位值，parentOf() 认不出 → 全进「其他」。
// 补了映射表之后，旧快照也要回填，否则历史趋势对比仍然是错的。
//
// 用法：
//   node tools/fix-region-labels.mjs --dry-run   # 只看会改多少行
//   node tools/fix-region-labels.mjs             # 实际写库（幂等，可重复执行）

import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DB_PATH = path.join(ROOT, 'data', 'cocoon.db');
const TID_MAP_PATH = path.join(ROOT, 'src', 'tid-region.json');
const dryRun = process.argv.includes('--dry-run');

const tidMap = JSON.parse(await fs.readFile(TID_MAP_PATH, 'utf8'));
const db = new DatabaseSync(DB_PATH);

const plan = [];
for (const [tid, name] of Object.entries(tidMap)) {
  const rows = db
    .prepare("SELECT COUNT(*) AS n FROM snapshot WHERE tid=? AND tname LIKE '分区%'")
    .get(Number(tid));
  if (rows.n > 0) plan.push({ tid: Number(tid), name, n: rows.n });
}

const total = plan.reduce((a, p) => a + p.n, 0);
if (!plan.length) {
  console.log('没有需要回填的占位名。');
  db.close();
  process.exit(0);
}

console.log(`${dryRun ? '[dry-run] ' : ''}将回填 ${total} 行：`);
for (const p of plan) console.log(`  tid=${String(p.tid).padEnd(5)} → ${p.name.padEnd(10)} ${p.n} 行`);

if (!dryRun) {
  const update = db.prepare("UPDATE snapshot SET tname=? WHERE tid=? AND tname LIKE '分区%'");
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const p of plan) changed += update.run(p.name, p.tid).changes;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`已更新 ${changed} 行。`);

  const left = db.prepare("SELECT COUNT(*) AS n FROM snapshot WHERE tname LIKE '分区%'").get().n;
  console.log(`库里剩余占位名：${left} 行${left ? '（这些 tid 还没查过，跑 node tools/build-tid-map.mjs 补）' : ''}`);
}
db.close();
