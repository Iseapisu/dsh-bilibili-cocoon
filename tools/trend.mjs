// Multi-day trend comparison across stored snapshots.

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import * as metrics from '../src/metrics.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const dbPath = path.resolve(ROOT, argOf('--db', 'data/cocoon.db'));
const days = Number(argOf('--days', '0')) || 0;

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  let dates = db.prepare('SELECT DISTINCT date FROM snapshot ORDER BY date').all().map((r) => r.date);
  if (days > 0) dates = dates.slice(-days);
  if (!dates.length) {
    console.log('库里还没有快照，先跑一次 collect。');
    process.exit(0);
  }

  const stmt = db.prepare('SELECT * FROM snapshot WHERE date=? AND source=?');
  const load = (date, source) =>
    stmt.all(date, source).map((r) => ({
      bvid: r.bvid,
      title: r.title,
      mid: r.mid,
      upName: r.upName,
      tid: r.tid,
      tname: r.tname,
      tags: [],
      rcmdReason: r.rcmdReason,
      view: r.view,
      pubdate: r.pubdate,
      source,
    }));

  const days_ = dates.map((d) => {
    const feed = load(d, 'rcmd');
    const history = load(d, 'history');
    const ranking = load(d, 'ranking');
    const result = metrics.cocoonScore({ feed, history, ranking, date: d }, { date: d });
    return { date: d, feed, history, ranking, result };
  });

  const f = (v, n = 3) => (v === null || v === undefined || Number.isNaN(v) ? '-' : Number(v).toFixed(n));
  console.log('日期          指数    熵     有效分区  HHI    UP基尼  重复率  主主题(占已分类)');
  for (const { date, result } of days_) {
    const th = result.themes ?? {};
    console.log(
      `${date}  ${f(result.index, 1).padStart(5)}  ${f(result.entropyNorm)}   ` +
        `${f(result.effectiveCategories, 2).padStart(6)}  ${f(result.hhi)}  ${f(result.gini)}  ` +
        `${f(result.uploaderRepeat * 100, 1).padStart(5)}%  ${th.topName ?? '-'} ${f((th.topShare ?? 0) * 100, 1)}%`,
    );
  }

  if (days_.length >= 2) {
    console.log('\n相邻两天内容重合（bvid）：');
    for (let i = 1; i < days_.length; i += 1) {
      const a = days_[i - 1];
      const b = days_[i];
      const parts = [];
      for (const [label, key] of [['recommend', 'feed'], ['history', 'history'], ['ranking', 'ranking']]) {
        const A = new Set(a[key].map((x) => x.bvid));
        const B = new Set(b[key].map((x) => x.bvid));
        const inter = [...B].filter((x) => A.has(x)).length;
        parts.push(`${label} ${inter}/${B.size}`);
      }
      console.log(`  ${a.date} → ${b.date}: ${parts.join('  ·  ')}`);
    }
  }

  const last = days_[days_.length - 1];
  console.log(`\n${last.date} 分区 TOP5（一级）：` + last.result.topCategories.map((c) => `${c.name}${c.n}`).join(' '));
  console.log(`${last.date} UP TOP5：` + last.result.topUploaders.map((u) => `${u.name}(${u.n})`).join(' '));
} finally {
  db.close();
}
