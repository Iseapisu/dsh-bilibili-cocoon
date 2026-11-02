// Exposure side: samples the logged-in feed against a guest baseline (fresh
// buvid3 per round) and computes theme amplification, uploader overlap and
// repeat exposure.

import { enrichItems, fetchRcmd } from './api.js';
import { resetBuvid } from './wbi.js';
import { UNCLASSIFIED, classifyTheme, themeName } from './themes.js';
import { parentOf } from './region.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sampleOnce({ perRound, cookie, enrich }) {
  resetBuvid();
  const { items } = await fetchRcmd({ limit: perRound, cookie });
  if (!enrich) return items;
  if (!items.some((it) => !it.tname)) return items;
  const r = await enrichItems(items, { cookie, max: perRound });
  return r.items;
}

// Raw sampling only: this never fetches per-video tags, because that would add
// one request per row to a loop that already sleeps seconds between rounds.
// video_tag is backfilled separately (tools/backfill-tags.mjs) and joined in at
// summary time.
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

// ---
// Dedup measure: one unit per distinct bvid.
//
// The guest feed is resampled from a much smaller pool than the login feed (82
// guest rows = 38 videos, 84 login rows = 84 videos on the 2026-11-02 library),
// so counting rows quietly dilutes whatever the guest baseline is not showing
// and inflates every ratio built on it. Dedup counts each video once, which is
// the only measure in which "how much of my home feed is theme X" is not an
// artefact of how often the sampler re-asked. It is the tighter of the two and
// the one the panel promotes; the row measure stays for comparability with
// every number already published.
//
// Verdicts are taken per row and the first row per bvid wins: the same bvid can
// in principle be classified differently across rounds (title jitter, a tag
// backfilled between rounds), and silently letting a later row override an
// earlier verdict would make the dedup numbers depend on sampling order.
// ---

function dedupIndexes(items) {
  const seen = new Set();
  const keep = [];
  for (let i = 0; i < items.length; i += 1) {
    const bvid = items[i]?.bvid;
    // A row without a bvid cannot be recognised as a repeat, so it stays its
    // own unit instead of being dropped.
    if (bvid) {
      if (seen.has(bvid)) continue;
      seen.add(bvid);
    }
    keep.push(i);
  }
  return keep;
}

export function summarizeExposure({ login, guest }) {
  const flat = (shots) => shots.flatMap((s) => s.items);
  const L = flat(login);
  const G = flat(guest);
  const totalRounds = Math.max(login.length, guest.length, 1);

  // Tags are not collected here (a per-bvid fetch would throttle the sampling
  // loop). The caller attaches `item.tags` from the video_tag table before
  // calling this function; when it doesn't, the third argument is undefined and
  // classifyTheme falls back to title + region, i.e. the pre-tag verdicts.
  const build = (items, shots) => {
    // Classify once, then derive both measures from the same verdicts: the row
    // measure and the dedup measure can never disagree about what a row is.
    const verdicts = items.map((it) => classifyTheme(it.title, it.tname, it.tags));
    const themes = distOf(verdicts, (id) => id);
    const cats = distOf(items, (it) => parentOf(it.tname));
    const ups = distOf(items, (it) => it.upName ?? '(未知)');
    const spread = roundSpread(shots);
    const repeated = [...spread.values()].filter((v) => v.n > 1).length;
    const unclassified = themes.get(UNCLASSIFIED) ?? 0;

    const dedupVerdicts = dedupIndexes(items).map((i) => verdicts[i]);
    const dedupThemes = distOf(dedupVerdicts, (id) => id);
    const dedupUnclassified = dedupThemes.get(UNCLASSIFIED) ?? 0;
    const dedupCount = dedupVerdicts.length;

    return {
      count: items.length,
      classified: items.length - unclassified,
      themes,
      cats,
      ups,
      repeatedBvid: repeated,
      unclassified,
      coverage: items.length ? Number((1 - unclassified / items.length).toFixed(3)) : 0,
      dedup: {
        count: dedupCount,
        classified: dedupCount - dedupUnclassified,
        unclassified: dedupUnclassified,
        coverage: dedupCount ? Number((1 - dedupUnclassified / dedupCount).toFixed(3)) : 0,
        themes: dedupThemes,
      },
    };
  };

  const l = build(L, login);
  const g = build(G, guest);

  const themeIds = new Set([...l.themes.keys(), ...g.themes.keys()]);
  const amplification = [...themeIds]
    .filter((id) => id !== UNCLASSIFIED)
    .map((id) => {
      const lShare = share(l.themes.get(id) ?? 0, l.classified);
      const gShare = share(g.themes.get(id) ?? 0, g.classified);
      // Same ratio on the dedup measure: distinct videos, not sampled rows.
      const lDedupShare = share(l.dedup.themes.get(id) ?? 0, l.dedup.classified);
      const gDedupShare = share(g.dedup.themes.get(id) ?? 0, g.dedup.classified);
      return {
        id,
        name: themeName(id),
        loginShare: lShare,
        guestShare: gShare,
        ratio: gShare > 0 ? Number((lShare / gShare).toFixed(2)) : null,
        ratioDedup: gDedupShare > 0 ? Number((lDedupShare / gDedupShare).toFixed(2)) : null,
      };
    })
    .sort((a, b) => (b.loginShare - b.guestShare) - (a.loginShare - a.guestShare));

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
    repeat: {
      login: l.repeatedBvid,
      guest: g.repeatedBvid,
      loginTotal: l.count,
      guestTotal: g.count,
    },
  };
}
