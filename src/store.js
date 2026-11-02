/**
 * bili-cocoon · 存储层
 *
 * 只用 Node 内置的 node:sqlite（Node >= 22.5，本机 24.16 可用），零 npm 依赖。
 * 表结构见 SPEC.md；一行 = 某天 / 某来源 / 某个视频。
 *
 * 设计要点：
 * - openStore() 会自动 mkdir -p 数据库的父目录（node:sqlite 自己不会建目录）。
 * - 主键 (date, source, bvid)，重复写入用 INSERT OR REPLACE 覆盖同一条。
 * - tags 以 JSON 字符串落库，读出来还原成 string[]。
 * - 所有绑定值都显式归一化成 null / number / string：
 *   node:sqlite 不接受 undefined 和 boolean，会直接抛 TypeError。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

/** 默认库路径（相对当前工作目录） */
export const DEFAULT_DB_PATH = 'data/cocoon.db';

/** 快照来源，顺序即 CLI 展示顺序 */
export const SOURCES = Object.freeze(['rcmd', 'history', 'ranking']);

const MEMORY_TARGETS = new Set([':memory:', 'file::memory:', 'file::memory:?cache=shared']);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS snapshot(
  date TEXT NOT NULL, source TEXT NOT NULL, bvid TEXT, tid INTEGER, tname TEXT,
  mid INTEGER, upName TEXT, title TEXT, rcmdReason TEXT, tags TEXT, view INTEGER, pubdate INTEGER,
  PRIMARY KEY(date, source, bvid)
);
CREATE INDEX IF NOT EXISTS idx_snap_date ON snapshot(date);

-- 曝光侧采样：同一天、同一身份（login/guest）、同一轮次里看到的一条推荐。
-- 与 snapshot 分开存，因为一次采集会抓多轮，同一 bvid 可能在多轮里重复出现，
-- 而 snapshot 的主键 (date,source,bvid) 会把重复压扁、丢掉「重复曝光」这个信号。
CREATE TABLE IF NOT EXISTS exposure(
  date TEXT NOT NULL, kind TEXT NOT NULL, round INTEGER NOT NULL, bvid TEXT NOT NULL,
  tid INTEGER, tname TEXT, mid INTEGER, upName TEXT, title TEXT, rcmdReason TEXT,
  PRIMARY KEY(date, kind, round, bvid)
);
CREATE INDEX IF NOT EXISTS idx_expo_date ON exposure(date);
`;

const COLUMNS = 'date, source, bvid, tid, tname, mid, upName, title, rcmdReason, tags, view, pubdate';

const INSERT_SQL = `
INSERT OR REPLACE INTO snapshot
  (date, source, bvid, tid, tname, mid, upName, title, rcmdReason, tags, view, pubdate)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// ---------------------------------------------------------------- 工具函数

/** 归一化成 TEXT 或 null（空字符串视作 null，避免 NULL/'' 两种缺失并存） */
function toText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length ? s : null;
}

/** 归一化成 INTEGER 或 null（node:sqlite 只认 null/number/bigint，不收 boolean） */
function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/** tags: string[] -> JSON 字符串 */
function tagsToJson(tags) {
  if (Array.isArray(tags)) return JSON.stringify(tags.map((t) => String(t)));
  if (typeof tags === 'string' && tags.length) {
    // 兼容上游直接给了字符串的情况
    try {
      const parsed = JSON.parse(tags);
      return JSON.stringify(Array.isArray(parsed) ? parsed.map(String) : [tags]);
    } catch {
      return JSON.stringify([tags]);
    }
  }
  return '[]';
}

/** JSON 字符串 -> string[]（永不抛错） */
function tagsFromJson(text) {
  if (typeof text !== 'string' || !text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map((t) => String(t)) : [];
  } catch {
    return [];
  }
}

/** 日期统一成 YYYY-MM-DD（接受 Date / ISO 字符串） */
function normalizeDate(date) {
  if (date instanceof Date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(date ?? '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (!m) throw new TypeError(`日期格式应为 YYYY-MM-DD，收到: ${JSON.stringify(date)}`);
  return m[1];
}

function assertOpen(store) {
  if (!store || typeof store !== 'object' || !store.db) {
    throw new TypeError('store 无效：请先用 openStore(path) 打开数据库');
  }
  if (store.closed) throw new Error('store 已关闭，不能继续使用');
}

/** node:sqlite 没有更 sqlite 那样的 transaction() 包装，这里手工 BEGIN/COMMIT/ROLLBACK */
function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败就别把原始错误盖掉 */
    }
    throw err;
  }
}

/** 数据库行（null-prototype 对象）-> 普通对象；tags 还原成数组 */
function rowToItem(row) {
  return {
    date: row.date,
    source: row.source,
    bvid: row.bvid ?? null,
    tid: row.tid ?? null,
    tname: row.tname ?? null,
    mid: row.mid ?? null,
    upName: row.upName ?? null,
    title: row.title ?? null,
    rcmdReason: row.rcmdReason ?? null,
    tags: tagsFromJson(row.tags),
    view: row.view ?? null,
    pubdate: row.pubdate ?? null,
  };
}

// ---------------------------------------------------------------- 对外 API

/**
 * 打开（必要时创建）数据库，建表建索引。
 * @param {string} [path] 数据库文件路径；':memory:' 表示内存库
 * @returns {{ db: DatabaseSync, path: string, closed: boolean, stmt: object }}
 */
export function openStore(path = DEFAULT_DB_PATH) {
  const file = String(path || DEFAULT_DB_PATH);

  // node:sqlite 不会帮你建目录，父目录不存在会抛 "unable to open database file"
  if (!MEMORY_TARGETS.has(file) && !file.startsWith('file:')) {
    mkdirSync(dirname(resolvePath(file)), { recursive: true });
  }

  const db = new DatabaseSync(file);
  db.exec(SCHEMA_SQL);

  const store = {
    db,
    path: file,
    closed: false,
    stmt: {
      insert: db.prepare(INSERT_SQL),
      deleteDaySource: db.prepare('DELETE FROM snapshot WHERE date = ? AND source = ?'),
      dates: db.prepare('SELECT DISTINCT date FROM snapshot ORDER BY date DESC LIMIT ?'),
      since: db.prepare(
        `SELECT ${COLUMNS} FROM snapshot WHERE date >= ? ORDER BY date DESC, source ASC, rowid ASC`,
      ),
      count: db.prepare('SELECT COUNT(*) AS n FROM snapshot'),
    },
  };
  return store;
}

/** 写一个来源的行（内部用），返回 { inserted, skipped } */
function writeSource(store, date, source, items) {
  if (!Array.isArray(items) || items.length === 0) return { inserted: 0, skipped: 0 };

  // “快照”语义：同一天同一来源整体替换，否则重采（比如 --limit 变小）会残留旧 bvid，
  // 让样本量虚高。空数组不删——那通常意味着该来源本次失败，不该抹掉当天已有数据。
  store.stmt.deleteDaySource.run(date, source);

  const stmt = store.stmt.insert;
  let inserted = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      skipped += 1;
      continue;
    }
    // 主键里有 bvid：没有 bvid 就退化用 av 号，两者都没有则跳过
    let bvid = toText(item.bvid);
    if (!bvid) {
      const aid = toInt(item.aid);
      bvid = aid === null ? null : `av${aid}`;
    }
    if (!bvid) {
      skipped += 1;
      continue;
    }

    stmt.run(
      date,
      source,
      bvid,
      toInt(item.tid),
      toText(item.tname),
      toInt(item.mid),
      toText(item.upName),
      toText(item.title),
      toText(item.rcmdReason),
      tagsToJson(item.tags),
      toInt(item.view),
      toInt(item.pubdate),
    );
    inserted += 1;
  }
  return { inserted, skipped };
}

/**
 * 保存一天的快照：feed 写 source='rcmd'，history 写 source='history'。
 * 第四个参数之后是可选的 ranking（CLI 需要，SPEC 的四参调用不受影响）。
 * 同一 (date, source, bvid) 重复写入会覆盖。
 *
 * @returns {{date:string, rcmd:number, history:number, ranking:number, total:number, skipped:number}}
 */
export function saveSnapshot(store, date, feed, history, ranking = []) {
  assertOpen(store);
  const day = normalizeDate(date);

  return withTransaction(store.db, () => {
    const rcmd = writeSource(store, day, 'rcmd', feed);
    const hist = writeSource(store, day, 'history', history);
    const rank = writeSource(store, day, 'ranking', ranking);
    return {
      date: day,
      rcmd: rcmd.inserted,
      history: hist.inserted,
      ranking: rank.inserted,
      total: rcmd.inserted + hist.inserted + rank.inserted,
      skipped: rcmd.skipped + hist.skipped + rank.skipped,
    };
  });
}

/**
 * 取最近 N 天（按 date 降序）的所有行，按日期 + 来源分组。
 * @param {object} store
 * @param {number} [days=7]
 * @returns {{
 *   days:number, dates:string[], latest:string|null,
 *   byDate: Record<string, {rcmd:object[], history:object[], ranking:object[]}>,
 *   bySource: {rcmd:object[], history:object[], ranking:object[]}
 * }}
 */
export function listSnapshots(store, days = 7) {
  assertOpen(store);

  const raw = Number(days);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7;

  const dates = store.stmt.dates.all(n).map((row) => row.date);
  const byDate = {};
  const bySource = { rcmd: [], history: [], ranking: [] };
  const result = { days: n, dates, latest: dates.length ? dates[0] : null, byDate, bySource };

  if (dates.length === 0) return result;

  // dates 是最近 N 个不同日期；取其中最旧的那天做下界即可命中这 N 天
  const cutoff = dates[dates.length - 1];
  const rows = store.stmt.since.all(cutoff);

  for (const row of rows) {
    const item = rowToItem(row);
    const bucket = byDate[item.date] ?? (byDate[item.date] = { rcmd: [], history: [], ranking: [] });
    if (Array.isArray(bucket[item.source])) bucket[item.source].push(item);
    if (Array.isArray(bySource[item.source])) bySource[item.source].push(item);
  }

  return result;
}

/**
 * 写入一轮曝光采样。kind 是身份：'login' | 'guest'。
 * 同一 (date, kind, round) 重复写会整体替换（与 snapshot 的“快照”语义一致）。
 *
 * @returns {{inserted:number, skipped:number}}
 */
export function saveExposure(store, date, kind, round, items) {
  assertOpen(store);
  const day = normalizeDate(date);
  const k = String(kind);
  const r = Math.max(1, Math.trunc(Number(round) || 1));
  if (!Array.isArray(items) || items.length === 0) return { inserted: 0, skipped: 0 };

  const del = store.db.prepare('DELETE FROM exposure WHERE date = ? AND kind = ? AND round = ?');
  const ins = store.db.prepare(
    `INSERT OR REPLACE INTO exposure(date, kind, round, bvid, tid, tname, mid, upName, title, rcmdReason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return withTransaction(store.db, () => {
    del.run(day, k, r);
    let inserted = 0;
    let skipped = 0;
    for (const item of items) {
      if (!item || typeof item !== 'object') {
        skipped += 1;
        continue;
      }
      let bvid = toText(item.bvid);
      if (!bvid) {
        const aid = toInt(item.aid);
        bvid = aid === null ? null : `av${aid}`;
      }
      if (!bvid) {
        skipped += 1;
        continue;
      }
      ins.run(
        day,
        k,
        r,
        bvid,
        toInt(item.tid),
        toText(item.tname),
        toInt(item.mid),
        toText(item.upName),
        toText(item.title),
        toText(item.rcmdReason),
      );
      inserted += 1;
    }
    return { inserted, skipped };
  });
}

/**
 * 读最近 N 天的曝光采样原始行。
 * 不在这里聚合：同一个 bvid 在几轮里出现过几次，是分析层要的信号。
 *
 * @returns {{days:number, dates:string[], rows:Array<object>}}
 */
export function listExposure(store, days = 7) {
  assertOpen(store);
  const raw = Number(days);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7;
  const dates = store.db
    .prepare('SELECT DISTINCT date FROM exposure ORDER BY date DESC LIMIT ?')
    .all(n)
    .map((row) => row.date);
  if (!dates.length) return { days: n, dates: [], rows: [] };

  const cutoff = dates[dates.length - 1];
  const rows = store.db
    .prepare(
      `SELECT date, kind, round, bvid, tid, tname, mid, upName, title, rcmdReason
       FROM exposure WHERE date >= ? ORDER BY date DESC, kind ASC, round ASC`,
    )
    .all(cutoff);
  return { days: n, dates, rows };
}

/** 关库；重复调用是安全的 */
export function closeStore(store) {
  if (!store) return;
  // 容错：允许直接传 DatabaseSync
  if (typeof store.close === 'function' && !store.db) {
    store.close();
    return;
  }
  if (store.closed) return;
  try {
    store.db.close();
  } finally {
    store.closed = true;
  }
}

export default {
  openStore,
  saveSnapshot,
  listSnapshots,
  saveExposure,
  listExposure,
  closeStore,
  DEFAULT_DB_PATH,
  SOURCES,
};
