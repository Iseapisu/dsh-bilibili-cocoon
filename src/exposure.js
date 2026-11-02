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

  const themeIds = new Set([...l.themes.keys(), ...g.themes.keys()]);
  const amplification = [...themeIds]
    .filter((id) => id !== UNCLASSIFIED)
    .map((id) => {
      const lShare = share(l.themes.get(id) ?? 0, l.classified);
      const gShare = share(g.themes.get(id) ?? 0, g.classified);
      return {
        id,
        name: themeName(id),
        loginShare: lShare,
        guestShare: gShare,
        ratio: gShare > 0 ? Number((lShare / gShare).toFixed(2)) : null,
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
