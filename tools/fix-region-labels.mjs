// Backfills historical '分区NNN' placeholder names in the snapshot table.

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
