// src/wbi.js
// B站 WBI 签名 + 全局限速请求层。零依赖：只用 node:crypto 与全局 fetch。
//
// 对外契约（SPEC 规定，不得改名）：
//   getWbiKeys(fetchImpl?) -> {imgKey, subKey, mixinKey}
//   mixinKey(imgKey, subKey) -> string(32)
//   signParams(params, mixinKey) -> 新对象（含 wts / w_rid）
//   wbiGet(url, params, opts) -> 解析后的 JSON
//
// 额外导出（api.js 复用，不改变上面的契约）：
//   DEFAULT_UA / HttpError / limitedFetch / requestJson / getBuvid3

import { createHash } from 'node:crypto';

/** 统一的真实浏览器 UA。B站对 Node 默认 UA 会直接风控（-352 / 412）。 */
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * WBI 混淆表：把 imgKey+subKey 拼成的 64 字符串按此表重排，取前 32 位作为 mixinKey。
 * 表来自 B站前端 web 源码，顺序不能改。
 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi';

/** wbi key 进程内缓存 10 分钟（B站每天轮换，10 分钟足够且能容忍后台换 key）。 */
const WBI_KEY_TTL_MS = 10 * 60 * 1000;
/** 两次真实网络请求之间的最小间隔（毫秒）——模块内串行队列。 */
const MIN_INTERVAL_MS = 1000;

/** 带 code / url / status 的统一错误对象，方便上层判断。 */
export class HttpError extends Error {
  constructor(message, { code = null, url = null, status = null, cause = undefined } = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.url = url;
    this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 限速：模块级串行队列
// ---------------------------------------------------------------------------

/** 队列尾部：新任务永远链在上一个任务之后，保证同时只有一个请求在飞。 */
let queueTail = Promise.resolve();
/** 上一次真实请求的发起时刻（不是完成时刻），用于保证「发起间隔」>= 1000ms。 */
let lastRequestAt = 0;

/**
 * 受全局限速保护的 fetch。
 * - 注入 fetchImpl（测试用）时直接调用，完全绕过队列与 1s 间隔，方便单测；
 * - 否则串行进队列，保证两次真实请求发起间隔 >= 1000ms。
 */
export function limitedFetch(url, init = {}, fetchImpl = undefined) {
  const isInjected = typeof fetchImpl === 'function' && fetchImpl !== globalThis.fetch;
  if (isInjected) return fetchImpl(url, init);

  const run = async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return globalThis.fetch(url, init);
  };
  // 用 then(run, run) 保证上一个任务失败也不会打断队列
  const task = queueTail.then(run, run);
  queueTail = task.then(
    () => {},
    () => {},
  );
  return task;
}

// ---------------------------------------------------------------------------
// buvid3：无 cookie 时的匿名指纹，带上能显著降低风控概率
// ---------------------------------------------------------------------------

let buvid3Cache = null;

/**
 * 清掉缓存的游客设备指纹。
 * 下一次 getBuvid3() 会向 finger/spi 申请一个全新的 buvid3——相当于「一台从没来过的新设备」，
 * 用来做曝光侧的游客基线（否则所有游客请求共用同一个匿名画像）。
 * 注意：IP / 城市 / UA 换不掉，所以这只是「没有账号历史」，不是绝对中立。
 */
export function resetBuvid() {
  buvid3Cache = null;
}

/** 取游客 buvid3（data.b_3），进程内缓存。失败会抛错，调用方可自行降级。 */
export async function getBuvid3(fetchImpl = undefined) {
  if (buvid3Cache) return buvid3Cache;
  const json = await requestJson(SPI_URL, { fetchImpl });
  const b3 = json?.data?.b_3;
  if (!b3) {
    throw new HttpError('finger/spi 未返回 data.b_3', { code: json?.code ?? null, url: SPI_URL, status: 200 });
  }
  buvid3Cache = b3;
  return buvid3Cache;
}

/** 把 buvid3 合并进 Cookie 头；已有 buvid3 则不重复添加。 */
export function ensureBuvid(cookie = '', buvid3 = '') {
  if (!buvid3) return cookie || '';
  if (/(^|;\s*)buvid3=/.test(cookie)) return cookie;
  return cookie ? `${cookie.replace(/;\s*$/, '')}; buvid3=${buvid3}` : `buvid3=${buvid3}`;
}

// ---------------------------------------------------------------------------
// 底层请求 + JSON 解析
// ---------------------------------------------------------------------------

function isRetryable(err) {
  if (!(err instanceof HttpError)) return true;
  if (err.code === 'NETWORK_ERROR') return true;
  return typeof err.status === 'number' && (err.status >= 500 || err.status === 429 || err.status === 412);
}

/**
 * 发一个 GET 并解析 JSON。
 * 网络错误 / HTTP 非 200 / JSON 不合法都会抛出带 code、url、status 的 HttpError。
 * retry 只对网络错误、5xx、429、412 生效；每次重试同样走限速队列。
 */
export async function requestJson(url, opts = {}) {
  const { cookie = '', ua = DEFAULT_UA, retry = 0, fetchImpl = undefined, headers: extraHeaders } = opts;
  const headers = {
    'User-Agent': ua,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    ...extraHeaders,
  };
  if (cookie) headers.Cookie = cookie;

  let lastErr = null;
  const attempts = Math.max(0, Number(retry) || 0) + 1;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await limitedFetch(url, { method: 'GET', headers }, fetchImpl);
      const status = res.status;
      let text = '';
      try {
        text = await res.text();
      } catch (e) {
        throw new HttpError(`读取响应体失败: ${e?.message ?? e}`, { code: 'NETWORK_ERROR', url, status, cause: e });
      }
      if (status !== 200) {
        // HTTP 层失败：带上状态码与接口地址，方便上层区分风控(412/429)与普通错误
        throw new HttpError(`HTTP ${status}`, { code: status, url, status });
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new HttpError('响应不是合法 JSON', { code: 'INVALID_JSON', url, status, cause: e });
      }
    } catch (e) {
      lastErr =
        e instanceof HttpError
          ? e
          : new HttpError(`网络请求失败: ${e?.message ?? e}`, { code: 'NETWORK_ERROR', url, status: null, cause: e });
      if (i < attempts - 1 && isRetryable(lastErr)) continue;
      throw lastErr;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// WBI 签名
// ---------------------------------------------------------------------------

let wbiKeyCache = null; // { imgKey, subKey, mixinKey, at }

/** 从 URL 里取文件名并去掉扩展名，例如 .../7cd084941338484aae1ad9425b84077c.png -> 7cd...c */
function fileNameNoExt(url) {
  const last = String(url).split('/').pop() ?? '';
  const dot = last.indexOf('.');
  return dot === -1 ? last : last.slice(0, dot);
}

/**
 * 取 wbi key（进程内缓存 10 分钟）。
 * nav 未登录时会返回 code -101，但 data.wbi_img 仍然存在——所以不按 code 判失败，
 * 只要求 data.wbi_img.img_url / sub_url 齐全。
 */
export async function getWbiKeys(fetchImpl = undefined) {
  const now = Date.now();
  if (wbiKeyCache && now - wbiKeyCache.at < WBI_KEY_TTL_MS) {
    const { imgKey, subKey, mixinKey: mk } = wbiKeyCache;
    return { imgKey, subKey, mixinKey: mk };
  }

  // 带上游客 buvid3 更像真实浏览器；拿不到不阻断（部分网络环境 spi 会被拦）
  let guestCookie = '';
  try {
    guestCookie = ensureBuvid('', await getBuvid3(fetchImpl));
  } catch {
    guestCookie = '';
  }

  const json = await requestJson(NAV_URL, { cookie: guestCookie, fetchImpl });
  const imgUrl = json?.data?.wbi_img?.img_url;
  const subUrl = json?.data?.wbi_img?.sub_url;
  if (!imgUrl || !subUrl) {
    throw new HttpError('nav 接口未返回 wbi_img，无法计算 WBI 签名', {
      code: json?.code ?? null,
      url: NAV_URL,
      status: 200,
    });
  }
  const imgKey = fileNameNoExt(imgUrl);
  const subKey = fileNameNoExt(subUrl);
  const mk = mixinKey(imgKey, subKey);
  wbiKeyCache = { imgKey, subKey, mixinKey: mk, at: now };
  return { imgKey, subKey, mixinKey: mk };
}

/**
 * WBI mixinKey：把 imgKey+subKey 拼成 64 字符串，
 * 按 MIXIN_KEY_ENC_TAB 的 64 个下标依次取字符，只取前 32 个，得到 32 位字符串。
 */
export function mixinKey(imgKey, subKey) {
  const raw = `${imgKey ?? ''}${subKey ?? ''}`;
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    const idx = MIXIN_KEY_ENC_TAB[i];
    out += raw[idx] ?? '';
  }
  return out;
}

/**
 * 计算 w_rid：
 *   1) 参数补上 wts（秒级时间戳）；
 *   2) 值先 String（数组/对象先 JSON 序列化），并过滤掉 !'()* 这些字符；
 *   3) 按 key 升序，k=v&k=v 拼接，值做 encodeURIComponent；
 *   4) 末尾拼上 mixinKey，取 md5 十六进制 —— 就是 w_rid。
 * 返回新对象（原参数 + wts + w_rid），不改入参。
 */
export function signParams(params = {}, mixinKeyStr = '') {
  if (!mixinKeyStr) throw new Error('signParams: mixinKey 不能为空');
  const wts = Math.floor(Date.now() / 1000);

  // 注意：wts 必须先塞进去再一起签名，否则服务端算出来的 w_rid 不一致（-403）
  const merged = { ...params, wts };
  const clean = {};
  for (const [k, raw] of Object.entries(merged)) {
    if (raw === undefined || raw === null) continue;
    const str = Array.isArray(raw) || typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    // B站前端会把这些字符从值里剔除，签名与发送必须用同一份处理后的值
    clean[k] = str.replace(/[!'()*]/g, '');
  }

  const query = Object.keys(clean)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean[k])}`)
    .join('&');

  const wRid = createHash('md5').update(query + mixinKeyStr).digest('hex');
  return { ...clean, wts, w_rid: wRid };
}

/**
 * 带 WBI 签名的 GET。
 * opts: { cookie, ua, retry, fetchImpl? }
 * 自动取 key（缓存 10 分钟）→ 签名 → 请求 → 解析 JSON，返回原始 JSON 信封（不判定 code）。
 */
export async function wbiGet(url, params = {}, opts = {}) {
  const { cookie = '', ua = DEFAULT_UA, retry = 0, fetchImpl = undefined } = opts;

  const keys = await getWbiKeys(fetchImpl);
  const signed = signParams(params, keys.mixinKey);

  const query = Object.keys(signed)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(signed[k]))}`)
    .join('&');
  const fullUrl = `${url}${url.includes('?') ? '&' : '?'}${query}`;

  // Cookie 里补游客 buvid3，降低无登录请求被 -352 风控的概率
  let finalCookie = cookie || '';
  if (!finalCookie) {
    try {
      finalCookie = ensureBuvid('', await getBuvid3(fetchImpl));
    } catch {
      finalCookie = '';
    }
  }

  return requestJson(fullUrl, { cookie: finalCookie, ua, retry, fetchImpl });
}
