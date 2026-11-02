// Bubble metrics: category entropy, HHI, Gini, Hill numbers and JSD.
// Pure functions only - no network, no IO.

import { PARENT_CATEGORIES, isMapped, parentOf } from './region.js';
import { UNCLASSIFIED, classifyTheme, themeName } from './themes.js';

const LN = Math.log;
export const MAX_CATEGORIES = PARENT_CATEGORIES.length; // 19

// ----------------------------------------------------------------------
// Basic statistics
// ----------------------------------------------------------------------

function tally(values) {
  const m = new Map();
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return m;
}

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

export function normalizedEntropy(counts, k = MAX_CATEGORIES) {
  const denom = LN(Math.max(2, Number(k) || MAX_CATEGORIES));
  return Math.min(1, shannonEntropy(counts) / denom);
}

export function hhi(counts) {
  const arr = countsArray(counts);
  const total = arr.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let s = 0;
  for (const c of arr) s += (c / total) ** 2;
  return s;
}

export function gini(counts) {
  const arr = countsArray(counts).slice().sort((a, b) => a - b);
  const n = arr.length;
  const total = arr.reduce((a, b) => a + b, 0);
  if (n === 0 || total <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i += 1) acc += (i + 1) * arr[i];
  return (2 * acc) / (n * total) - (n + 1) / n;
}

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

export function effectiveCategories(counts) {
  return Math.exp(shannonEntropy(counts));
}

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

// ----------------------------------------------------------------------
// Field aggregation
// ----------------------------------------------------------------------

export function categoryCounts(items) {
  return tally((items ?? []).map((it) => parentOf(it?.tname)));
}

export function uploaderCounts(items) {
  return tally((items ?? []).map((it) => it?.upName));
}

// Theme evidence is title > region > tags. `tags` is optional on the item shape:
// callers that cannot supply it (or an older library without a video_tag table)
// get exactly the pre-tag verdicts, because classifyTheme ignores a missing list.
// `themeMap` is the tag->theme table (Map from store.listTagThemes or the host's
// loadTagThemeMap); omitting it keeps the pure-lexicon verdicts.
export function themeCounts(items, themeMap) {
  return tally((items ?? []).map((it) => classifyTheme(it?.title, it?.tname, it?.tags, themeMap)));
}

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

// ----------------------------------------------------------------------
// Reproducible bootstrap
// ----------------------------------------------------------------------

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

/**
 * @param {{feed?: any[], history?: any[], ranking?: any[], date?: string, themeMap?: Map}} input
 *   Each item may carry an optional `tags: string[]`; it is passed to
 *   classifyTheme as the third (last-resort) evidence level. Omitting it
 *   reproduces the pre-tag theme verdicts byte for byte. `themeMap` (optional)
 *   is the tag_theme table and only changes how tag evidence is read.
 * @param {{date?: string, themeMap?: Map}} [options]
 */
// ----------------------------------------------------------------------
// Main entry
// ----------------------------------------------------------------------

// The index is a function of region entropy, region HHI and uploader Gini only.
// Theme evidence (title > region > tag) feeds the `themes` diagnostic block and
// never enters `index`: connecting tags to this function changes what the panel
// says about themes, not the 0..100 cocoon number.
//
// `subscores.repetition` is the odd one out: it is the share of uploaders that
// appear more than once, and it carries no weight at all. The index uses the
// uploader Gini instead, which measures how unevenly the sample spreads across
// uploaders rather than just how many names repeat. The panel showed the number
// without that distinction, so `indexWeights` spells out which subscores actually
// move the index - 0 means "shown for diagnosis, contributes nothing".
const INDEX_WEIGHTS = { diversity: 0.55, concentration: 0.25, repetition: 0 };

export function cocoonScore(input = {}, options = {}) {
  const feed = input.feed ?? [];
  const history = input.history ?? [];
  const ranking = input.ranking ?? [];
  const date = options.date ?? input.date ?? new Date().toISOString().slice(0, 10);
  // Tag verdicts may arrive on either object; both default to "no table", which
  // is the pre-table behaviour.
  const themeMap = options.themeMap ?? input.themeMap;

  const basis = history.length >= 10 ? 'history' : 'feed';
  const sample = basis === 'history' ? history : feed;

  if (sample.length === 0) {
    return {
      date, basis, sampleSize: 0, feedSize: feed.length, historySize: 0, rankingSize: ranking.length,
      entropy: 0, entropyNorm: 0, entropyCI: [0, 0], effectiveCategories: 0,
      hhi: 0, gini: 0, top10Share: 0, overlapWithRanking: 0, uploaderRepeat: 0, calibration: 0,
      reasonMix: reasonMix(feed),
      subscores: { diversity: 0, concentration: 0, repetition: 0 },
      indexWeights: { ...INDEX_WEIGHTS },
      topCategories: [], topUploaders: [],
      themes: { coverage: 0, unclassified: 0, concentration: 0, entropy: 0, effective: 0, topName: null, topShare: 0, top: [] },
      quality: { mappedRatio: 0, feedMappedRatio: 0, minSampleForConfidence: 100, sampleSufficient: false },
      index: 0,
      level: '无数据',
    };
  }

  const cats = categoryCounts(sample);
  const ups = uploaderCounts(sample);

  const themeRaw = themeCounts(sample, themeMap);
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

  const calibration = jsDivergence(categoryCounts(feed), categoryCounts(history.length ? history : feed));

  const raw = 0.55 * (1 - entropyNorm) + 0.25 * concentration + 0.2 * sourceGini;
  const index = Math.max(0, Math.min(100, Math.round(raw * 1000) / 10));

  const seed = Array.from(String(date)).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const [ciLo, ciHi] = bootstrapEntropyCI(cats, seed);

  const sortedCats = [...cats.entries()].sort((a, b) => b[1] - a[1]);
  const sortedUps = [...ups.entries()].sort((a, b) => b[1] - a[1]);

  return {
    date,
    // Which sample the index was computed from. Every consumer that shows the
    // number must label it: at the 2026-11-02 library the 210 history rows give
    // 21.1 while the 84 home-feed rows give 14.9 on the identical formula, and
    // showing 21.1 without this label reads as a claim about the home feed.
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

    subscores: {
      diversity: Number((entropyNorm * 100).toFixed(1)),
      concentration: Number((concentration * 100).toFixed(1)),
      repetition: Number((uploaderRepeat * 100).toFixed(1)),
    },

    // Which subscores feed `index`, and with what weight. `repetition: 0` is not
    // a rounding artefact: it is a diagnostic quantity, and moving the index is
    // deliberately out of its hands.
    indexWeights: { ...INDEX_WEIGHTS },

    topCategories: sortedCats.slice(0, 5).map(([name, n]) => ({ name, n })),
    topUploaders: sortedUps.slice(0, 5).map(([name, n]) => ({ name, n })),

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
      mappedRatio: sample.length
        ? Number((sample.filter((it) => isMapped(it?.tname)).length / sample.length).toFixed(3))
        : 0,
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
