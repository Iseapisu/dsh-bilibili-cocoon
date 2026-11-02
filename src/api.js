// Bilibili data sources: home feed, watch history, site-wide ranking, video
// detail. Every endpoint normalizes into one Item shape.

import TID_REGION from './tid-region.json' with { type: 'json' };
import {
  DEFAULT_UA,
  HttpError,
  ensureBuvid,
  getBuvid3,
  requestJson,
  wbiGet,
} from './wbi.js';

const RCMD_URL = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd';
const HISTORY_URL = 'https://api.bilibili.com/x/web-interface/history/cursor';
const RANKING_URL = 'https://api.bilibili.com/x/web-interface/ranking/v2';
const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';
const TAGS_URL = 'https://api.bilibili.com/x/tag/archive/tags';

const PERSONALIZED_REASON_RE = /相关推荐|热门|关注/;

// ----------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function parseDuration(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s.includes(':')) {
    const parts = s.split(':').map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  return null;
}

function normalizeTags(raw) {
  const src = raw?.tags ?? raw?.tag;
  if (!src) return [];
  const list = Array.isArray(src) ? src : String(src).split(',');
  const out = [];
  for (const t of list) {
    if (t === undefined || t === null) continue;
    const s = typeof t === 'object' ? t.tag_name ?? t.name ?? '' : String(t);
    const v = String(s).trim();
    if (v) out.push(v);
  }
  return out;
}

function pickRcmdReason(raw) {
  const candidates = [
    raw?.rcmd_reason,
    raw?.rcmd_reason?.content,
    raw?.rcmd_reason?.reason,
    raw?.rcmd_reason_style?.text,
    raw?.rcmd_reason_style?.rcmd_reason,
    raw?.rcmdReason,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function isVideoCard(raw) {
  if (raw?.goto && raw.goto !== 'av') return false;
  return typeof raw?.bvid === 'string' && raw.bvid.startsWith('BV');
}

export function normalize(raw, source) {
  const r = raw ?? {};
  const history = r.history ?? {};
  return {
    bvid: strOrNull(r.bvid ?? history.bvid),
    aid: numOrNull(r.aid ?? r.id ?? history.oid),
    title: strOrNull(r.title),
    mid: numOrNull(r.owner?.mid ?? r.author_mid ?? r.mid),
    upName: strOrNull(r.owner?.name ?? r.author_name ?? r.upName),
    tid: numOrNull(r.tid),
    tname: strOrNull(r.tname ?? r.tag_name),
    tags: normalizeTags(r),
    duration: parseDuration(r.duration),
    pubdate: numOrNull(r.pubdate ?? r.ctime),
    rcmdReason: source === 'rcmd' ? pickRcmdReason(r) : null,
    view: numOrNull(r.stat?.view ?? r.view),
    like: numOrNull(r.stat?.like ?? r.like),
    source,
  };
}

function assertCode(json, url, { requireData = null } = {}) {
  const code = json?.code;
  if (code !== 0) {
    throw new HttpError(`B站接口返回 code=${code} msg=${json?.message ?? ''}`, { code: code ?? null, url, status: 200 });
  }
  if (requireData && !requireData(json)) {
    throw new HttpError(`B站接口 code=0 但缺少预期数据字段`, { code: 0, url, status: 200 });
  }
}

function sliceLimit(list, limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return list;
  return list.slice(0, n);
}

// ----------------------------------------------------------------------
// Home feed
// ----------------------------------------------------------------------

export async function fetchRcmd({ limit = 20, cookie = '', buvid = '', fetchImpl = undefined } = {}) {
  const want = Math.min(30, Number(limit) > 0 ? Math.floor(Number(limit)) : 20);
  let guest = buvid || '';
  if (!guest) {
    try {
      guest = await getBuvid3(fetchImpl);
    } catch {
      guest = '';
    }
  }
  const finalCookie = ensureBuvid(cookie, guest);

  const params = {
    web_location: 1430650,
    y_num: 5,
    fresh_type: 3,
    feed_version: 'V8',
    fresh_idx: 1,
    fresh_idx_1h: 1,
    fetch_row: 1,
    brush: 0,
    homepage_ver: 1,
    ps: Math.min(want + 5, 30),
    last_y_num: 5,
    screen: '1920-1080',
    seo_info: '',
    page: 1,
  };

  const json = await wbiGet(RCMD_URL, params, { cookie: finalCookie, fetchImpl });
  assertCode(json, RCMD_URL, { requireData: (j) => Array.isArray(j?.data?.item) });

  const cards = json.data.item.filter(isVideoCard);
  if (cards.length === 0) {
    throw new HttpError('推荐流接口返回 0 条视频卡（可能被风控或参数失效）', { code: 0, url: RCMD_URL, status: 200 });
  }
  const items = sliceLimit(cards.map((it) => normalize(it, 'rcmd')), want);

  const followed = cards.filter((c) => c.is_followed === true).length;
  const typed = cards.filter((c) => Number(c.rcmd_reason?.reason_type ?? 0) > 0).length;
  const reasons = items.map((it) => it.rcmdReason).filter(Boolean);
  const personalized =
    Boolean(cookie) &&
    (followed > 0 || typed > 0 || reasons.some((reason) => PERSONALIZED_REASON_RE.test(reason)));

  return { items, personalized };
}

// ----------------------------------------------------------------------
// Watch history
// ----------------------------------------------------------------------

export async function fetchHistory({ limit = 20, cookie = '', fetchImpl = undefined, pages = 1 } = {}) {
  const url = `${HISTORY_URL}?ps=${encodeURIComponent(limit)}&max=0&view_at=0&business=&type=archive`;
  if (!cookie) {
    throw new HttpError('观看历史需要登录 Cookie：请设置环境变量 BILI_COOKIE 或用 --cookie-file 指定导出文件', {
      code: -101,
      url,
      status: null,
    });
  }

  const want = Math.max(1, Math.floor(Number(limit) || 20));
  const maxPages = Math.max(1, Math.floor(Number(pages) || 1));
  const collected = [];
  let cursor = { max: 0, view_at: 0 };

  for (let p = 0; p < maxPages; p += 1) {
    const pageUrl =
      `${HISTORY_URL}?ps=${want}&max=${cursor.max ?? 0}&view_at=${cursor.view_at ?? 0}` +
      `&business=&type=archive`;
    const json = await requestJson(pageUrl, { cookie, fetchImpl });
    if (json?.code === -101) {
      throw new HttpError('观看历史接口返回 -101（账号未登录或 Cookie 已失效），请重新导出 Cookie', {
        code: -101,
        url: pageUrl,
        status: 200,
      });
    }
    assertCode(json, pageUrl, { requireData: (j) => Array.isArray(j?.data?.list) });
    const list = json.data.list;
    if (!list.length) break;
    for (const it of list) collected.push(normalize(it, 'history'));
    const c = json.data.cursor;
    if (!c || (c.max === cursor.max && c.view_at === cursor.view_at)) break;
    if (c.view_at === 0 && c.max === 0) break;
    cursor = { max: c.max, view_at: c.view_at };
  }

  return { items: collected, personalized: false };
}

// ----------------------------------------------------------------------
// Site ranking
// ----------------------------------------------------------------------

export async function fetchRanking({ limit = 20, cookie = '', fetchImpl = undefined } = {}) {
  const url = `${RANKING_URL}?rid=0&type=all`;

  let guest = '';
  try {
    guest = await getBuvid3(fetchImpl);
  } catch {
    guest = '';
  }
  const finalCookie = ensureBuvid(cookie, guest);

  let json;
  try {
    json = await requestJson(url, { cookie: finalCookie, fetchImpl });
    assertCode(json, url, { requireData: (j) => Array.isArray(j?.data?.list) });
  } catch (firstErr) {
    const code = firstErr?.code;
    const shouldRetrySigned = code === -352 || code === -403 || code === -412 || code === 412;
    if (!shouldRetrySigned) throw firstErr;
    json = await wbiGet(RANKING_URL, { rid: 0, type: 'all' }, { cookie: finalCookie, fetchImpl });
    assertCode(json, url, { requireData: (j) => Array.isArray(j?.data?.list) });
  }

  const items = sliceLimit(json.data.list.map((it) => normalize(it, 'ranking')), limit);
  return { items, personalized: false };
}

export async function fetchVideoDetail(bvid, { cookie = '', fetchImpl = undefined } = {}) {
  const url = `${VIEW_URL}?bvid=${encodeURIComponent(bvid)}`;
  const json = await requestJson(url, { cookie, fetchImpl });
  assertCode(json, url, { requireData: (j) => Boolean(j?.data?.bvid) });
  const d = json.data;
  return {
    tid: numOrNull(d.tid),
    tname: strOrNull(d.tname),
    tags: normalizeTags(d.tags ?? d.tag),
    view: numOrNull(d.stat?.view),
    like: numOrNull(d.stat?.like),
    pubdate: numOrNull(d.pubdate),
    duration: numOrNull(d.duration),
  };
}

const REGION_NAMES = new Map([
  [1, '动画'], [13, '番剧'], [167, '国创'], [3, '音乐'], [129, '舞蹈'],
  [4, '游戏'], [5, '娱乐'], [36, '知识'], [188, '科技'], [234, '运动'],
  [223, '汽车'], [160, '生活'], [211, '美食'], [217, '动物'], [119, '鬼畜'],
  [155, '时尚'], [202, '资讯'], [181, '影视'], [177, '纪录片'], [23, '电影'],
  [11, '电视剧'], [71, '综艺'], [95, '数码'], [138, '搞笑'], [21, '日常'],
  [75, '动物圈'], [76, '美食圈'], [161, '手工'], [162, '绘画'], [163, '运动'],
]);

function regionLabel(tid, tname) {
  const name = strOrNull(tname);
  if (name) return name;
  if (tid === null || tid === undefined) return null;
  const n = Number(tid);
  return TID_REGION[String(n)] ?? REGION_NAMES.get(n) ?? `分区${n}`;
}

export async function enrichItems(items, { cookie = '', fetchImpl = undefined, max = 60 } = {}) {
  const out = [];
  let enriched = 0;
  let failed = 0;
  const unknownTids = new Set();
  for (const it of items) {
    if (out.length >= max || it.tname || !it.bvid) {
      out.push(it);
      continue;
    }
    try {
      const detail = await fetchVideoDetail(it.bvid, { cookie, fetchImpl });
      const patch = {};
      for (const [k, v] of Object.entries(detail)) {
        const emptyList = Array.isArray(v) && v.length === 0;
        if (v !== null && v !== undefined && !emptyList && (it[k] === null || it[k] === undefined)) {
          patch[k] = v;
        }
      }
      const merged = { ...it, ...patch };
      if (!merged.tname) {
        const label = regionLabel(merged.tid, null);
        if (label) merged.tname = label;
        if (label && /^分区\d+$/.test(label)) unknownTids.add(Number(merged.tid));
      }
      out.push(merged);
      enriched += 1;
    } catch {
      failed += 1;
      out.push(it);
    }
  }
  return { items: out, enriched, failed, unknownTids: [...unknownTids] };
}

// ----------------------------------------------------------------------
// Video tags
//
// x/tag/archive/tags is the only source of a video's real tag list (the feed
// and history payloads only carry an empty `tags` field). It needs no cookie
// and no WBI signature, but it answers HTTP 200 with a non-zero `code` for
// malformed ids, so the body code is the only reliable failure signal.
// ----------------------------------------------------------------------

// Accepts a bvid string ("BV..."), an "av123" string (the store keeps those
// for videos without a bvid), a bare numeric aid, or { bvid } / { aid }.
function normalizeTagRef(ref) {
  if (typeof ref === 'number') {
    return Number.isSafeInteger(ref) && ref > 0 ? { aid: String(ref) } : null;
  }
  if (typeof ref === 'string') {
    const s = ref.trim();
    if (!s) return null;
    const av = /^av(\d+)$/i.exec(s);
    if (av) return /^[1-9]\d*$/.test(av[1]) ? { aid: av[1] } : null;
    if (/^BV/i.test(s)) return s.length > 2 ? { bvid: s } : null;
    if (/^[1-9]\d*$/.test(s)) return { aid: s };
    return null;
  }
  if (ref && typeof ref === 'object') {
    const bvid = strOrNull(ref.bvid);
    if (bvid) return normalizeTagRef(bvid);
    const aid = ref.aid;
    if (aid === null || aid === undefined || aid === '') return null;
    return normalizeTagRef(typeof aid === 'number' ? aid : String(aid).trim());
  }
  return null;
}

// The endpoint sometimes repeats a tag or attaches a tag_id=0 placeholder;
// the order of the returned array also jitters between requests. Dedupe by
// name, drop tag_id=0, then sort by name so identical input always stores
// identically. tagIds stay aligned with tags through the sort.
function tagPairsFrom(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const pairs = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = numOrNull(item.tag_id);
    if (id === 0) continue;
    const name = strOrNull(item.tag_name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    pairs.push({ name, id });
  }
  pairs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return pairs;
}

function describeRef(ref) {
  if (typeof ref === 'string' || typeof ref === 'number') return JSON.stringify(ref);
  if (ref && typeof ref === 'object') {
    const bvid = strOrNull(ref.bvid);
    if (bvid) return JSON.stringify(bvid);
    if (ref.aid !== undefined && ref.aid !== null) return JSON.stringify(ref.aid);
  }
  return String(ref);
}

export async function fetchVideoTags(ref, { cookie = '', fetchImpl = undefined } = {}) {
  const query = normalizeTagRef(ref);
  if (!query) {
    return {
      ok: false,
      error: `无效的视频引用：${describeRef(ref)}（需要 bvid / av号 / { bvid } / { aid }）`,
      network: false,
    };
  }

  const qs = query.bvid
    ? `bvid=${encodeURIComponent(query.bvid)}`
    : `aid=${encodeURIComponent(query.aid)}`;
  const url = `${TAGS_URL}?${qs}`;

  let json;
  try {
    json = await requestJson(url, { cookie, fetchImpl });
  } catch (err) {
    // Transport-level failure (DNS, timeout, 412, non-JSON). Callers use this
    // flag to tell a network outage apart from a per-video business error.
    return {
      ok: false,
      error: `标签请求失败：${err?.message ?? err}`,
      code: typeof err?.code === 'number' ? err.code : undefined,
      network: true,
    };
  }

  const code = json?.code;
  if (code !== 0) {
    const numeric = Number(code);
    return {
      ok: false,
      error: `B站返回 code=${code} msg=${json?.message ?? ''}`,
      code: Number.isFinite(numeric) ? numeric : undefined,
      network: false,
    };
  }

  const pairs = tagPairsFrom(json?.data);
  return { ok: true, tags: pairs.map((p) => p.name), tagIds: pairs.map((p) => p.id) };
}

export { getBuvid3, DEFAULT_UA, HttpError };
