// SQLite persistence: daily snapshots, multi-round exposure samples, and the
// per-video tag backfill table.

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

-- 视频真实 tag（来自 x/tag/archive/tags），作为标题关键词、二级分区之后的
-- 第三级分类证据。独立成表而不是塞进 snapshot/exposure：tag 是按 bvid 的
-- 静态属性，回填一次即可复用，与采集日期和曝光轮次都无关。
-- tags/tag_ids 都是 JSON 数组，写入前已去重并按 tag_name 字典序排序，
-- 因为接口返回的 tag 集合稳定但顺序会抖动，不排序会导致每次回填结果不同。
-- last_error 为 NULL 表示这一条抓取成功（tags 可能是空数组，表示该视频
-- 确实没有 tag）；非 NULL 表示上次抓取失败，重跑时应重试。
CREATE TABLE IF NOT EXISTS video_tag(
  bvid TEXT PRIMARY KEY,
  tags TEXT NOT NULL,
  tag_ids TEXT,
  fetched_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT
);
`;

const VIDEO_TAG_COLUMNS = 'bvid, tags, tag_ids, fetched_at, attempts, last_error';

// A failed fetch must never wipe a previous success, so on error the stored
// tags/tag_ids are kept and only the bookkeeping columns move. A brand new row
// written with an error gets an empty tag list, which is what countVideoTags
// and the backfill script expect.
const UPSERT_VIDEO_TAG_SQL = `
INSERT INTO video_tag(bvid, tags, tag_ids, fetched_at, attempts, last_error)
VALUES (?, ?, ?, ?, 1, ?)
ON CONFLICT(bvid) DO UPDATE SET
  attempts = video_tag.attempts + 1,
  fetched_at = excluded.fetched_at,
  last_error = excluded.last_error,
  tags = CASE WHEN excluded.last_error IS NULL THEN excluded.tags ELSE video_tag.tags END,
  tag_ids = CASE WHEN excluded.last_error IS NULL THEN excluded.tag_ids ELSE video_tag.tag_ids END
`;

const COLUMNS = 'date, source, bvid, tid, tname, mid, upName, title, rcmdReason, tags, view, pubdate';

const INSERT_SQL = `
INSERT OR REPLACE INTO snapshot
  (date, source, bvid, tid, tname, mid, upName, title, rcmdReason, tags, view, pubdate)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

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

function tagIdsFromJson(text) {
  if (typeof text !== 'string' || !text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : null));
  } catch {
    return [];
  }
}

// Normalize the caller's { tags, tagIds } into sorted, deduped pairs so the
// stored JSON is byte-identical for identical tag sets regardless of the order
// the API returned them in.
function tagPairs(tags, tagIds) {
  const names = Array.isArray(tags) ? tags : [];
  const ids = Array.isArray(tagIds) ? tagIds : [];
  const seen = new Set();
  const pairs = [];
  for (let i = 0; i < names.length; i += 1) {
    const raw = toText(names[i]);
    const name = raw === null ? '' : raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const idRaw = ids[i];
    const id = idRaw === null || idRaw === undefined || idRaw === '' ? null : Number(idRaw);
    pairs.push({ name, id: Number.isFinite(id) ? Math.trunc(id) : null });
  }
  pairs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return pairs;
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

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

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
      upsertVideoTag: db.prepare(UPSERT_VIDEO_TAG_SQL),
      getVideoTag: db.prepare(`SELECT ${VIDEO_TAG_COLUMNS} FROM video_tag WHERE bvid = ?`),
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

// ----------------------------------------------------------------------
// video_tag: real B站 tags per video, used as third-tier classification
// evidence. Kept independent of date/source, so one row per bvid.
// ----------------------------------------------------------------------

// Upsert one video's tags. Pass `error` (string or Error) to record a failed
// attempt instead: a previous success keeps its tags, attempts still grows.
export function saveVideoTags(store, bvid, { tags = [], tagIds = [] } = {}, error = null) {
  assertOpen(store);
  const key = toText(bvid);
  if (!key) throw new TypeError('saveVideoTags: bvid 不能为空');

  const errText = error === null || error === undefined || error === '' ? null : String(error?.message ?? error);
  const ok = errText === null;
  const pairs = ok ? tagPairs(tags, tagIds) : [];

  store.stmt.upsertVideoTag.run(
    key,
    JSON.stringify(pairs.map((p) => p.name)),
    JSON.stringify(pairs.map((p) => p.id)),
    Date.now(),
    errText,
  );

  // Read back instead of assuming: on a failed upsert the stored tags are the
  // previous ones, and the caller (and the tests) should see that truth.
  const row = store.stmt.getVideoTag.get(key);
  return {
    bvid: key,
    ok,
    tags: tagsFromJson(row?.tags),
    tagIds: tagIdsFromJson(row?.tag_ids),
    attempts: row?.attempts ?? 1,
    fetchedAt: row?.fetched_at ?? null,
    lastError: row?.last_error ?? null,
  };
}

// Batch read for the classification layer. Returns Map<bvid, entry> where
// entry is { bvid, tags, tagIds, fetchedAt, attempts, lastError }; missing
// bvids are simply absent. Pass no bvids to load the whole table.
export function listVideoTags(store, bvids = null) {
  assertOpen(store);

  const pick = (row) => ({
    bvid: row.bvid,
    tags: tagsFromJson(row.tags),
    tagIds: tagIdsFromJson(row.tag_ids),
    fetchedAt: row.fetched_at ?? null,
    attempts: row.attempts ?? 0,
    lastError: row.last_error ?? null,
  });

  if (bvids === null || bvids === undefined) {
    const rows = store.db.prepare(`SELECT ${VIDEO_TAG_COLUMNS} FROM video_tag ORDER BY bvid ASC`).all();
    const out = new Map();
    for (const row of rows) out.set(row.bvid, pick(row));
    return out;
  }

  const list = Array.isArray(bvids) ? bvids : [bvids];
  const keys = [...new Set(list.map((b) => toText(b)).filter(Boolean))];
  if (keys.length === 0) return new Map();

  // SQLite caps bound parameters, so chunk the IN list.
  const CHUNK = 400;
  const found = new Map();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const marks = chunk.map(() => '?').join(', ');
    const rows = store.db
      .prepare(`SELECT ${VIDEO_TAG_COLUMNS} FROM video_tag WHERE bvid IN (${marks})`)
      .all(...chunk);
    for (const row of rows) found.set(row.bvid, pick(row));
  }

  // Keep the caller's order so callers can zip this against their own list.
  const out = new Map();
  for (const key of keys) {
    const entry = found.get(key);
    if (entry) out.set(key, entry);
  }
  return out;
}

// Backfill bookkeeping: total rows, successes (last_error IS NULL), failures,
// and successes whose tag list came back empty.
export function countVideoTags(store) {
  assertOpen(store);
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN last_error IS NULL THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN last_error IS NULL AND tags = '[]' THEN 1 ELSE 0 END) AS empty
       FROM video_tag`,
    )
    .get();
  const n = (v) => (v === null || v === undefined ? 0 : Number(v));
  return { total: n(row?.total), ok: n(row?.ok), failed: n(row?.failed), empty: n(row?.empty) };
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
  saveVideoTags,
  listVideoTags,
  countVideoTags,
  closeStore,
  DEFAULT_DB_PATH,
  SOURCES,
};
