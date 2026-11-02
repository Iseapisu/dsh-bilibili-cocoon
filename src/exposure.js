// src/exposure.js
// 曝光侧：算法把什么推给了你。
//
// 为什么单独一层：观看历史（consumption）只说明你**看了**什么；首页推荐（exposure）才是
// 算法**给了**什么。这两件事可以背离——2026-11-02 实测：同一时刻，Web 游客流的 AI 主题占
// 9.9%，登录流占 32.1%。用历史算出来的「开阔」回答不了这个。
//
// 基线怎么取：游客身份 + 每轮换新 buvid3（resetBuvid），等于「一台从没来过的新设备」。
// 这是目前能做到的最干净的对照——IP/城市仍在，换不掉，认了。
//
// 已知边界：这里抓的是 **Web 端** 推荐流。App 的 feed/index 不吃 SESSDATA，
// 抓到的其实是 App 游客流，代表不了手机上看到的个性化结果。

import { enrichItems, fetchRcmd } from './api.js';
import { resetBuvid } from './wbi.js';
import { UNCLASSIFIED, classifyTheme, themeName } from './themes.js';
import { parentOf } from './region.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 抓一轮：先重置设备指纹，再请求，需要时补分区。 */
async function sampleOnce({ perRound, cookie, enrich }) {
  resetBuvid(); // 游客态每轮换新设备；登录态无影响（cookie 里通常已带 buvid3）
  const { items } = await fetchRcmd({ limit: perRound, cookie });
  if (!enrich) return items;
  // 推荐流卡片没有分区字段，标题关键词又不够，补一次 view 才能用分区兜底分类
  if (!items.some((it) => !it.tname)) return items;
  const r = await enrichItems(items, { cookie, max: perRound });
  return r.items;
}

/**
 * 交替采样登录流与游客流，避免「先抓的全是上午的内容」这种时间偏置。
 *
 * @returns {{rounds:number, login:Array<{round:number,items:object[]}>, guest:Array<{round:number,items:object[]}>}}
 */
export async function collectExposure({
  rounds = 3,
  perRound = 28,
  cookie = '',
  enrich = true,
  delayMs = 5000,
  onProgress = null,
} = {}) {
  const total = Math.max(1, Math.trunc(Number(rounds) || 1));
  const login = [];
  const guest = [];

  for (let r = 1; r <= total; r += 1) {
    const g = await sampleOnce({ perRound, cookie: '', enrich });
    guest.push({ round: r, items: g });
    onProgress?.('guest', r, g.length);
    await sleep(delayMs);

    const l = await sampleOnce({ perRound, cookie, enrich });
    login.push({ round: r, items: l });
    onProgress?.('login', r, l.length);

    if (r < total) await sleep(delayMs);
  }

  return { rounds: total, login, guest };
}

/** 统计一组采样里每个 bvid 出现在几轮（重复曝光的直接度量）。 */
function roundSpread(shots) {
  const m = new Map();
  for (const s of shots) {
    for (const it of s.items) {
      if (!it?.bvid) continue;
      const cur = m.get(it.bvid) ?? { n: 0, item: it };
      cur.n += 1;
      m.set(it.bvid, cur);
    }
  }
  return m;
}

function distOf(items, fn) {
  const m = new Map();
  for (const it of items) {
    const k = fn(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

const share = (n, total) => (total > 0 ? Number((n / total).toFixed(4)) : 0);

/**
 * 汇总一次曝光采样。
 * @returns {object} 两个身份各自的分布 + 主题放大倍数 + UP 重叠 + 重复曝光
 */
export function summarizeExposure({ login, guest }) {
  const flat = (shots) => shots.flatMap((s) => s.items);
  const L = flat(login);
  const G = flat(guest);
  const totalRounds = Math.max(login.length, guest.length, 1);

  const build = (items, shots) => {
    const themes = distOf(items, (it) => classifyTheme(it.title, it.tname));
    const cats = distOf(items, (it) => parentOf(it.tname));
    const ups = distOf(items, (it) => it.upName ?? '(未知)');
    const spread = roundSpread(shots);
    const repeated = [...spread.values()].filter((v) => v.n > 1).length;
    const unclassified = themes.get(UNCLASSIFIED) ?? 0;
    return {
      count: items.length,
      classified: items.length - unclassified,
      themes,
      cats,
      ups,
      repeatedBvid: repeated,
      unclassified,
      coverage: items.length ? Number((1 - unclassified / items.length).toFixed(3)) : 0,
    };
  };

  const l = build(L, login);
  const g = build(G, guest);

  // 主题放大：登录身份看到该主题的比例 ÷ 游客身份看到该主题的比例
  const themeIds = new Set([...l.themes.keys(), ...g.themes.keys()]);
  const amplification = [...themeIds]
    .filter((id) => id !== UNCLASSIFIED)
    .map((id) => {
      // 分母用「已分类」条数：与 plugin 侧、与主题浓度口径保持一致
      const lShare = share(l.themes.get(id) ?? 0, l.classified);
      const gShare = share(g.themes.get(id) ?? 0, g.classified);
      return {
        id,
        name: themeName(id),
        loginShare: lShare,
        guestShare: gShare,
        // guest 侧为 0 时没有比值可言，用 null 明确表示「全新出现」而不是 Infinity
        ratio: gShare > 0 ? Number((lShare / gShare).toFixed(2)) : null,
      };
    })
    .sort((a, b) => (b.loginShare - b.guestShare) - (a.loginShare - a.guestShare));

  // UP 重叠：登录流的人有多少在游客流里也出现过
  const guestUps = new Set(g.ups.keys());
  const loginUps = [...l.ups.keys()];
  const sharedUps = loginUps.filter((u) => guestUps.has(u)).length;

  return {
    rounds: totalRounds,
    login: l,
    guest: g,
    amplification,
    upOverlap: {
      loginUps: l.ups.size,
      guestUps: g.ups.size,
      shared: sharedUps,
      share: loginUps.length ? Number((sharedUps / loginUps.length).toFixed(3)) : 0,
    },
    // 跨轮重复：同一 bvid 在 N 轮里出现了几次。因为每次刷新基本全新，这个数通常很低，
    // 它衡量的是「短时间内同一视频被反复推」，不是「同类内容反复推」。
    repeat: {
      login: l.repeatedBvid,
      guest: g.repeatedBvid,
      loginTotal: l.count,
      guestTotal: g.count,
    },
  };
}
