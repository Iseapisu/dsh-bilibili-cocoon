// Bilibili WBI request signing (mixin key + w_rid), a serialized rate-limited
// request queue, and the guest buvid3 device fingerprint.

import { createHash } from 'node:crypto';

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi';

const WBI_KEY_TTL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 1000;

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

// ----------------------------------------------------------------------
// Rate limit: module-level serial queue
// ----------------------------------------------------------------------

let queueTail = Promise.resolve();
let lastRequestAt = 0;

export function limitedFetch(url, init = {}, fetchImpl = undefined) {
  const isInjected = typeof fetchImpl === 'function' && fetchImpl !== globalThis.fetch;
  if (isInjected) return fetchImpl(url, init);

  const run = async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return globalThis.fetch(url, init);
  };
  const task = queueTail.then(run, run);
  queueTail = task.then(
    () => {},
    () => {},
  );
  return task;
}

// ----------------------------------------------------------------------
// buvid3: anonymous fingerprint for cookie-less requests
// ----------------------------------------------------------------------

let buvid3Cache = null;

export function resetBuvid() {
  buvid3Cache = null;
}

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

export function ensureBuvid(cookie = '', buvid3 = '') {
  if (!buvid3) return cookie || '';
  if (/(^|;\s*)buvid3=/.test(cookie)) return cookie;
  return cookie ? `${cookie.replace(/;\s*$/, '')}; buvid3=${buvid3}` : `buvid3=${buvid3}`;
}

// ----------------------------------------------------------------------
// Request plumbing and JSON parsing
// ----------------------------------------------------------------------

function isRetryable(err) {
  if (!(err instanceof HttpError)) return true;
  if (err.code === 'NETWORK_ERROR') return true;
  return typeof err.status === 'number' && (err.status >= 500 || err.status === 429 || err.status === 412);
}

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

// ----------------------------------------------------------------------
// WBI signing
// ----------------------------------------------------------------------

let wbiKeyCache = null; // { imgKey, subKey, mixinKey, at }

function fileNameNoExt(url) {
  const last = String(url).split('/').pop() ?? '';
  const dot = last.indexOf('.');
  return dot === -1 ? last : last.slice(0, dot);
}

export async function getWbiKeys(fetchImpl = undefined) {
  const now = Date.now();
  if (wbiKeyCache && now - wbiKeyCache.at < WBI_KEY_TTL_MS) {
    const { imgKey, subKey, mixinKey: mk } = wbiKeyCache;
    return { imgKey, subKey, mixinKey: mk };
  }

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

export function mixinKey(imgKey, subKey) {
  const raw = `${imgKey ?? ''}${subKey ?? ''}`;
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    const idx = MIXIN_KEY_ENC_TAB[i];
    out += raw[idx] ?? '';
  }
  return out;
}

export function signParams(params = {}, mixinKeyStr = '') {
  if (!mixinKeyStr) throw new Error('signParams: mixinKey 不能为空');
  const wts = Math.floor(Date.now() / 1000);

  const merged = { ...params, wts };
  const clean = {};
  for (const [k, raw] of Object.entries(merged)) {
    if (raw === undefined || raw === null) continue;
    const str = Array.isArray(raw) || typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    clean[k] = str.replace(/[!'()*]/g, '');
  }

  const query = Object.keys(clean)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean[k])}`)
    .join('&');

  const wRid = createHash('md5').update(query + mixinKeyStr).digest('hex');
  return { ...clean, wts, w_rid: wRid };
}

export async function wbiGet(url, params = {}, opts = {}) {
  const { cookie = '', ua = DEFAULT_UA, retry = 0, fetchImpl = undefined } = opts;

  const keys = await getWbiKeys(fetchImpl);
  const signed = signParams(params, keys.mixinKey);

  const query = Object.keys(signed)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(signed[k]))}`)
    .join('&');
  const fullUrl = `${url}${url.includes('?') ? '&' : '?'}${query}`;

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
