// src/metrics.js
//
// 信息茧房度量。方法学依据：
//   Fu et al. (2024) "Heavy users fail to fall into filter bubbles: evidence from a
//   Chinese online video platform", Front. Phys. 12:1423851.
//   → 用「内容分类上的信息熵」衡量茧房，分类轴是 21 个一级分区，样本是观看历史。
//   另用 Hill 数（有效分类数 exp(H)）和 JSD 作辅助口径。
//
// 与 v1 的关键差异：
//   1) 分类轴从「二级分区」折叠到「一级分区」——二级有 150+ 个，会把同属游戏的内容
//      当成不同类，严重高估多样性（v1 就是这么把 28 条算出 0.98 熵的）。
//   2) 归一化熵改为除以固定 K（19 个一级分区），不再除以「观测到的分类数」——
//      后者会让「3 类均分」和「19 类均分」得分相同，恰好抹掉茧房最重要的一维。
//   3) 主样本用观看历史（消费行为），推荐流只作对照。
//   4) 给出 bootstrap 置信区间，避免用单点数字冒充精确结论。

import { PARENT_CATEGORIES, isMapped, parentOf } from './region.js';
import { UNCLASSIFIED, classifyTheme, themeName } from './themes.js';

const LN = Math.log;
export const MAX_CATEGORIES = PARENT_CATEGORIES.length; // 19

// ---------------------------------------------------------------- 基础统计

/** values → Map<value, count>（忽略 null/undefined/空串） */
function tally(values) {
  const m = new Map();
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return m;
}

/** count 数组：Map → number[]。保留 0（Gini 需要看到「有这一类但曝光为 0」）。 */
function countsArray(counts) {
  if (counts instanceof Map) return [...counts.values()];
  return Array.isArray(counts) ? counts.filter((n) => Number.isFinite(n) && n >= 0) : [];
}

export function shannonEntropy(counts) {
  const total = countsArray(counts).reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const c of countsArray(counts)) {
    const p = c / total;
    if (p > 0) h -= p * LN(p);
  }
  return h;
}

/**
 * 归一化熵。默认除以 ln(19)（一级分区总数），这样不同分类数之间可比。
 * 传 k 可指定分母（旧行为：除以观测到的分类数）。
 */
export function normalizedEntropy(counts, k = MAX_CATEGORIES) {
  const denom = LN(Math.max(2, Number(k) || MAX_CATEGORIES));
  return Math.min(1, shannonEntropy(counts) / denom);
}

/** HHI = Σp²，1.0 表示所有内容集中在一个分类。 */
export function hhi(counts) {
  const arr = countsArray(counts);
  const total = arr.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let s = 0;
  for (const c of arr) s += (c / total) ** 2;
  return s;
}

/** Gini 系数（对曝光分布），0 = 完全平均。 */
export function gini(counts) {
  const arr = countsArray(counts).slice().sort((a, b) => a - b);
  const n = arr.length;
  const total = arr.reduce((a, b) => a + b, 0);
  if (n === 0 || total <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i += 1) acc += (i + 1) * arr[i];
  return (2 * acc) / (n * total) - (n + 1) / n;
}

/** 前 k 名占比。 */
export function topShare(counts, k = 10) {
  const arr = countsArray(counts).slice().sort((a, b) => b - a);
  const total = arr.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  return arr.slice(0, k).reduce((a, b) => a + b, 0) / total;
}

export function jaccard(setA, setB) {
  const a = new Set(setA ?? []);
  const b = new Set(setB ?? []);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 有效分类数（Hill number, q=1）：exp(H)，可读作「相当于看了几个分类」。 */
export function effectiveCategories(counts) {
  return Math.exp(shannonEntropy(counts));
}

/** 两个分布之间的 Jensen-Shannon 散度（以 2 为底，0..1）。 */
export function jsDivergence(countsA, countsB) {
  const a = countsA instanceof Map ? countsA : new Map();
  const b = countsB instanceof Map ? countsB : new Map();
  const keys = new Set([...a.keys(), ...b.keys()]);
  const totalA = [...a.values()].reduce((x, y) => x + y, 0);
  const totalB = [...b.values()].reduce((x, y) => x + y, 0);
  if (!totalA || !totalB) return 0;
  const kl = (p, q) => (p > 0 && q > 0 ? p * LN(p / q) : 0);
  let js = 0;
  for (const key of keys) {
    const p = (a.get(key) ?? 0) / totalA;
    const q = (b.get(key) ?? 0) / totalB;
    const m = (p + q) / 2;
    js += 0.5 * kl(p, m) + 0.5 * kl(q, m);
  }
  return Math.min(1, js / LN(2));
}

// ---------------------------------------------------------------- 字段聚合

/** 按一级分区计数（二级名先折叠到一级）。 */
export function categoryCounts(items) {
  return tally((items ?? []).map((it) => parentOf(it?.tname)));
}

export function uploaderCounts(items) {
  return tally((items ?? []).map((it) => it?.upName));
}

/**
 * 按主题计数（标题关键词 + 二级分区兜底，规则见 themes.js）。
 * 与 categoryCounts 的区别：分区是「平台怎么归类」，主题是「内容讲什么」。
 * 一个人可以在 19 个分区里横跳，内容却全挤在「AI」这一个主题上。
 */
export function themeCounts(items) {
  return tally((items ?? []).map((it) => classifyTheme(it?.title, it?.tname)));
}

/** 推荐理由构成（rcmd 流才有）。 */
export function reasonMix(items) {
  const out = { 热门: 0, 相关推荐: 0, 关注: 0, 其他: 0 };
  const list = items ?? [];
  if (list.length === 0) return out;
  for (const it of list) {
    const r = it?.rcmdReason;
    if (typeof r === 'string' && /相关推荐/.test(r)) out.相关推荐 += 1;
    else if (typeof r === 'string' && /关注/.test(r)) out.关注 += 1;
    else if (typeof r === 'string' && /热门/.test(r)) out.热门 += 1;
    else out.其他 += 1;
  }
  for (const k of Object.keys(out)) out[k] /= list.length;
  return out;
}

// ---------------------------------------------------------------- 可复现的 bootstrap

/** mulberry32：固定种子 PRNG，保证同输入同输出（测试要求确定性）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 对分类分布做 bootstrap，返回归一化熵的 [2.5%, 97.5%] 区间（种子由 date 派生）。 */
function bootstrapEntropyCI(cats, seed, reps = 400) {
  const pool = [];
  for (const [k, v] of cats) for (let i = 0; i < v; i += 1) pool.push(k);
  if (pool.length < 2) return [0, 0];
  const rnd = mulberry32(seed);
  const stats = [];
  for (let r = 0; r < reps; r += 1) {
    const m = new Map();
    for (let i = 0; i < pool.length; i += 1) {
      const pick = pool[Math.floor(rnd() * pool.length)];
      m.set(pick, (m.get(pick) ?? 0) + 1);
    }
    stats.push(normalizedEntropy(m));
  }
  stats.sort((a, b) => a - b);
  return [stats[Math.floor(reps * 0.025)], stats[Math.floor(reps * 0.975)]];
}

// ---------------------------------------------------------------- 主入口

/**
 * @param {{feed?: any[], history?: any[], ranking?: any[], date?: string}} input
 * @param {{date?: string}} [options]
 */
export function cocoonScore(input = {}, options = {}) {
  const feed = input.feed ?? [];
  const history = input.history ?? [];
  const ranking = input.ranking ?? [];
  const date = options.date ?? input.date ?? new Date().toISOString().slice(0, 10);

  // 主样本：优先观看历史（消费行为），不足 10 条时退回推荐流并标记
  const basis = history.length >= 10 ? 'history' : 'feed';
  const sample = basis === 'history' ? history : feed;

  // 没有样本时不要假装算出「偏窄」——直接给出无数据结论
  if (sample.length === 0) {
    return {
      date, basis, sampleSize: 0, feedSize: feed.length, historySize: 0, rankingSize: ranking.length,
      entropy: 0, entropyNorm: 0, entropyCI: [0, 0], effectiveCategories: 0,
      hhi: 0, gini: 0, top10Share: 0, overlapWithRanking: 0, uploaderRepeat: 0, calibration: 0,
      reasonMix: reasonMix(feed),
      subscores: { diversity: 0, concentration: 0, repetition: 0 },
      topCategories: [], topUploaders: [],
      themes: { coverage: 0, unclassified: 0, concentration: 0, entropy: 0, effective: 0, topName: null, topShare: 0, top: [] },
      quality: { mappedRatio: 0, feedMappedRatio: 0, minSampleForConfidence: 100, sampleSufficient: false },
      index: 0,
      level: '无数据',
    };
  }

  const cats = categoryCounts(sample);
  const ups = uploaderCounts(sample);

  // 主题浓度：未分类不进分母（否则覆盖率低的日期会被稀释得好看），覆盖率单独报告。
  const themeRaw = themeCounts(sample);
  const themeUnclassified = themeRaw.get(UNCLASSIFIED) ?? 0;
  const themeClassified = sample.length - themeUnclassified;
  const classifiedThemes = new Map([...themeRaw].filter(([id]) => id !== UNCLASSIFIED));
  const themeSorted = [...classifiedThemes.entries()].sort((a, b) => b[1] - a[1]);
  const themeTop = themeSorted[0] ?? null;
  const themeConcentration = themeClassified > 0 && themeTop ? themeTop[1] / themeClassified : 0;
  const themeH = shannonEntropy(classifiedThemes);

  const h = shannonEntropy(cats);
  const entropyNorm = normalizedEntropy(cats);
  const concentration = hhi(cats);
  const sourceGini = gini(ups);
  const effCats = effectiveCategories(cats);

  const overlap = jaccard(
    feed.map((it) => it?.bvid).filter(Boolean),
    ranking.map((it) => it?.bvid).filter(Boolean),
  );
  const repeatedUps = [...ups.values()].filter((n) => n > 1).length;
  const uploaderRepeat = ups.size ? repeatedUps / ups.size : 0;

  // 推荐流 vs 观看历史的分类分布差异（JSD），只作诊断，不进主分
  const calibration = jsDivergence(categoryCounts(feed), categoryCounts(history.length ? history : feed));

  // 主分：0 = 很宽，100 = 很窄
  //   0.55 分类宽度（1 - 归一化熵）· 0.25 分类集中度（HHI）· 0.20 来源集中度（UP Gini）
  const raw = 0.55 * (1 - entropyNorm) + 0.25 * concentration + 0.2 * sourceGini;
  const index = Math.max(0, Math.min(100, Math.round(raw * 1000) / 10));

  const seed = Array.from(String(date)).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const [ciLo, ciHi] = bootstrapEntropyCI(cats, seed);

  const sortedCats = [...cats.entries()].sort((a, b) => b[1] - a[1]);
  const sortedUps = [...ups.entries()].sort((a, b) => b[1] - a[1]);

  return {
    date,
    basis,
    sampleSize: sample.length,
    feedSize: feed.length,
    historySize: history.length,
    rankingSize: ranking.length,

    entropy: h,
    entropyNorm,
    entropyCI: [Number(ciLo.toFixed(3)), Number(ciHi.toFixed(3))],
    effectiveCategories: Number(effCats.toFixed(2)),

    hhi: concentration,
    gini: sourceGini,
    top10Share: topShare(ups, 10),
    overlapWithRanking: overlap,
    uploaderRepeat,
    calibration,

    reasonMix: reasonMix(feed),

    // 兼容 v1 的字段名（cli/report 用），口径按新定义
    subscores: {
      diversity: Number((entropyNorm * 100).toFixed(1)),
      concentration: Number((concentration * 100).toFixed(1)),
      repetition: Number((uploaderRepeat * 100).toFixed(1)),
    },

    topCategories: sortedCats.slice(0, 5).map(([name, n]) => ({ name, n })),
    topUploaders: sortedUps.slice(0, 5).map(([name, n]) => ({ name, n })),

    // 主题浓度：分区宽 ≠ 主题散。这个维度不进主分，专门用来抓「分区熵健康但内容
    // 全挤在一个主题上」的情况（2026-11 的 AI 内容潮就是这样）。
    themes: {
      coverage: sample.length ? Number((themeClassified / sample.length).toFixed(3)) : 0,
      unclassified: themeUnclassified,
      concentration: Number(themeConcentration.toFixed(3)),
      entropy: Number(themeH.toFixed(3)),
      effective: themeClassified ? Number(Math.exp(themeH).toFixed(2)) : 0,
      topName: themeTop ? themeName(themeTop[0]) : null,
      topShare: Number(themeConcentration.toFixed(3)),
      top: themeSorted.slice(0, 5).map(([id, n]) => ({
        id,
        name: themeName(id),
        n,
        share: themeClassified ? Number((n / themeClassified).toFixed(3)) : 0,
      })),
    },

    quality: {
      // 历史样本的分区名质量（history 接口直接给二级名，通常都是好的）
      mappedRatio: sample.length
        ? Number((sample.filter((it) => isMapped(it?.tname)).length / sample.length).toFixed(3))
        : 0,
      // 推荐流的分区名质量：view 接口不给 tname，只能靠 tid-region.json 反查，
      // 是最容易坏的一环。只看 mappedRatio（历史）会漏掉它——2026-10-30 ~ 11-02
      // 的 rcmd 84 条里有 75 条是「分区NNN」，历史侧却一直是 1.0，警报没响。
      feedMappedRatio: feed.length
        ? Number((feed.filter((it) => isMapped(it?.tname)).length / feed.length).toFixed(3))
        : 0,
      minSampleForConfidence: 100,
      sampleSufficient: sample.length >= 100,
    },

    index,
    level: index < 25 ? '开阔' : index < 50 ? '偏窄' : index < 70 ? '明显收窄' : '强茧房',
  };
}
