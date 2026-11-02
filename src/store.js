// SQLite persistence: daily snapshots plus multi-round exposure samples.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

export const DEFAULT_DB_PATH = 'data/cocoon.db';

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

function toText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length ? s : null;
}

function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function tagsToJson(tags) {
  if (Array.isArray(tags)) return JSON.stringify(tags.map((t) => String(t)));
  if (typeof tags === 'string' && tags.length) {
    try {
      const parsed = JSON.parse(tags);
      return JSON.stringify(Array.isArray(parsed) ? parsed.map(String) : [tags]);
    } catch {
      return JSON.stringify([tags]);
    }
  }
  return '[]';
}

function tagsFromJson(text) {
  if (typeof text !== 'string' || !text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map((t) => String(t)) : [];
  } catch {
    return [];
  }
}

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
    }
    throw err;
  }
}

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

export function openStore(path = DEFAULT_DB_PATH) {
  const file = String(path || DEFAULT_DB_PATH);

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

function writeSource(store, date, source, items) {
  if (!Array.isArray(items) || items.length === 0) return { inserted: 0, skipped: 0 };

  store.stmt.deleteDaySource.run(date, source);

  const stmt = store.stmt.insert;
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

export function listSnapshots(store, days = 7) {
  assertOpen(store);

  const raw = Number(days);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7;

  const dates = store.stmt.dates.all(n).map((row) => row.date);
  const byDate = {};
  const bySource = { rcmd: [], history: [], ranking: [] };
  const result = { days: n, dates, latest: dates.length ? dates[0] : null, byDate, bySource };

  if (dates.length === 0) return result;

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

export function closeStore(store) {
  if (!store) return;
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
