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

// Reads the per-tag theme verdicts once per request: Map<lowercased tag, theme
// id>. Same degradation rule as loadTagMap - an older database without the
// tag_theme table yields an empty map, and classifyTheme then falls back to the
// lexicon, i.e. exactly the pre-table behaviour. Never throws.
function loadTagThemeMap(db) {
  const themeMap = new Map();
  try {
    for (const row of db.prepare('SELECT tag, theme FROM tag_theme').all()) {
      if (typeof row?.tag !== 'string' || row.tag === '') continue;
      if (typeof row?.theme !== 'string' || row.theme === '') continue;
      themeMap.set(row.tag.trim().toLowerCase(), row.theme);
    }
  } catch {
    // Missing table / unreadable column: let the lexicon answer.
  }
  return themeMap;
}

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

function buildThemeStats(rows, themes, tagMap, themeMap) {
  const counts = new Map();
  const verdicts = [];
  for (const r of rows) {
    const id = themes.classifyTheme(r.title, r.tname, tagsOf(tagMap, r.bvid), themeMap);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    verdicts.push({ bvid: r.bvid, id });
  }
  const unclassified = counts.get(themes.UNCLASSIFIED) ?? 0;
  const classified = rows.length - unclassified;
  const classifiedCounts = new Map([...counts].filter(([id]) => id !== themes.UNCLASSIFIED));

  // Dedup measure: one unit per distinct bvid, first row wins. The guest feed is
  // resampled from a much smaller pool than the login feed (2026-11-02: 84 login
  // rows = 84 videos, 82 guest rows = 38 videos), so counting rows dilutes the
  // guest baseline and inflates every ratio built on it. A row without a bvid
  // cannot be recognised as a repeat, so it stays its own unit.
  const seen = new Set();
  const dedupCounts = new Map();
  for (const { bvid, id } of verdicts) {
    if (bvid) {
      if (seen.has(bvid)) continue;
      seen.add(bvid);
    }
    dedupCounts.set(id, (dedupCounts.get(id) ?? 0) + 1);
  }
  const dedupUnclassified = dedupCounts.get(themes.UNCLASSIFIED) ?? 0;
  const dedupCount = [...dedupCounts.values()].reduce((a, b) => a + b, 0);
  const dedupClassified = dedupCount - dedupUnclassified;
  const dedupClassifiedCounts = new Map(
    [...dedupCounts].filter(([id]) => id !== themes.UNCLASSIFIED),
  );

  return {
    count: rows.length,
    classified,
    coverage: pct(classified, rows.length),
    counts: classifiedCounts,
    top: topThemes(classifiedCounts, classified, themes.themeName),
    dedup: {
      count: dedupCount,
      classified: dedupClassified,
      coverage: pct(dedupClassified, dedupCount),
      counts: dedupClassifiedCounts,
      top: topThemes(dedupClassifiedCounts, dedupClassified, themes.themeName),
    },
  };
}

// ----------------------------------------------------------------------
// Amplification
// ----------------------------------------------------------------------

function buildAmplification(expoRows, history, themes, tagMap, themeMap) {
  const loginRows = expoRows.filter((r) => r.kind === 'login');
  const login = buildThemeStats(loginRows, themes, tagMap, themeMap);
  const guest = buildThemeStats(expoRows.filter((r) => r.kind === 'guest'), themes, tagMap, themeMap);

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
      // Same quantity on the dedup measure: distinct videos, not sampled rows.
      // Both are reported - the row ratio is what earlier numbers were built on,
      // the dedup ratio is the one that is not polluted by guest resampling.
      const loginShareDedup = pct(login.dedup.counts.get(id) ?? 0, login.dedup.classified);
      const guestShareDedup = pct(guest.dedup.counts.get(id) ?? 0, guest.dedup.classified);
      return {
        id,
        name: themes.themeName(id),
        loginShare,
        guestShare,
        loginShareDedup,
        guestShareDedup,
        historyShare: historyShares.get(id) ?? 0,
        ratio: guestShare > 0 ? Number((loginShare / guestShare).toFixed(2)) : null,
        ratioDedup:
          guestShareDedup > 0 ? Number((loginShareDedup / guestShareDedup).toFixed(2)) : null,
      };
    })
    .filter((a) => a.loginShare > 0 || a.guestShare > 0)
    .sort((a, b) => (b.loginShare - b.guestShare) - (a.loginShare - a.guestShare));

  const head = rows.find((a) => a.ratio !== null && a.ratio > 1.2);
  return { loginRows, login, guest, amplification: rows, head };
}

// ----------------------------------------------------------------------
// Feed focus
// ----------------------------------------------------------------------

// exp(Shannon entropy) over classified theme counts: "how many themes does this
// feed effectively contain". Ten themes at equal share gives 10, one theme 1.
function themeEntropy(counts) {
  let total = 0;
  for (const n of counts.values()) total += n;
  if (total <= 0) return 0;
  let h = 0;
  for (const n of counts.values()) {
    const p = n / total;
    if (p > 0) h -= p * Math.log(p);
  }
  return h;
}

// Size of the theme vocabulary, from the themes module rather than from the data:
// a feed that only hits 4 themes has still been measured against all of them.
function themeVocabularySize(themes) {
  if (Array.isArray(themes?.THEMES)) return themes.THEMES.length;
  if (themes?.THEME_NAMES instanceof Map) return Math.max(0, themes.THEME_NAMES.size - 1);
  return null;
}

// The home-feed block: what the login feed is made of. The two shares in `top`
// are on the dedup measure - one unit per distinct video - i.e. the same measure
// as `ratioDedup`, because the guest feed is resampled from a much smaller pool:
// a row share next to a dedup ratio reads as a contradiction (24.4% over 9.4% is
// 2.6x, yet the same screen labels it 1.83x). `baselineShareRows` keeps the row
// baseline for diagnostics only; never divide the dedup ratio by it.
// `top3Share` is still the row sum: it is a breadth figure next to a table of
// shares, not a multiple, so it cannot contradict `ratioDedup`; it is the one
// field here that stays on the row measure for comparability with the older
// reports. Effective theme count is taken over dedup counts on purpose: counting
// one video once per re-sample would move it without the feed having changed.
function buildFeedFocus(login, guest, themes, amplification) {
  const ranked = [...amplification].sort((a, b) => b.loginShare - a.loginShare);
  const lead = ranked[0] ?? null;
  if (!lead || lead.loginShare <= 0) return null;

  return {
    top: {
      id: lead.id,
      name: lead.name,
      // Row shares are the fallback only for a caller that hands over rows built
      // before the dedup measure existed; both fields then agree with each other.
      share: lead.loginShareDedup ?? lead.loginShare,
      baselineShare: lead.guestShareDedup ?? lead.guestShare,
      baselineShareRows: lead.guestShare,
      ratio: lead.ratio,
      ratioDedup: lead.ratioDedup,
    },
    top3Share: Number(ranked.slice(0, 3).reduce((sum, a) => sum + a.loginShare, 0).toFixed(4)),
    effectiveThemes: Number(Math.exp(themeEntropy(login.dedup.counts)).toFixed(2)),
    totalThemes: themeVocabularySize(themes),
    units: { login: login.dedup.count, guest: guest.dedup.count },
    repeatRate: {
      login: repeatRateOf(login.count - login.dedup.count, login.count),
      guest: repeatRateOf(guest.count - guest.dedup.count, guest.count),
    },
  };
}

// ----------------------------------------------------------------------
// Partition mix
// ----------------------------------------------------------------------

// What the home feed is made of, partition by partition. The panel draws this as
// a pie: a share of a circle needs no definition, whereas the 0-100 composite
// index needed three paragraphs of formula and still read as a machine score.
// `covered` against `total` is the second half of the answer - how much of the
// site's 19 top-level partitions this feed reaches at all.
function buildCategories(loginRows, metrics) {
  if (!metrics || typeof metrics.categoryCounts !== 'function') return null;
  const counts = metrics.categoryCounts(loginRows);
  const pairs = [...counts.entries()]
    .filter(([name, n]) => typeof name === 'string' && name !== '' && n > 0)
    .sort((a, b) => b[1] - a[1]);
  const units = pairs.reduce((sum, [, n]) => sum + n, 0);
  if (!units) return null;

  return {
    covered: pairs.length,
    total: metrics.MAX_CATEGORIES ?? 19,
    units,
    items: pairs.map(([name, n]) => ({ name, n, share: pct(n, units) })),
  };
}

// ----------------------------------------------------------------------
// Breakout picks
// ----------------------------------------------------------------------

const BREAKOUT_LIMIT = 5;

// Videos the guest feed saw and the home feed never did. A theme has to clear one
// necessary condition to be picked at all: gap = guestShare - loginShare > 0,
// i.e. the guest baseline really does carry the theme more than the home feed
// does. 知识科普 was 6.7% for the guest and 8.5% at home on 2026-11-02, so home
// already shows it more, nothing is held back, and no row is emitted for it.
//
// Picks are then ordered by loginShare ascending: the smallest share of the home
// feed first. The semantic this block serves is "content you can basically or
// completely not reach", and that is an absolute exposure figure, not a relative
// difference. The 2026-11-02 data says why: 影视动漫 held 14.6% of the home feed
// against 20% of the guest sample - a +5.4pp gap, wider than music's +2.1pp - but
// at 14.6% the user already sees plenty of it. It can be a pick (gap is positive)
// yet it sorts last; ranking by gap descending put it second, which is exactly
// the mistake this order fixes. Music at 1.2% of home is the theme the user most
// plausibly never encounters, so it goes first even though its gap is small.
// `gap` is still carried on every item as a diagnostic quantity - it is what
// separates "you don't care" from "it is there and being filtered out" - but it
// is no longer the sort key.
//
// Ties on loginShare fall back to the larger gap, then to guest-row order (seq)
// so the list is stable between runs. `upSeen` stays a reported field, not a sort
// key: it describes one uploader, while the ranking is about themes.
//
// A gap of 0 or less drops the theme, which can leave the list shorter than
// BREAKOUT_LIMIT: a short list is the honest answer. Padding it up to five with
// zero-gap themes would turn "break out of the cocoon" into "random
// recommendation".
//
// Two collapse rules, both because a list of five rows has to say five things:
// - one video per theme. Without it the low-share end of the feed fills the
//   list with itself and the block restates one number five times.
// - one video per uploader. 37 guest-only videos had 37 distinct uploaders on
//   the measurement day, so this changes nothing today; it is here for the day
//   a single UP floods the guest sample.
//
// `db` and `date` are in the signature to match the other builders, but this
// block needs no query: every row, tag and verdict it reads is handed in.
// Read-only, and total - any failure returns the empty block, never a throw.
export function buildBreakout(db, options = {}) {
  const empty = { candidates: 0, items: [] };
  const { loginRows, guestRows, tagMap, themeMap, themes } = options ?? {};

  try {
    if (!Array.isArray(loginRows) || !Array.isArray(guestRows)) return empty;
    if (!loginRows.length || !guestRows.length) return empty;
    if (!themes || typeof themes.classifyTheme !== 'function') return empty;

    // Both sides go through the same dedup measure as `feedFocus` and the theme
    // table, so the shares quoted here are the ones the panel already shows
    // (2026-11-02: 搞笑整活 is 4.9% at home and 16.7% for the guest). A different
    // denominator here would put two answers to one question on one screen.
    const login = buildThemeStats(loginRows, themes, tagMap, themeMap);
    const guest = buildThemeStats(guestRows, themes, tagMap, themeMap);
    // Without a single classified video at home there is no share to rank against,
    // so nothing can be said. A guest side with no classified video is different:
    // every candidate then falls out as unclassified and the count stays true.
    if (!(login.dedup.classified > 0)) return empty;

    const unclassified = themes.UNCLASSIFIED ?? 'unclassified';

    const loginBvids = new Set();
    const loginUps = new Set();
    for (const row of loginRows) {
      if (typeof row?.bvid === 'string' && row.bvid !== '') loginBvids.add(row.bvid);
      const key = uploaderKey(row);
      if (key !== null) loginUps.add(key);
    }

    // One unit per distinct video, first guest row wins: the guest sample re-uses
    // a much smaller pool (82 rows over 38 videos), and one video appearing five
    // times must not look like five candidates. A row without a bvid cannot be
    // linked to, so it is not a candidate.
    const candidates = new Map();
    for (const row of guestRows) {
      const bvid = typeof row?.bvid === 'string' ? row.bvid : '';
      if (bvid === '' || loginBvids.has(bvid)) continue;
      if (!candidates.has(bvid)) candidates.set(bvid, row);
    }

    const scored = [];
    let seq = 0;
    for (const row of candidates.values()) {
      const theme = themes.classifyTheme(row.title, row.tname, tagsOf(tagMap, row.bvid), themeMap);
      // Unclassified is dropped from the picks but stays in `candidates`: the
      // count answers "how many videos did the guest see that you did not", and
      // that is true whether or not a theme could be named for each one. An
      // unclassified row cannot explain why it was pushed, so it is not a pick.
      if (theme === unclassified) continue;
      const key = uploaderKey(row);
      // Same quantity as amplification's loginShareDedup / guestShareDedup.
      const loginShare = pct(login.dedup.counts.get(theme) ?? 0, login.dedup.classified);
      const guestShare = pct(guest.dedup.counts.get(theme) ?? 0, guest.dedup.classified);
      // Both shares are already rounded to 4 decimals, so their difference is a
      // multiple of 1e-4; rounding once more only strips float noise such as
      // 0.13890000000000001, which keeps `gap === guestShare - loginShare` exact
      // enough for the front end to re-derive and for a test to compare.
      const gap = Number((guestShare - loginShare).toFixed(4));
      // Not suppressed: the guest baseline carries this theme no more than the
      // home feed does, so recommending it would not open anything up. The row is
      // dropped, which is why the list may be shorter than BREAKOUT_LIMIT.
      if (gap <= 0) continue;
      scored.push({
        row,
        theme,
        upKey: key,
        loginShare,
        guestShare,
        gap,
        // An uploader identity that is missing cannot be matched against the
        // home feed, so it is not evidence of having been shown there.
        upSeen: key === null ? false : loginUps.has(key),
        seq: seq++,
      });
    }

    // Login share ascending: the theme the home feed carries least of is the one
    // the user is least able to reach, which is what this block promises - an
    // absolute exposure figure, not the relative gap. Equal home shares fall back
    // to the larger gap (more genuinely held back), then to guest-row order so
    // the list is stable between runs. `upSeen` stays a reported field, not a
    // sort key: it describes one uploader, while the ranking is about themes.
    scored.sort((a, b) => a.loginShare - b.loginShare || b.gap - a.gap || a.seq - b.seq);

    const usedThemes = new Set();
    const usedUps = new Set();
    const items = [];
    for (const cand of scored) {
      if (items.length >= BREAKOUT_LIMIT) break;
      if (usedThemes.has(cand.theme)) continue;
      if (cand.upKey !== null && usedUps.has(cand.upKey)) continue;
      usedThemes.add(cand.theme);
      if (cand.upKey !== null) usedUps.add(cand.upKey);

      const row = cand.row;
      items.push({
        bvid: row.bvid,
        title: typeof row.title === 'string' && row.title !== '' ? row.title : null,
        upName: typeof row.upName === 'string' && row.upName !== '' ? row.upName : null,
        mid: row.mid === undefined ? null : row.mid,
        url: `https://www.bilibili.com/video/${row.bvid}`,
        theme: cand.theme,
        themeName: themes.themeName(cand.theme),
        loginShare: cand.loginShare,
        guestShare: cand.guestShare,
        // guestShare - loginShare, 4 decimals: a diagnostic, not the sort key -
        // the ranking is loginShare ascending. Kept on every row so "why is this
        // here at all" (gap > 0) can be audited from the JSON next to "how little
        // you see it" (loginShare). The client does not read it yet.
        gap: cand.gap,
        upSeen: cand.upSeen,
      });
    }

    return { candidates: candidates.size, items };
  } catch {
    return { candidates: 0, items: [] };
  }
}

// ----------------------------------------------------------------------
// Attribution
// ----------------------------------------------------------------------

const ATTRIBUTION_RATIO = 1.2;
const ATTRIBUTION_LIMIT = 3;

function uploaderKey(row) {
  if (row.mid !== null && row.mid !== undefined) return `mid:${row.mid}`;
  if (row.upName !== null && row.upName !== undefined && row.upName !== '') return `up:${row.upName}`;
  return null;
}

function repeatRateOf(repeats, appearances) {
  return appearances > 0 ? Number((repeats / appearances).toFixed(2)) : 0;
}

function buildAttribution(themes, amplification, loginRows, tagMap, themeMap) {
  const targets = amplification
    .filter((a) => a.ratio !== null && a.ratio > ATTRIBUTION_RATIO)
    .slice(0, ATTRIBUTION_LIMIT);

  return targets.map((a) => {
    const rows = loginRows.filter(
      (r) => themes.classifyTheme(r.title, r.tname, tagsOf(tagMap, r.bvid), themeMap) === a.id,
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
      // Same multiple on the dedup measure the badge quotes, so a reader comparing
      // the two never sees 1.83x next to 2.60x for the same pair of shares. Null
      // when the guest baseline has no distinct video in this theme.
      ratioDedup: a.ratioDedup,
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
function trendPoint(db, date, themes, cocoon, tagMap, themeMap) {
  // `basis` says which sample the cocoon number came from ('history' once the day
  // has at least 10 history rows, otherwise 'feed'). The number is meaningless
  // without it: the same formula scores the history sample and the home feed
  // differently by several points, so the front end has to label the point.
  const point = { date, cocoon: null, amplification: null, themes: null, samples: 0, basis: null };
  const snap = { feed: [], history: [], ranking: [] };

  try {
    const rows = db
      .prepare('SELECT source, bvid, tid, tname, mid, upName, title FROM snapshot WHERE date = ?')
      .all(date);
    for (const row of trendItems(rows, tagMap)) {
      // snapshot stores the home feed under source 'rcmd'; the analyser calls it
      // 'feed'. Bucketing on the raw source silently dropped every feed row, so a
      // day with 28 rcmd rows and thin history scored as "no data" and no point
      // could ever be feed-based. Alias it instead of renaming the stored value:
      // existing databases keep working.
      const bucketKey = row.source === 'rcmd' ? 'feed' : row.source;
      const bucket = snap[bucketKey];
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
        point.basis = score?.basis === 'feed' ? 'feed' : 'history';
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
      const history = buildThemeStats(snap.history, themes, tagMap, themeMap);
      const { head } = buildAmplification(expoRows, history, themes, tagMap, themeMap);
      point.amplification = head && Number.isFinite(head.ratio) ? head.ratio : null;
    } catch {
      point.amplification = null;
    }

    try {
      const ids = new Set();
      for (const row of loginRows) {
        const id = themes.classifyTheme(row.title, row.tname, tagsOf(tagMap, row.bvid), themeMap);
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

function buildTrend(db, latestDate, themes, cocoon, tagMap, themeMap) {
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

  const points = [...dates].sort().map((date) => trendPoint(db, date, themes, cocoon, tagMap, themeMap));
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
  // line loses its cocoon values but the rest of the summary still works. The
  // partition mix below reuses the same module's categoryCounts.
  let cocoon = null;
  let metricsApi = null;
  try {
    metricsApi = await import('../../src/metrics.js');
    cocoon = metricsApi.cocoonScore;
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
    const themeMap = loadTagThemeMap(db);

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

    const history = buildThemeStats(historyRows, themes, tagMap, themeMap);
    const { loginRows, login, guest, amplification, head } = buildAmplification(
      expoRows,
      history,
      themes,
      tagMap,
      themeMap,
    );

    let attribution = [];
    let attributionError = null;
    try {
      attribution = buildAttribution(themes, amplification, loginRows, tagMap, themeMap);
    } catch (err) {
      // Attribution is an enhancement; a failure here must not hide the panel.
      attribution = [];
      attributionError = String(err && err.message ? err.message : err);
    }

    const headline = head
      ? { id: head.id, name: head.name, ratio: head.ratio, ratioDedup: head.ratioDedup }
      : null;

    // Home-feed composition block. An enhancement like attribution: if it cannot
    // be built, the panel keeps every other field instead of going dark.
    let feedFocus = null;
    let feedFocusError = null;
    try {
      feedFocus = buildFeedFocus(login, guest, themes, amplification);
    } catch (err) {
      feedFocus = null;
      feedFocusError = String(err && err.message ? err.message : err);
    }

    // The partition pie. Same contract as the other enhancements: missing block
    // instead of a dark panel.
    let categories = null;
    let categoriesError = null;
    try {
      categories = buildCategories(loginRows, metricsApi);
    } catch (err) {
      categories = null;
      categoriesError = String(err && err.message ? err.message : err);
    }

    // Breakout picks: the guest-only videos whose themes the home feed barely
    // carries. Another enhancement - an empty block, never a dark panel.
    let breakout = { candidates: 0, items: [] };
    let breakoutError = null;
    try {
      breakout = buildBreakout(db, {
        date,
        loginRows,
        guestRows: expoRows.filter((r) => r.kind === 'guest'),
        tagMap,
        themeMap,
        themes,
      });
    } catch (err) {
      breakout = { candidates: 0, items: [] };
      breakoutError = String(err && err.message ? err.message : err);
    }

    let trend;
    let trendError = null;
    try {
      // The window ends at the newest day the database knows about, which can
      // be newer than the exposure day this summary is built from.
      const latest = db
        .prepare('SELECT MAX(date) AS d FROM (SELECT date FROM snapshot UNION ALL SELECT date FROM exposure)')
        .get()?.d;
      const latestDate = typeof latest === 'string' && latest > date ? latest : date;
      trend = buildTrend(db, latestDate, themes, cocoon, tagMap, themeMap);
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
      feedFocus,
      categories,
      breakout,
      attribution,
      trend,
      ...(attributionError === null ? {} : { attributionError }),
      ...(feedFocusError === null ? {} : { feedFocusError }),
      ...(categoriesError === null ? {} : { categoriesError }),
      ...(breakoutError === null ? {} : { breakoutError }),
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
