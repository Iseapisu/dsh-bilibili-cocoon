// Host half: reads cocoon.db and serves GET /dsh-bilibili-cocoon/summary.
// Read-only, never throws - a failing plugin takes the whole GUI down with it.

import os from 'node:os';
import path from 'node:path';

const ROUTE_PREFIX = '/dsh-bilibili-cocoon';

function defaultDbPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'im', 'bili-cocoon', 'data', 'cocoon.db');
}

export const inject = ['webServer'];

export function apply(ctx) {
  ctx.inject(['webServer'], (child) => {
    child.effect(
      () =>
        child.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: handleRoute,
        }),
      'bili-cocoon: summary api',
    );
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

async function handleRoute(req, res) {
  try {
    const pathname = String(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/\/+$/, '');
    if (pathname !== `${ROUTE_PREFIX}/summary`) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'GET only' });
      return;
    }
    sendJson(res, 200, await buildSummary());
  } catch (err) {
    try {
      sendJson(res, 200, { ok: false, error: String(err && err.message ? err.message : err) });
    } catch {
    }
  }
}

const pct = (n, total) => (total > 0 ? Number((n / total).toFixed(4)) : 0);

// ----------------------------------------------------------------------
// Tag evidence
// ----------------------------------------------------------------------

// video_tag.tags is a JSON array of strings. A malformed value degrades to an
// empty list rather than throwing: one bad row must not blind the whole panel.
function parseTags(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((tag) => typeof tag === 'string');
  } catch {
    return [];
  }
}

// Reads every known tag pair once per request. An older database without the
// video_tag table simply yields an empty map, which makes classifyTheme fall
// back to title + region only, i.e. exactly the pre-tag behaviour.
function loadTagMap(db) {
  const tagMap = new Map();
  try {
    const rows = db.prepare('SELECT bvid, tags FROM video_tag').all();
    for (const row of rows) {
      if (typeof row?.bvid !== 'string' || row.bvid === '') continue;
      tagMap.set(row.bvid, parseTags(row.tags));
    }
  } catch {
    // Missing table / unreadable column: treat the library as untagged.
  }
  return tagMap;
}

const tagsOf = (tagMap, bvid) => (tagMap ? tagMap.get(bvid) : undefined);

// Snapshot row -> cocoonScore item, with tag evidence joined in from video_tag.
// video_tag is keyed by bvid rather than by date, so one map serves every trend
// day. A bvid without a row gets an empty list, i.e. the pre-tag verdicts.
// Exported for tests: this is the seam where the host hands tag evidence to the
// metric layer.
export function trendItems(rows, tagMap) {
  return (rows ?? []).map((row) => ({ ...row, tags: tagsOf(tagMap, row.bvid) ?? [] }));
}

function topThemes(counts, total, themeName, limit = 5) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, n]) => ({ id, name: themeName(id), n, share: pct(n, total) }));
}

// ----------------------------------------------------------------------
// Theme stats
// ----------------------------------------------------------------------

function buildThemeStats(rows, themes, tagMap) {
  const counts = new Map();
  for (const r of rows) {
    const id = themes.classifyTheme(r.title, r.tname, tagsOf(tagMap, r.bvid));
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const unclassified = counts.get(themes.UNCLASSIFIED) ?? 0;
  const classified = rows.length - unclassified;
  const classifiedCounts = new Map([...counts].filter(([id]) => id !== themes.UNCLASSIFIED));
  return {
    count: rows.length,
    classified,
    coverage: pct(classified, rows.length),
    counts: classifiedCounts,
    top: topThemes(classifiedCounts, classified, themes.themeName),
  };
}

// ----------------------------------------------------------------------
// Amplification
// ----------------------------------------------------------------------

function buildAmplification(expoRows, history, themes, tagMap) {
  const loginRows = expoRows.filter((r) => r.kind === 'login');
  const login = buildThemeStats(loginRows, themes, tagMap);
  const guest = buildThemeStats(expoRows.filter((r) => r.kind === 'guest'), themes, tagMap);

  const historyShares = new Map(
    [...history.counts.entries()].map(([id, n]) => [id, pct(n, history.classified)]),
  );
  const ids = new Set([...login.counts.keys(), ...guest.counts.keys()]);
  const rows = [...ids]
    .map((id) => {
      const l = login.counts.get(id) ?? 0;
      const g = guest.counts.get(id) ?? 0;
      const loginShare = pct(l, login.classified);
      const guestShare = pct(g, guest.classified);
      return {
        id,
        name: themes.themeName(id),
        loginShare,
        guestShare,
        historyShare: historyShares.get(id) ?? 0,
        ratio: guestShare > 0 ? Number((loginShare / guestShare).toFixed(2)) : null,
      };
    })
    .filter((a) => a.loginShare > 0 || a.guestShare > 0)
    .sort((a, b) => (b.loginShare - b.guestShare) - (a.loginShare - a.guestShare));

  const head = rows.find((a) => a.ratio !== null && a.ratio > 1.2);
  return { loginRows, login, guest, amplification: rows, head };
}

// ----------------------------------------------------------------------
// Attribution
// ----------------------------------------------------------------------

const ATTRIBUTION_RATIO = 1.2;
const ATTRIBUTION_LIMIT = 3;
const DOMINANT_UP_SHARE = 0.3;

const formatShare = (share) => `${(Number(share) * 100).toFixed(1)}%`;
const formatRatio = (ratio) => Number(ratio).toFixed(2);
const formatUpShare = (share) => `${(Number(share) * 100).toFixed(0)}%`;

function uploaderKey(row) {
  if (row.mid !== null && row.mid !== undefined) return `mid:${row.mid}`;
  if (row.upName !== null && row.upName !== undefined && row.upName !== '') return `up:${row.upName}`;
  return null;
}

function repeatRateOf(repeats, appearances) {
  return appearances > 0 ? Number((repeats / appearances).toFixed(2)) : 0;
}

function buildAttribution(themes, amplification, loginRows, tagMap) {
  const targets = amplification
    .filter((a) => a.ratio !== null && a.ratio > ATTRIBUTION_RATIO)
    .slice(0, ATTRIBUTION_LIMIT);

  return targets.map((a) => {
    const rows = loginRows.filter(
      (r) => themes.classifyTheme(r.title, r.tname, tagsOf(tagMap, r.bvid)) === a.id,
    );
    const videos = new Map();
    const uploaders = new Map();

    for (const row of rows) {
      const video = videos.get(row.bvid) ?? {
        bvid: row.bvid,
        title: row.title ?? null,
        upName: row.upName ?? null,
        mid: row.mid ?? null,
        rounds: new Set(),
      };
      video.rounds.add(row.round);
      videos.set(row.bvid, video);

      const key = uploaderKey(row);
      if (!key) continue;
      const up = uploaders.get(key) ?? { mid: row.mid ?? null, name: row.upName ?? null, n: 0 };
      up.n += 1;
      if (up.name === null && row.upName) up.name = row.upName;
      if (up.mid === null && row.mid !== null && row.mid !== undefined) up.mid = row.mid;
      uploaders.set(key, up);
    }

    const appearances = rows.length;
    const uniqueBvids = videos.size;
    const topUps = [...uploaders.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, ATTRIBUTION_LIMIT)
      .map((up) => ({ mid: up.mid, name: up.name, n: up.n, share: pct(up.n, appearances) }));

    const topVideos = [...videos.values()]
      .map((video) => ({ video, upN: uploaders.get(uploaderKey(video))?.n ?? 0 }))
      .sort((a, b) => b.video.rounds.size - a.video.rounds.size || b.upN - a.upN)
      .slice(0, ATTRIBUTION_LIMIT)
      .map(({ video }) => ({
        bvid: video.bvid,
        title: video.title,
        upName: video.upName,
        mid: video.mid,
        rounds: video.rounds.size,
        url: `https://www.bilibili.com/video/${video.bvid}`,
      }));

    return {
      id: a.id,
      name: a.name,
      ratio: a.ratio,
      loginShare: a.loginShare,
      guestShare: a.guestShare,
      appearances,
      uniqueBvids,
      repeatRate: repeatRateOf(appearances - uniqueBvids, appearances),
      topUps,
      topVideos,
    };
  });
}

function buildAdvice(attribution, headlineId) {
  if (!attribution.length) return null;
  // Prefer the headline theme so badge and advice never disagree; fall back to
  // the highest ratio when the headline is absent or not attributed.
  const top =
    attribution.find((a) => a.id === headlineId) ??
    attribution.reduce((best, cur) => (cur.ratio > best.ratio ? cur : best), attribution[0]);
  const lead = top.topUps[0];
  const head = `${top.name} 占你首页 ${formatShare(top.loginShare)}，是游客基线的 ${formatRatio(top.ratio)} 倍。`;

  if (lead && lead.share >= DOMINANT_UP_SHARE) {
    const who = lead.name ?? (lead.mid === null || lead.mid === undefined ? null : `mid ${lead.mid}`);
    if (who) {
      const repeats = top.appearances - top.uniqueBvids;
      const tail = repeats > 0 ? `，重复曝光 ${repeats} 次` : '';
      return {
        theme: top.id,
        name: top.name,
        ratio: top.ratio,
        kind: 'narrow',
        text: `${head}其中 ${formatUpShare(lead.share)} 来自同一 UP 主「${who}」${tail} —— 想收窄，先别点这类封面。`,
      };
    }
  }

  return {
    theme: top.id,
    name: top.name,
    ratio: top.ratio,
    kind: 'watch',
    text: `${head}没有单一 UP 主主导，是题材层面的放大 —— 想换口味，主动搜点别的内容。`,
  };
}

// ----------------------------------------------------------------------
// Weekly trend
// ----------------------------------------------------------------------

const TREND_DAYS = 7;

// Date-only arithmetic on YYYY-MM-DD strings; UTC keeps it free of the
// machine timezone, and comparison stays a plain string compare.
function shiftDate(date, delta) {
  const [y, m, d] = date.split('-').map((n) => Number(n));
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

const oneDecimal = (n) => (Number.isFinite(n) ? Number(Number(n).toFixed(1)) : null);

// One day of trend data. Each metric degrades to null on its own so a single
// bad day (or a throwing call) never removes the point from the line.
function trendPoint(db, date, themes, cocoon, tagMap) {
  const point = { date, cocoon: null, amplification: null, themes: null, samples: 0 };
  const snap = { feed: [], history: [], ranking: [] };

  try {
    const rows = db
      .prepare('SELECT source, bvid, tid, tname, mid, upName, title FROM snapshot WHERE date = ?')
      .all(date);
    for (const row of trendItems(rows, tagMap)) {
      const bucket = snap[row.source];
      if (Array.isArray(bucket)) bucket.push(row);
    }
  } catch {
    // Unreadable snapshot day: leave the cocoon point at null.
  }

  const hasSnapshot = snap.feed.length > 0 || snap.history.length > 0 || snap.ranking.length > 0;
  let sampleSize = null;
  if (hasSnapshot && typeof cocoon === 'function') {
    try {
      // Same input shape as tools/trend.mjs: stored rcmd/history/ranking rows,
      // now carrying the tag evidence joined from video_tag.
      const score = cocoon({ ...snap, date }, { date });
      const index = oneDecimal(score?.index);
      const size = Number(score?.sampleSize);
      // cocoonScore returns index 0 with an empty sample; treat that as no data
      // rather than drawing a misleading "wide open" point.
      if (index !== null && size > 0) {
        point.cocoon = index;
        sampleSize = size;
      }
    } catch {
      point.cocoon = null;
      sampleSize = null;
    }
  }

  let expoRows = [];
  try {
    expoRows = db
      .prepare('SELECT kind, round, bvid, tid, tname, mid, upName, title FROM exposure WHERE date = ?')
      .all(date);
  } catch {
    expoRows = [];
  }
  const loginRows = expoRows.filter((r) => r.kind === 'login');

  if (expoRows.length) {
    try {
      const history = buildThemeStats(snap.history, themes, tagMap);
      const { head } = buildAmplification(expoRows, history, themes, tagMap);
      point.amplification = head && Number.isFinite(head.ratio) ? head.ratio : null;
    } catch {
      point.amplification = null;
    }

    try {
      const ids = new Set();
      for (const row of loginRows) {
        const id = themes.classifyTheme(row.title, row.tname, tagsOf(tagMap, row.bvid));
        if (id !== themes.UNCLASSIFIED) ids.add(id);
      }
      point.themes = loginRows.length ? ids.size : null;
    } catch {
      point.themes = null;
    }
  }

  // samples: rows behind the cocoon score (history first, rcmd when history is
  // thin). Without a snapshot, fall back to the login exposure row count.
  point.samples = sampleSize !== null ? sampleSize : loginRows.length;
  return point;
}

function buildTrend(db, latestDate, themes, cocoon, tagMap) {
  const since = shiftDate(latestDate, -(TREND_DAYS - 1));
  const dates = new Set();
  for (const table of ['snapshot', 'exposure']) {
    try {
      const rows = db
        .prepare(`SELECT DISTINCT date FROM ${table} WHERE date >= ? AND date <= ?`)
        .all(since, latestDate);
      for (const row of rows) dates.add(row.date);
    } catch {
      // A missing table just means that source contributes no days.
    }
  }

  const points = [...dates].sort().map((date) => trendPoint(db, date, themes, cocoon, tagMap));
  return { days: TREND_DAYS, covered: points.length, points };
}

export async function buildSummary(dbPath = process.env.COCOON_DB || defaultDbPath()) {
  let themes;
  try {
    themes = await import('../../src/themes.js');
  } catch (err) {
    return { ok: false, error: `核心模块加载失败: ${err.message}`, dbPath };
  }

  // Trend only needs the score function; if metrics.js is missing the trend
  // line loses its cocoon values but the rest of the summary still works.
  let cocoon = null;
  try {
    cocoon = (await import('../../src/metrics.js')).cocoonScore;
  } catch {
    cocoon = null;
  }

  let sqlite;
  try {
    ({ DatabaseSync: sqlite } = await import('node:sqlite'));
  } catch (err) {
    return { ok: false, error: `node:sqlite 不可用: ${err.message}`, dbPath };
  }

  let db;
  try {
    db = new sqlite(dbPath, { readOnly: true });
  } catch (err) {
    return { ok: false, error: `打不开数据库: ${err.message}`, dbPath };
  }

  try {
    const tagMap = loadTagMap(db);

    const dates = db
      .prepare("SELECT DISTINCT date FROM exposure ORDER BY date DESC LIMIT 30")
      .all()
      .map((r) => r.date);
    if (!dates.length) {
      return { ok: false, error: 'exposure 表还没有数据，先跑 node tools/exposure-login.mjs', dbPath };
    }
    const date = dates[0];

    const expoRows = db
      .prepare('SELECT kind, round, bvid, tid, tname, mid, upName, title FROM exposure WHERE date = ?')
      .all(date);
    const historyRows = db
      .prepare("SELECT bvid, title, tname, upName FROM snapshot WHERE date = ? AND source = 'history'")
      .all(date);

    const history = buildThemeStats(historyRows, themes, tagMap);
    const { loginRows, login, guest, amplification, head } = buildAmplification(
      expoRows,
      history,
      themes,
      tagMap,
    );

    let attribution = [];
    let advice = null;
    let attributionError = null;
    try {
      attribution = buildAttribution(themes, amplification, loginRows, tagMap);
      advice = buildAdvice(attribution, head?.id);
    } catch (err) {
      // Attribution is an enhancement; a failure here must not hide the panel.
      attribution = [];
      advice = null;
      attributionError = String(err && err.message ? err.message : err);
    }

    const headline = head ? { id: head.id, name: head.name, ratio: head.ratio } : null;

    let trend;
    let trendError = null;
    try {
      // The window ends at the newest day the database knows about, which can
      // be newer than the exposure day this summary is built from.
      const latest = db
        .prepare('SELECT MAX(date) AS d FROM (SELECT date FROM snapshot UNION ALL SELECT date FROM exposure)')
        .get()?.d;
      const latestDate = typeof latest === 'string' && latest > date ? latest : date;
      trend = buildTrend(db, latestDate, themes, cocoon, tagMap);
    } catch (err) {
      // Trend is an enhancement; a failure here must not hide the panel.
      trend = { days: TREND_DAYS, covered: 0, points: [] };
      trendError = String(err && err.message ? err.message : err);
    }

    return {
      ok: true,
      date,
      dbPath,
      rounds: new Set(expoRows.map((r) => r.round)).size,
      login: { count: login.count, coverage: login.coverage, top: login.top },
      guest: { count: guest.count, coverage: guest.coverage, top: guest.top },
      history: { count: history.count, coverage: history.coverage, top: history.top },
      amplification: amplification.slice(0, 6),
      headline,
      attribution,
      advice,
      trend,
      ...(attributionError === null ? {} : { attributionError }),
      ...(trendError === null ? {} : { trendError }),
    };
  } catch (err) {
    return { ok: false, error: `汇总失败: ${err.message}`, dbPath };
  } finally {
    try {
      db.close();
    } catch {
    }
  }
}
