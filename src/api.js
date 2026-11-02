// src/api.js
// B站数据采集层：首页推荐流 / 观看历史 / 全站排行。
// 统一返回 { items, personalized }，item 结构见 SPEC。
// 所有网络异常一律抛出（带 code / url / status），绝不返回空数组假装成功。

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

// 推荐理由里出现这些词，说明推荐是个性化的（基于你的行为）而不是通用热门
const PERSONALIZED_REASON_RE = /相关推荐|热门|关注/;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 数字或 null（字符串数字也转；NaN 归 null）。 */
function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 字符串或 null（去首尾空白；空串归 null）。 */
function strOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** 时长统一成秒：支持 123 / "123" / "12:34" / "1:02:03"。 */
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

/** 标签统一成 string[]（数组取 tag_name/name，字符串按逗号拆）。 */
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

/** 从各种返回形状里抠出推荐理由原文（rcmd 接口字段名换过好几版，老版是字符串，新版是 {content}）。 */
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

/**
 * 判断一条 rcmd 数据是不是真实视频卡。
 * 未登录的首页流里会混入 login_card（goto=login_card，bvid/title 全空），
 * 直接 normalize 会得到一堆 null 字段的假条目，所以这里剔除。
 */
function isVideoCard(raw) {
  if (raw?.goto && raw.goto !== 'av') return false;
  return typeof raw?.bvid === 'string' && raw.bvid.startsWith('BV');
}

/**
 * 统一 Item 结构（缺字段填 null，key 一个都不省）。
 * raw: 接口返回的单条原始对象；source: 'rcmd' | 'history' | 'ranking'
 */
export function normalize(raw, source) {
  const r = raw ?? {};
  const history = r.history ?? {};
  return {
    bvid: strOrNull(r.bvid ?? history.bvid),
    // rcmd 用 id，history 把 aid 放在 history.oid，ranking 用 aid
    aid: numOrNull(r.aid ?? r.id ?? history.oid),
    title: strOrNull(r.title),
    mid: numOrNull(r.owner?.mid ?? r.author_mid ?? r.mid),
    upName: strOrNull(r.owner?.name ?? r.author_name ?? r.upName),
    tid: numOrNull(r.tid),
    // 历史记录没有 tid，分区名在 tag_name 里
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

/** 业务 code 非 0 时抛出，消息里带接口地址，方便排查风控。 */
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

// ---------------------------------------------------------------------------
// 首页推荐流
// ---------------------------------------------------------------------------

/**
 * 首页推荐（个性化流）。
 * 参数是 B站 web 首页当前版本要求的固定组合，少一个会返回 -400。
 * 无 cookie 时返回的是通用流：personalized=false。
 */
export async function fetchRcmd({ limit = 20, cookie = '', buvid = '', fetchImpl = undefined } = {}) {
  // 单页 ps 上限是 30（大于 30 直接 -400），所以 want 也截在 30
  const want = Math.min(30, Number(limit) > 0 ? Math.floor(Number(limit)) : 20);
  // 游客 buvid3：拿不到就退化成不带 cookie 的请求，不阻断主流程
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
    // ps 在 limit 上留 5 条余量：流里会夹 login_card/广告卡，过滤后仍能凑够 limit 条。
    // 实测 ps 上限是 30（31 以上直接 code=-400 请求错误），所以余量也要被这个上限截住。
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
    // 有 code=0 但一条视频都没有（例如账号被风控成空流），按失败处理，不假装成功
    throw new HttpError('推荐流接口返回 0 条视频卡（可能被风控或参数失效）', { code: 0, url: RCMD_URL, status: 200 });
  }
  const items = sliceLimit(cards.map((it) => normalize(it, 'rcmd')), want);

  // 个性化判断（启发式，三种信号任一命中）：
  //   1) 推荐理由文本里出现「相关推荐/热门/关注」
  //   2) 流里混进了「已关注」的 UP（is_followed）
  //   3) rcmd_reason.reason_type > 0（新版接口把理由换成了枚举，没有文本可读）
  // 没有 cookie 一定是通用流，直接 false。
  const followed = cards.filter((c) => c.is_followed === true).length;
  const typed = cards.filter((c) => Number(c.rcmd_reason?.reason_type ?? 0) > 0).length;
  const reasons = items.map((it) => it.rcmdReason).filter(Boolean);
  const personalized =
    Boolean(cookie) &&
    (followed > 0 || typed > 0 || reasons.some((reason) => PERSONALIZED_REASON_RE.test(reason)));

  return { items, personalized };
}

// ---------------------------------------------------------------------------
// 观看历史
// ---------------------------------------------------------------------------

/** 观看历史。必须登录：无 cookie 直接给出清晰错误，不去浪费一次请求。 */
export async function fetchHistory({ limit = 20, cookie = '', fetchImpl = undefined, pages = 1 } = {}) {
  const url = `${HISTORY_URL}?ps=${encodeURIComponent(limit)}&max=0&view_at=0&business=&type=archive`;
  if (!cookie) {
    throw new HttpError('观看历史需要登录 Cookie：请设置环境变量 BILI_COOKIE 或用 --cookie-file 指定导出文件', {
      code: -101,
      url,
      status: null,
    });
  }

  // 历史分页：cursor 的 view_at / max 是下一页游标。
  // 分类熵要在 200+ 条样本上才稳定（Frontiers 2024 用 3 个月 200+ 条），单页 30 条不够。
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

  // 历史本身不是「推荐」，personalized 只描述推荐流的个性化程度
  return { items: collected, personalized: false };
}

// ---------------------------------------------------------------------------
// 全站排行
// ---------------------------------------------------------------------------

/** 全站排行榜（普通接口，不需要登录）。风控码出现时退回 WBI 签名再试一次。 */
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
    // -352 / -403 / 412 这类风控，用 WBI 签名再试一次（部分时段排行榜也会要 wbi）
    const code = firstErr?.code;
    const shouldRetrySigned = code === -352 || code === -403 || code === -412 || code === 412;
    if (!shouldRetrySigned) throw firstErr;
    json = await wbiGet(RANKING_URL, { rid: 0, type: 'all' }, { cookie: finalCookie, fetchImpl });
    assertCode(json, url, { requireData: (j) => Array.isArray(j?.data?.list) });
  }

  const items = sliceLimit(json.data.list.map((it) => normalize(it, 'ranking')), limit);
  return { items, personalized: false };
}

/**
 * 单条视频详情：只取茧房分析需要的字段。
 *
 * 为什么需要它：首页推荐接口（feed/rcmd）返回的卡片里 **没有 tid / tname / tags**，
 * 直接算分区熵会把所有条目归成「未知」一个分区，得出一个假的满熵=0。
 * 所以 rcmd 采完之后要按 bvid 补一次详情。
 *
 * 注意：/x/web-interface/view 对**未登录**请求返回的 tname 是空字符串（tid 正常）。
 * 因此这里允许 tname 为 null，由 enrichItems 用 tid 兜底成「分区<tid>」。
 */
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

// 少量一级 / 常见分区的 tid → 名称，作为 tid-region.json 之后的第二层兜底。
// 主表（33+ 条二级分区）由 tools/build-tid-map.mjs 反查生成；这里只在既不在主表、
// 又刚好是常见一级 tid 时生效。注意「名字」不是装饰：parentOf() 靠名字折叠到一级分区，
// 名字缺失就会让整条记录落进「其他」，所以这里的兜底只负责别再吐 null。
const REGION_NAMES = new Map([
  [1, '动画'], [13, '番剧'], [167, '国创'], [3, '音乐'], [129, '舞蹈'],
  [4, '游戏'], [5, '娱乐'], [36, '知识'], [188, '科技'], [234, '运动'],
  [223, '汽车'], [160, '生活'], [211, '美食'], [217, '动物'], [119, '鬼畜'],
  [155, '时尚'], [202, '资讯'], [181, '影视'], [177, '纪录片'], [23, '电影'],
  [11, '电视剧'], [71, '综艺'], [95, '数码'], [138, '搞笑'], [21, '日常'],
  [75, '动物圈'], [76, '美食圈'], [161, '手工'], [162, '绘画'], [163, '运动'],
]);

/**
 * 分区显示名：真实 tname → tid-region.json（主表，由 tools/build-tid-map.mjs 反查生成）
 * → 下面那 29 条硬编码兜底 → 「分区<tid>」占位（有 tid 时永不返回 null）。
 *
 * 背景：/x/web-interface/view 现在（2026-11 实测）无论登录与否都返回 tname=""
 * 和 tname_v2=""，只给 tid。没有 tid-region.json 时，rcmd 流会大面积退化成
 * 「分区230」这种占位名，parentOf() 全部落到「其他」，推荐流的分区分布与
 * JSD 诊断都会失真。
 */
function regionLabel(tid, tname) {
  const name = strOrNull(tname);
  if (name) return name;
  if (tid === null || tid === undefined) return null;
  const n = Number(tid);
  return TID_REGION[String(n)] ?? REGION_NAMES.get(n) ?? `分区${n}`;
}

/**
 * 给缺分区信息的条目补齐详情（串行 + 走 wbi.js 的限速队列，1 条/秒）。
 * - 单条失败不中断，保留原条目并记入 failed
 * - 只补 null 字段，不覆盖已有值
 * - max 控制最多补多少条（默认 60），防止误设大 limit 后跑很久
 */
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
      // 游客态 view 返回的 tname 是空串，用 tid 兜底成分区标签，
      // 否则所有条目都会落进「未知」，分区熵恒为 0
      if (!merged.tname) {
        const label = regionLabel(merged.tid, null);
        if (label) merged.tname = label;
        // 记下查不到名字的 tid：这些条目会落进「其他」，需要跑 tools/build-tid-map.mjs 补表
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

/** 对外也提供 buvid3（实现放在 wbi.js，这里透出，方便调用方预热）。 */
export { getBuvid3, DEFAULT_UA, HttpError };
