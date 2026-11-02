// Unit tests for the host summary (attribution, advice, trends) and for the
// tag data layer (fetchVideoTags / video_tag store).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildSummary, trendItems } from '../plugin/lib/index.js';
import { fetchVideoTags } from '../src/api.js';
import { cocoonScore } from '../src/metrics.js';
import { THEMES, classifyTheme } from '../src/themes.js';
import {
  closeStore,
  countVideoTags,
  listVideoTags,
  openStore,
  saveExposure,
  saveSnapshot,
  saveVideoTags,
} from '../src/store.js';

const DATE = '2026-11-01';

function makeItem(bvid, title, mid = null, upName = null) {
  return { bvid, title, mid, upName, tid: 1, tname: null };
}

const ai = (bvid, mid = 100, upName = 'UP甲') => makeItem(bvid, '大模型评测', mid, upName);
const game = (bvid, mid = 200, upName = '游戏UP') => makeItem(bvid, '游戏攻略', mid, upName);
const food = (bvid, mid = 300, upName = '美食UP') => makeItem(bvid, '美食探店', mid, upName);
const knowledge = (bvid, mid = 400, upName = '科普UP') => makeItem(bvid, '科普原理', mid, upName);

async function summaryOf(exposure) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cocoon-summary-'));
  const file = path.join(dir, 'cocoon.db');
  const store = openStore(file);
  try {
    for (const row of exposure) {
      saveExposure(store, DATE, row.kind, row.round, row.items);
    }
  } finally {
    closeStore(store);
  }
  try {
    return await buildSummary(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Test-only injection: a keyword whose test() throws only when classifyTheme is
// reached from buildAttribution, so the attribution pass fails while the rest
// of the summary keeps working. Restore the keyword list afterwards.
function poisonAttribution() {
  const theme = THEMES.find((t) => t.id === 'ai');
  const poison = /__attribution_never_matches__/;
  poison.test = () => {
    if (String(new Error().stack).includes('buildAttribution')) {
      throw new Error('simulated attribution failure');
    }
    return false;
  };
  theme.keywords.push(poison);
  return () => {
    const index = theme.keywords.indexOf(poison);
    if (index !== -1) theme.keywords.splice(index, 1);
  };
}

// login: ai 5 rows over 3 rounds, game 3, food 2. guest: ai 2, game 7, food 1.
const DOMINANT_UP_EXPOSURE = [
  {
    kind: 'login',
    round: 1,
    items: [ai('BVai1'), ai('BVai2'), game('BVg1'), game('BVg2'), food('BVf1')],
  },
  { kind: 'login', round: 2, items: [ai('BVai1'), ai('BVai2'), game('BVg3'), food('BVf2')] },
  { kind: 'login', round: 3, items: [ai('BVai1')] },
  {
    kind: 'guest',
    round: 1,
    items: [
      makeItem('BVgai1', '大模型评测', 500, '路人甲'),
      makeItem('BVgai2', '大模型评测', 501, '路人乙'),
      ...Array.from({ length: 7 }, (_, i) => game(`BVgg${i}`)),
      food('BVgf1'),
    ],
  },
];

test('summary：归因结构完整，rounds 按轮次去重', async () => {
  const r = await summaryOf(DOMINANT_UP_EXPOSURE);
  assert.equal(r.ok, true);
  assert.equal(r.rounds, 3);
  assert.equal('attributionError' in r, false);

  const entry = r.attribution.find((a) => a.id === 'ai');
  assert.ok(entry, 'ai 主题应被归因');
  assert.equal(entry.name, 'AI / 大模型');
  assert.equal(entry.ratio, 2.5);
  assert.equal(entry.loginShare, 0.5);
  assert.equal(entry.guestShare, 0.2);
  assert.equal(entry.appearances, 5);
  assert.equal(entry.uniqueBvids, 2);
  assert.equal(entry.repeatRate, 0.6);

  assert.deepEqual(entry.topUps, [{ mid: 100, name: 'UP甲', n: 5, share: 1 }]);
  assert.ok(entry.topVideos.length <= 3);
  assert.equal(entry.topVideos[0].bvid, 'BVai1');
  assert.equal(entry.topVideos[0].rounds, 3);
  assert.equal(entry.topVideos[0].title, '大模型评测');
  assert.equal(entry.topVideos[0].upName, 'UP甲');
  assert.equal(entry.topVideos[0].mid, 100);
  assert.equal(entry.topVideos[0].url, 'https://www.bilibili.com/video/BVai1');
  assert.equal(entry.topVideos[1].bvid, 'BVai2');
  assert.equal(entry.topVideos[1].rounds, 2);
});

test('summary：ratio 不超过 1.2 的主题不进归因', async () => {
  const r = await summaryOf(DOMINANT_UP_EXPOSURE);
  assert.equal(r.ok, true);

  const gameRow = r.amplification.find((a) => a.id === 'game');
  assert.ok(gameRow);
  assert.ok(gameRow.ratio !== null && gameRow.ratio <= 1.2);
  assert.equal(r.attribution.some((a) => a.id === 'game'), false);
  assert.equal(r.attribution.some((a) => a.id === 'food'), true);

  for (const entry of r.attribution) {
    assert.ok(entry.ratio > 1.2);
  }
});

test('summary：归因最多 3 条', async () => {
  const exposure = [
    {
      kind: 'login',
      round: 1,
      items: [
        ai('BVa1'),
        ai('BVa2'),
        ai('BVa3'),
        ai('BVa4'),
        game('BVg1'),
        game('BVg2'),
        game('BVg3'),
        food('BVf1'),
        food('BVf2'),
        knowledge('BVk1'),
      ],
    },
    {
      kind: 'guest',
      round: 1,
      items: [
        ai('BVga1'),
        ai('BVga2'),
        ai('BVga3'),
        ai('BVga4'),
        game('BVgg1'),
        game('BVgg2'),
        game('BVgg3'),
        food('BVgf1'),
        food('BVgf2'),
        knowledge('BVgk1'),
        ...Array.from({ length: 6 }, (_, i) => makeItem(`BVl${i}`, '生活日常', 600 + i, '生活UP')),
      ],
    },
  ];
  const r = await summaryOf(exposure);
  assert.equal(r.ok, true);
  assert.equal(r.attribution.length, 3);
  assert.deepEqual(
    r.attribution.map((a) => a.id),
    ['ai', 'game', 'food'],
  );
  assert.equal(r.amplification.find((a) => a.id === 'knowledge').ratio, 1.6);
});

test('summary：空 exposure 表返回 ok:false 而不是抛异常', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cocoon-summary-'));
  const file = path.join(dir, 'cocoon.db');
  const store = openStore(file);
  closeStore(store);

  try {
    const r = await buildSummary(file);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.match(r.error, /exposure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summary：advice 在单一 UP 主导时为 narrow', async () => {
  const r = await summaryOf(DOMINANT_UP_EXPOSURE);
  assert.equal(r.ok, true);
  assert.equal(r.advice.kind, 'narrow');
  assert.equal(r.advice.theme, 'ai');
  assert.equal(r.advice.name, 'AI / 大模型');
  assert.equal(r.advice.ratio, 2.5);
  // The sentence quotes the multiple the badge shows: 2/7 of the login videos
  // over 2/10 of the guest videos = 1.43, not the 2.50 row ratio.
  assert.equal(r.advice.ratioDedup, 1.43);
  assert.match(r.advice.text, /50\.0%/);
  assert.match(r.advice.text, /1\.43 倍/);
  assert.ok(!r.advice.text.includes('2.50'), r.advice.text);
  assert.ok(r.advice.text.includes('UP甲'));
  assert.ok(r.advice.text.includes('重复曝光 3 次'));
  assert.ok(r.advice.text.includes('想收窄'));
});

test('summary：advice 在没有单一 UP 主导时为 watch', async () => {
  const exposure = [
    {
      kind: 'login',
      round: 1,
      items: [
        ai('BVb1', 100, 'UP甲'),
        ai('BVb2', 101, 'UP乙'),
        ai('BVb3', 102, 'UP丙'),
        ai('BVb4', 103, 'UP丁'),
        ai('BVb5', null, '散人UP'),
        ai('BVb6', null, null),
        game('BVg1'),
        game('BVg2'),
        game('BVg3'),
        game('BVg4'),
      ],
    },
    {
      kind: 'guest',
      round: 1,
      items: [
        makeItem('BVgai1', '大模型评测', 500, '路人甲'),
        makeItem('BVgai2', '大模型评测', 501, '路人乙'),
        ...Array.from({ length: 8 }, (_, i) => game(`BVgg${i}`)),
      ],
    },
  ];
  const r = await summaryOf(exposure);
  assert.equal(r.ok, true);
  assert.equal(r.advice.kind, 'watch');
  assert.equal(r.advice.theme, 'ai');
  assert.equal(r.advice.ratio, 3);
  assert.ok(r.advice.text.includes('没有单一 UP 主主导'));
  assert.ok(r.advice.text.includes('60.0%'));

  const entry = r.attribution.find((a) => a.id === 'ai');
  assert.equal(entry.topUps.length, 3);
  assert.ok(entry.topUps.every((up) => up.mid !== null || up.name !== null));
  assert.equal(entry.topUps[0].share, 0.1667);
});

test('summary：UP 信息缺失时原样透出 null，双空跳过', async () => {
  const exposure = [
    {
      kind: 'login',
      round: 1,
      items: [
        ai('BVn1', null, '散人UP'),
        ai('BVn2', 100, 'UP甲'),
        ai('BVn3', null, null),
        ...Array.from({ length: 7 }, (_, i) => game(`BVng${i}`)),
      ],
    },
    {
      kind: 'guest',
      round: 1,
      items: [
        makeItem('BVgn1', '大模型评测', 500, '路人甲'),
        makeItem('BVgn2', '大模型评测', 501, '路人乙'),
        ...Array.from({ length: 8 }, (_, i) => game(`BVgg${i}`)),
      ],
    },
  ];
  const r = await summaryOf(exposure);
  assert.equal(r.ok, true);

  const entry = r.attribution.find((a) => a.id === 'ai');
  assert.equal(entry.appearances, 3);
  assert.equal(entry.uniqueBvids, 3);
  assert.equal(entry.topUps.length, 2);
  assert.ok(entry.topUps.some((up) => up.mid === null && up.name === '散人UP'));
  assert.ok(entry.topUps.every((up) => up.mid !== null || up.name !== null));
  assert.ok(entry.topUps.every((up) => up.share === 0.3333));

  const bare = entry.topVideos.find((v) => v.bvid === 'BVn3');
  assert.equal(bare.title, '大模型评测');
  assert.equal(bare.upName, null);
  assert.equal(bare.mid, null);
  assert.equal(bare.url, 'https://www.bilibili.com/video/BVn3');
});

test('summary：没有归因主题时 advice 为 null', async () => {
  const exposure = [
    {
      kind: 'login',
      round: 1,
      items: [ai('BVc1'), ai('BVc2'), game('BVcg1'), game('BVcg2'), food('BVcf1')],
    },
    {
      kind: 'guest',
      round: 1,
      items: [ai('BVcg1'), ai('BVcg2'), game('BVc1'), game('BVc2'), food('BVcf1')],
    },
  ];
  const r = await summaryOf(exposure);
  assert.equal(r.ok, true);
  assert.deepEqual(r.attribution, []);
  assert.equal(r.advice, null);
});

// login total 25: ai 20, game 4, screen 1. guest total 100: ai 50, game 49, screen 1.
// The highest ratio is screen (4.00) but the biggest gap is ai (0.30), so the
// headline and the advice must both land on ai.
const HEADLINE_VS_RATIO_EXPOSURE = [
  {
    kind: 'login',
    round: 1,
    items: Array.from({ length: 20 }, (_, i) => ai(`BVla${i}`)),
  },
  {
    kind: 'login',
    round: 2,
    items: [
      ...Array.from({ length: 4 }, (_, i) => game(`BVlg${i}`)),
      makeItem('BVls1', '动漫解说'),
    ],
  },
  {
    kind: 'guest',
    round: 1,
    items: [
      ...Array.from({ length: 50 }, (_, i) => makeItem(`BVga${i}`, '大模型评测', 500, '路人甲')),
      ...Array.from({ length: 49 }, (_, i) => game(`BVgg${i}`)),
      makeItem('BVgs1', '动漫解说'),
    ],
  },
];

test('summary：advice 跟随 headline，而不是 ratio 最高的主题', async () => {
  const r = await summaryOf(HEADLINE_VS_RATIO_EXPOSURE);
  assert.equal(r.ok, true);

  assert.ok(r.headline);
  assert.equal(r.headline.id, 'ai');
  assert.equal(r.headline.ratio, 1.6);

  // The dataset really does have a ratio champion that is not the headline.
  const ratioTop = [...r.attribution].sort((a, b) => b.ratio - a.ratio)[0];
  assert.equal(ratioTop.id, 'screen');
  assert.equal(ratioTop.ratio, 4);

  const aiRow = r.amplification.find((a) => a.id === 'ai');
  const screenRow = r.amplification.find((a) => a.id === 'screen');
  assert.ok(aiRow.loginShare - aiRow.guestShare > screenRow.loginShare - screenRow.guestShare);

  assert.equal(r.advice.theme, 'ai');
  assert.equal(r.advice.name, 'AI / 大模型');
  assert.equal(r.advice.ratio, 1.6);
  assert.equal(r.advice.kind, 'narrow');
  assert.match(r.advice.text, /80\.0%/);
});

test('summary：归因抛错时降级返回 ok:true，其余字段照常', async () => {
  const restore = poisonAttribution();
  let r;
  try {
    r = await summaryOf(DOMINANT_UP_EXPOSURE);
  } finally {
    restore();
  }

  assert.equal(r.ok, true);
  assert.equal(r.date, DATE);
  assert.equal(r.rounds, 3);
  assert.ok(r.headline);
  assert.equal(r.headline.id, 'ai');
  assert.ok(r.login.top.length > 0);
  assert.ok(r.amplification.length > 0);

  assert.deepEqual(r.attribution, []);
  assert.equal(r.advice, null);
  assert.equal(r.attributionError, 'simulated attribution failure');
});

// ----------------------------------------------------------------------
// Weekly trend
// ----------------------------------------------------------------------

const TREND_END = '2026-11-02';

// 210 history rows: cocoonScore prefers history once it has at least 10 rows,
// so the trend samples count equals this length.
function historyDay(count = 210, marker = null) {
  return Array.from({ length: count }, (_, i) => ({
    bvid: `BVh${i}`,
    title: marker && i === 3 ? marker : ['大模型评测', '游戏攻略', '美食探店'][i % 3],
    mid: 700 + i,
    upName: `历史UP${i}`,
    tid: 1,
    tname: null,
  }));
}

function exposureFor(date) {
  return DOMINANT_UP_EXPOSURE.map((row) => ({ ...row, date }));
}

async function summaryOfDays(snapshots, exposures) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cocoon-summary-'));
  const file = path.join(dir, 'cocoon.db');
  const store = openStore(file);
  try {
    for (const day of snapshots) {
      saveSnapshot(store, day.date, day.feed ?? [], day.history ?? [], day.ranking ?? []);
    }
    for (const row of exposures) {
      saveExposure(store, row.date, row.kind, row.round, row.items);
    }
  } finally {
    closeStore(store);
  }
  try {
    return await buildSummary(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Same injection style as poisonAttribution: a keyword regex that only throws
// when reached from inside cocoonScore, so the summary path stays untouched.
function poisonTrendCocoon(marker = '毒样本') {
  const theme = THEMES.find((t) => t.id === 'ai');
  const poison = /__trend_cocoon_never_matches__/;
  poison.test = (text) => {
    if (String(text).includes(marker) && String(new Error().stack).includes('cocoonScore')) {
      throw new Error('simulated cocoon failure');
    }
    return false;
  };
  theme.keywords.push(poison);
  return () => {
    const index = theme.keywords.indexOf(poison);
    if (index !== -1) theme.keywords.splice(index, 1);
  };
}

test('trend：多天数据按日期升序，covered 与 points 一致', async () => {
  const dates = ['2026-10-31', '2026-11-01', TREND_END];
  const r = await summaryOfDays(
    [
      ...dates.map((date) => ({ date, history: historyDay() })),
      // Outside the 7-day window ending at TREND_END, so it must not show up.
      { date: '2026-10-20', history: historyDay(50) },
    ],
    dates.flatMap((date) => exposureFor(date)),
  );
  assert.equal(r.ok, true);
  assert.equal(r.date, TREND_END);
  assert.equal(r.trend.days, 7);
  assert.equal(r.trend.covered, 3);
  assert.deepEqual(
    r.trend.points.map((p) => p.date),
    dates,
  );

  for (const point of r.trend.points) {
    assert.equal(typeof point.cocoon, 'number');
    assert.ok(point.cocoon >= 0 && point.cocoon <= 100);
    assert.equal(point.cocoon, Number(point.cocoon.toFixed(1)));
    assert.equal(point.amplification, 2.5);
    assert.equal(point.themes, 3);
    assert.equal(point.samples, 210);
  }
});

test('trend：某天缺 snapshot 时 point 仍在、cocoon 为 null，其它天不受影响', async () => {
  const dates = ['2026-10-31', '2026-11-01', TREND_END];
  const r = await summaryOfDays(
    [
      { date: '2026-10-31', history: historyDay() },
      { date: TREND_END, history: historyDay() },
    ],
    dates.flatMap((date) => exposureFor(date)),
  );
  assert.equal(r.ok, true);
  assert.equal(r.trend.covered, 3);
  assert.deepEqual(
    r.trend.points.map((p) => p.date),
    dates,
  );

  const missing = r.trend.points[1];
  assert.equal(missing.date, '2026-11-01');
  assert.equal(missing.cocoon, null);
  // No snapshot, so samples falls back to the login exposure row count.
  assert.equal(missing.samples, 10);
  assert.equal(missing.amplification, 2.5);
  assert.equal(missing.themes, 3);

  for (const point of [r.trend.points[0], r.trend.points[2]]) {
    assert.equal(typeof point.cocoon, 'number');
    assert.equal(point.samples, 210);
  }
});

test('trend：只有一天数据时 points 长度 1、covered 1', async () => {
  const r = await summaryOfDays(
    [{ date: TREND_END, history: historyDay() }],
    exposureFor(TREND_END),
  );
  assert.equal(r.ok, true);
  assert.equal(r.trend.days, 7);
  assert.equal(r.trend.covered, 1);
  assert.equal(r.trend.points.length, 1);
  assert.equal(r.trend.points[0].date, TREND_END);
  assert.equal(typeof r.trend.points[0].cocoon, 'number');
  assert.equal(r.trend.points[0].samples, 210);
  assert.equal(r.trend.points[0].amplification, 2.5);
});

test('trend：样本不足的畸形数据该天降级为 null，point 仍保留', async () => {
  const r = await summaryOfDays(
    [
      // Only 3 history rows and no feed: below the history basis threshold, so
      // the day has no usable cocoon sample.
      { date: '2026-11-01', history: historyDay(3) },
      { date: TREND_END, history: historyDay() },
    ],
    exposureFor(TREND_END),
  );
  assert.equal(r.ok, true);
  assert.equal(r.trend.covered, 2);

  const thin = r.trend.points[0];
  assert.equal(thin.date, '2026-11-01');
  assert.equal(thin.cocoon, null);
  assert.equal(thin.samples, 0);
  assert.equal(thin.amplification, null);
  assert.equal(thin.themes, null);

  const healthy = r.trend.points[1];
  assert.equal(typeof healthy.cocoon, 'number');
  assert.equal(healthy.samples, 210);
});

test('trend：单天 cocoonScore 抛错时该天降级为 null，summary 其余字段照常', async () => {
  const dates = ['2026-10-31', '2026-11-01', TREND_END];
  const restore = poisonTrendCocoon();
  let r;
  try {
    r = await summaryOfDays(
      [
        { date: '2026-10-31', history: historyDay() },
        { date: '2026-11-01', history: historyDay(210, '毒样本') },
        { date: TREND_END, history: historyDay() },
      ],
      dates.flatMap((date) => exposureFor(date)),
    );
  } finally {
    restore();
  }

  assert.equal(r.ok, true);
  assert.equal('trendError' in r, false);
  assert.deepEqual(
    r.trend.points.map((p) => p.date),
    dates,
  );

  const poisoned = r.trend.points[1];
  assert.equal(poisoned.cocoon, null);
  assert.equal(poisoned.samples, 10);
  assert.equal(poisoned.amplification, 2.5);
  assert.equal(poisoned.themes, 3);

  assert.equal(typeof r.trend.points[0].cocoon, 'number');
  assert.equal(typeof r.trend.points[2].cocoon, 'number');

  // The daily summary itself is unaffected by the trend failure.
  assert.equal(r.login.count, 10);
  assert.equal(r.guest.count, 10);
  assert.equal(r.headline.ratio, 2.5);
  assert.equal(r.advice.kind, 'narrow');
});

// ----------------------------------------------------------------------
// Tag evidence in the metric layer
// ----------------------------------------------------------------------

test('trendItems：把 video_tag 证据接到 cocoonScore 的 item 上', () => {
  const rows = [
    { source: 'history', bvid: 'BVh1', title: '这段正片', tname: null },
    { source: 'history', bvid: 'BVh2', title: '随便看看', tname: null },
  ];
  const tagMap = new Map([['BVh1', ['火影忍者']]]);
  const items = trendItems(rows, tagMap);

  assert.equal(items[0].source, 'history');
  assert.equal(items[0].title, '这段正片');
  assert.deepEqual(items[0].tags, ['火影忍者']);
  // A bvid without a backfilled row gets an empty list, not a missing key.
  assert.deepEqual(items[1].tags, []);

  assert.equal(classifyTheme(items[0].title, items[0].tname, items[0].tags), 'screen');
  assert.equal(cocoonScore({ feed: items, history: [], ranking: [] }).themes.unclassified, 1);
});

test('summary：history 主题份额同样吃 video_tag（bvid 必须被查出来）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cocoon-summary-'));
  const file = path.join(dir, 'cocoon.db');
  const store = openStore(file);
  try {
    saveSnapshot(
      store,
      TREND_END,
      [],
      [
        { bvid: 'BVh1', title: '这段正片', mid: 1, upName: 'UP1', tid: 1, tname: null },
        { bvid: 'BVh2', title: '随便看看', mid: 2, upName: 'UP2', tid: 1, tname: null },
      ],
      [],
    );
    for (const row of exposureFor(TREND_END)) saveExposure(store, row.date, row.kind, row.round, row.items);
    saveVideoTags(store, 'BVh1', { tags: ['火影忍者', '写轮眼'], tagIds: [1, 2] });
    saveVideoTags(store, 'BVh2', { tags: ['comfyui'], tagIds: [3] });
  } finally {
    closeStore(store);
  }

  try {
    const r = await buildSummary(file);
    assert.equal(r.ok, true);
    assert.equal(r.history.count, 2);
    assert.equal(r.history.coverage, 1);
    assert.ok(r.history.top.some((t) => t.id === 'screen'));
    assert.ok(r.history.top.some((t) => t.id === 'ai'));
    // historyShare in the amplification table must come from the same verdicts.
    const ai = r.amplification.find((a) => a.id === 'ai');
    assert.equal(ai.historyShare, 0.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trend：cocoon 用 video_tag 证据判主题，但 index 不受影响（分区/UP 决定）', async () => {
  const history = Array.from({ length: 210 }, (_, i) => ({
    bvid: `BVs${i}`,
    title: '这段正片',
    mid: 900 + i,
    upName: `历史UP${i}`,
    tid: 1,
    tname: null,
  }));
  const taggedHistory = history.map((row) => ({ ...row, tags: ['火影忍者'] }));

  const dir = mkdtempSync(path.join(tmpdir(), 'cocoon-summary-'));
  const file = path.join(dir, 'cocoon.db');
  const store = openStore(file);
  try {
    saveSnapshot(store, TREND_END, [], history, []);
    for (const row of exposureFor(TREND_END)) saveExposure(store, row.date, row.kind, row.round, row.items);
    for (const row of history) saveVideoTags(store, row.bvid, { tags: ['火影忍者'], tagIds: [1] });
  } finally {
    closeStore(store);
  }

  try {
    const r = await buildSummary(file);
    assert.equal(r.ok, true);
    const point = r.trend.points[0];
    assert.equal(point.date, TREND_END);
    assert.equal(point.samples, 210);

    // What the trend must equal: cocoonScore over the same rows with tag
    // evidence attached (i.e. the new口径 for themes).
    const direct = cocoonScore({ feed: [], history: taggedHistory, ranking: [], date: TREND_END }, { date: TREND_END });
    assert.equal(point.cocoon, Number(direct.index.toFixed(1)));
    assert.equal(direct.themes.unclassified, 0);

    // index is region entropy + HHI + uploader Gini, so theme evidence (and
    // therefore tags) cannot move it: old and new口径 share the same number.
    const untagged = cocoonScore({ feed: [], history, ranking: [], date: TREND_END }, { date: TREND_END });
    assert.equal(untagged.index, direct.index);
    assert.equal(untagged.themes.unclassified, 210);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------
// video_tag data layer
// ----------------------------------------------------------------------

// Injected fetch: no test touches the network. requestJson only reads
// `status` and `text()`, and limitedFetch calls an injected impl directly.
function mockFetch(payload, { throws = null } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (throws) throw throws;
    const body = typeof payload === 'function' ? payload(String(url)) : payload;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  impl.calls = calls;
  return impl;
}

async function withStore(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cocoon-tags-'));
  const file = path.join(dir, 'cocoon.db');
  const store = openStore(file);
  try {
    return await fn(store, file);
  } finally {
    closeStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('fetchVideoTags：解析出 tags/tagIds，去重排序并丢掉 tag_id=0', async () => {
  const fetchImpl = mockFetch({
    code: 0,
    message: '0',
    data: [
      { tag_id: 0, tag_name: '伪tag' },
      { tag_id: 30, tag_name: '游戏' },
      { tag_id: 10, tag_name: 'AI' },
      { tag_id: 12, tag_name: 'AI' },
      { tag_id: 20, tag_name: '  单机游戏  ' },
      { tag_id: 40, tag_name: '   ' },
      null,
      'junk',
    ],
  });

  const r = await fetchVideoTags('BV1pkxi66ErX', { fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tags, ['AI', '单机游戏', '游戏']);
  assert.deepEqual(r.tagIds, [10, 20, 30]);

  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0], /^https:\/\/api\.bilibili\.com\/x\/tag\/archive\/tags\?/);
  assert.match(fetchImpl.calls[0], /bvid=BV1pkxi66ErX/);
});

test('fetchVideoTags：同样 tag 集合顺序抖动时输出一致', async () => {
  const a = await fetchVideoTags(
    'BV1pkxi66ErX',
    { fetchImpl: mockFetch({ code: 0, data: [{ tag_id: 2, tag_name: 'b' }, { tag_id: 1, tag_name: 'a' }] }) },
  );
  const b = await fetchVideoTags(
    'BV1pkxi66ErX',
    { fetchImpl: mockFetch({ code: 0, data: [{ tag_id: 1, tag_name: 'a' }, { tag_id: 2, tag_name: 'b' }] }) },
  );
  assert.deepEqual(a, b);
  assert.deepEqual(a.tags, ['a', 'b']);
  assert.deepEqual(a.tagIds, [1, 2]);
});

test('fetchVideoTags：code=-400 返回 ok:false 而不是抛异常', async () => {
  const fetchImpl = mockFetch({ code: -400, message: '请求错误' });
  const r = await fetchVideoTags('BV1pkxi66ErX', { fetchImpl });

  assert.equal(r.ok, false);
  assert.equal(r.code, -400);
  assert.match(r.error, /-400/);
  assert.match(r.error, /请求错误/);
  assert.ok(!r.network);
});

test('fetchVideoTags：网络层异常返回 ok:false + network:true', async () => {
  const fetchImpl = mockFetch(null, { throws: new Error('ECONNRESET') });
  const r = await fetchVideoTags('BV1pkxi66ErX', { fetchImpl });

  assert.equal(r.ok, false);
  assert.equal(r.network, true);
  assert.match(r.error, /ECONNRESET/);
});

test('fetchVideoTags：av 型记录走 aid，无效引用不发请求', async () => {
  const payload = { code: 0, data: [{ tag_id: 11472973, tag_name: '官方知识付费内容' }] };

  const fromAvString = mockFetch(payload);
  const r1 = await fetchVideoTags('av992186504', { fetchImpl: fromAvString });
  assert.equal(r1.ok, true);
  assert.match(fromAvString.calls[0], /aid=992186504/);
  assert.deepEqual(r1.tags, ['官方知识付费内容']);

  const fromAid = mockFetch(payload);
  const r2 = await fetchVideoTags({ aid: 992186504 }, { fetchImpl: fromAid });
  assert.equal(r2.ok, true);
  assert.match(fromAid.calls[0], /aid=992186504/);

  const fromBvid = mockFetch(payload);
  const r3 = await fetchVideoTags({ bvid: 'BV1pkxi66ErX' }, { fetchImpl: fromBvid });
  assert.equal(r3.ok, true);
  assert.match(fromBvid.calls[0], /bvid=BV1pkxi66ErX/);

  const idle = mockFetch(payload);
  for (const bad of ['', '   ', null, undefined, {}, { bvid: '  ' }, 'not-a-video']) {
    const r = await fetchVideoTags(bad, { fetchImpl: idle });
    assert.equal(r.ok, false, `引用 ${JSON.stringify(bad)} 应判为无效`);
  }
  assert.equal(idle.calls.length, 0);
});

test('saveVideoTags：upsert 覆盖旧值、attempts 递增、tag 去重排序', async () => {
  await withStore((store) => {
    const first = saveVideoTags(store, 'BV1pkxi66ErX', {
      tags: ['游戏', 'AI', 'AI'],
      tagIds: [30, 10, 12],
    });
    assert.equal(first.ok, true);
    assert.equal(first.attempts, 1);
    assert.deepEqual(first.tags, ['AI', '游戏']);
    assert.deepEqual(first.tagIds, [10, 30]);
    assert.equal(first.lastError, null);

    const second = saveVideoTags(store, 'BV1pkxi66ErX', { tags: ['音乐'], tagIds: [5] });
    assert.equal(second.ok, true);
    assert.equal(second.attempts, 2);
    assert.deepEqual(second.tags, ['音乐']);
    assert.deepEqual(second.tagIds, [5]);

    const map = listVideoTags(store, ['BV1pkxi66ErX']);
    assert.equal(map.size, 1);
    assert.deepEqual(map.get('BV1pkxi66ErX').tags, ['音乐']);
    assert.equal(map.get('BV1pkxi66ErX').attempts, 2);
  });
});

test('saveVideoTags：失败写入不覆盖已有成功数据', async () => {
  await withStore((store) => {
    saveVideoTags(store, 'BVsaved', { tags: ['游戏', 'AI'], tagIds: [30, 10] });

    const failed = saveVideoTags(store, 'BVsaved', {}, 'B站返回 code=-400 msg=请求错误');
    assert.equal(failed.ok, false);
    assert.equal(failed.attempts, 2);
    // Stored order is sorted by name, so id 10 stays paired with 'AI'.
    assert.deepEqual(failed.tags, ['AI', '游戏'], '失败不能清空已成功的 tags');
    assert.deepEqual(failed.tagIds, [10, 30], '失败不能清空已成功的 tagIds');
    assert.match(failed.lastError, /-400/);

    const kept = listVideoTags(store, ['BVsaved']).get('BVsaved');
    assert.deepEqual(kept.tags, ['AI', '游戏']);
    assert.match(kept.lastError, /-400/);

    // A later success clears the error flag again.
    const recovered = saveVideoTags(store, 'BVsaved', { tags: ['音乐'], tagIds: [5] });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.attempts, 3);
    assert.equal(recovered.lastError, null);
    assert.deepEqual(recovered.tags, ['音乐']);
  });
});

test('saveVideoTags：新 bvid 失败时 tags 为空、attempts 为 1', async () => {
  await withStore((store) => {
    const row = saveVideoTags(store, 'BVnew', {}, 'boom');
    assert.equal(row.ok, false);
    assert.equal(row.attempts, 1);
    assert.deepEqual(row.tags, []);
    assert.deepEqual(row.tagIds, []);
    assert.equal(row.lastError, 'boom');
    assert.equal(typeof row.fetchedAt, 'number');
  });
});

test('listVideoTags：批量查询只返回命中的 bvid，保持入参顺序', async () => {
  await withStore((store) => {
    saveVideoTags(store, 'BV1', { tags: ['a'], tagIds: [1] });
    saveVideoTags(store, 'BV2', { tags: ['b', 'c'], tagIds: [2, 3] });
    saveVideoTags(store, 'BV3', {}, 'boom');

    const some = listVideoTags(store, ['BV2', 'BVmissing', 'BV3']);
    assert.deepEqual([...some.keys()], ['BV2', 'BV3']);
    assert.deepEqual(some.get('BV2').tags, ['b', 'c']);
    assert.deepEqual(some.get('BV2').tagIds, [2, 3]);
    assert.deepEqual(some.get('BV3').tags, []);
    assert.equal(some.get('BV3').lastError, 'boom');

    assert.equal(listVideoTags(store, []).size, 0);
    assert.equal(listVideoTags(store, ['BVnone']).size, 0);

    const all = listVideoTags(store);
    assert.equal(all.size, 3);
    assert.deepEqual([...all.keys()], ['BV1', 'BV2', 'BV3']);
  });
});

test('countVideoTags：分别统计成功 / 失败 / 成功但无 tag', async () => {
  await withStore((store) => {
    assert.deepEqual(countVideoTags(store), { total: 0, ok: 0, failed: 0, empty: 0 });

    saveVideoTags(store, 'BV1', { tags: ['a'], tagIds: [1] });
    saveVideoTags(store, 'BV2', { tags: [], tagIds: [] });
    saveVideoTags(store, 'BV3', {}, 'boom');
    assert.deepEqual(countVideoTags(store), { total: 3, ok: 2, failed: 1, empty: 1 });

    saveVideoTags(store, 'BV3', { tags: ['c'], tagIds: [9] });
    assert.deepEqual(countVideoTags(store), { total: 3, ok: 3, failed: 0, empty: 1 });
  });
});

test('video_tag：不影响 snapshot/exposure 的读写', async () => {
  await withStore((store, file) => {
    saveSnapshot(store, DATE, [makeItem('BVa', '标签测试')], [], []);
    saveExposure(store, DATE, 'login', 1, [makeItem('BVa', '标签测试')]);
    saveVideoTags(store, 'BVa', { tags: ['测试'], tagIds: [7] });

    const snap = store.db.prepare('SELECT * FROM snapshot WHERE bvid = ?').get('BVa');
    assert.equal(snap.tags, '[]');
    assert.equal('video_tag' in snap, false);
    assert.equal(snap.title, '标签测试');

    const expo = store.db.prepare('SELECT * FROM exposure WHERE bvid = ?').get('BVa');
    assert.equal(expo.title, '标签测试');
    assert.deepEqual(listVideoTags(store, ['BVa']).get('BVa').tags, ['测试']);

    assert.equal(typeof file, 'string');
  });
});

// ----------------------------------------------------------------------
// Dedup measure and feed focus
// ----------------------------------------------------------------------

// login: 6 distinct rows (ai 4, game 2). guest: 8 rows over 3 distinct game
// videos + 2 distinct ai videos, i.e. 5 distinct videos in total. The guest rows
// repeat, so the row measure dilutes the ai share (2/8 = 0.25) while the dedup
// measure does not (2/5 = 0.40).
const REPEAT_HEAVY_EXPOSURE = [
  {
    kind: 'login',
    round: 1,
    items: [ai('BVla1'), ai('BVla2'), ai('BVla3'), ai('BVla4'), game('BVlg1'), game('BVlg2')],
  },
  {
    kind: 'guest',
    round: 1,
    items: [
      makeItem('BVga1', '大模型评测', 500, '路人甲'),
      makeItem('BVga2', '大模型评测', 501, '路人乙'),
      game('BVgg1', 200, '游戏UP'),
      game('BVgg2', 200, '游戏UP'),
      game('BVgg3', 200, '游戏UP'),
    ],
  },
  {
    kind: 'guest',
    round: 2,
    items: [game('BVgg1', 200, '游戏UP'), game('BVgg2', 200, '游戏UP'), game('BVgg3', 200, '游戏UP')],
  },
];

test('summary：amplification 与 headline 同时给出行数口径和去重口径倍数', async () => {
  const r = await summaryOf(REPEAT_HEAVY_EXPOSURE);
  assert.equal(r.ok, true);

  for (const row of r.amplification) {
    assert.ok(Object.hasOwn(row, 'ratioDedup'), `${row.id} 缺 ratioDedup`);
    assert.ok(Object.hasOwn(row, 'ratio'), `${row.id} 缺 ratio`);
  }

  const aiRow = r.amplification.find((a) => a.id === 'ai');
  assert.equal(aiRow.loginShare, 0.6667);
  assert.equal(aiRow.guestShare, 0.25);
  assert.equal(aiRow.loginShareDedup, 0.6667);
  assert.equal(aiRow.guestShareDedup, 0.4);
  assert.equal(aiRow.ratio, 2.67);
  assert.equal(aiRow.ratioDedup, 1.67);
  assert.ok(aiRow.ratioDedup < aiRow.ratio);

  const gameRow = r.amplification.find((a) => a.id === 'game');
  assert.equal(gameRow.ratio, 0.44);
  assert.equal(gameRow.ratioDedup, 0.56);

  // Headline selection is unchanged (largest login-guest gap) and now carries
  // the dedup ratio next to the row ratio.
  assert.equal(r.headline.id, 'ai');
  assert.equal(r.headline.ratio, 2.67);
  assert.equal(r.headline.ratioDedup, 1.67);

  // Attribution still keys off the row ratio, so its thresholds did not move.
  assert.equal(r.attribution.some((a) => a.id === 'ai'), true);
});

test('summary：feedFocus 结构完整，units 是去重后的视频数', async () => {
  const r = await summaryOf(REPEAT_HEAVY_EXPOSURE);
  assert.equal(r.ok, true);
  assert.equal('feedFocusError' in r, false);

  const focus = r.feedFocus;
  assert.ok(focus, 'feedFocus 应被算出来');
  assert.deepEqual(Object.keys(focus).sort(), [
    'effectiveThemes',
    'repeatRate',
    'top',
    'top3Share',
    'totalThemes',
    'units',
  ]);
  assert.deepEqual(Object.keys(focus.top).sort(), [
    'baselineShare',
    'baselineShareRows',
    'id',
    'name',
    'ratio',
    'ratioDedup',
    'share',
  ]);

  assert.equal(focus.top.id, 'ai');
  assert.equal(focus.top.name, 'AI / 大模型');
  assert.equal(focus.top.share, 0.6667);
  // Both shares are the dedup measure, so the multiple is exactly these two
  // divided; the row baseline survives only as a diagnostic.
  assert.equal(focus.top.baselineShare, 0.4);
  assert.equal(focus.top.baselineShareRows, 0.25);
  assert.equal(focus.top.ratio, 2.67);
  assert.equal(focus.top.ratioDedup, 1.67);
  assert.equal(
    Number((focus.top.share / focus.top.baselineShare).toFixed(2)),
    focus.top.ratioDedup,
  );

  // Two themes cover the whole login feed.
  assert.equal(focus.top3Share, 1);
  // exp(entropy) over the login dedup counts: 4 ai + 2 game.
  assert.equal(focus.effectiveThemes, 1.89);
  assert.equal(focus.totalThemes, THEMES.length);

  // 6 login rows = 6 videos, 8 guest rows = 5 videos.
  assert.deepEqual(focus.units, { login: 6, guest: 5 });
  assert.deepEqual(focus.repeatRate, { login: 0, guest: 0.38 });
});

test('summary：feedFocus 算不出来时为 null，其余字段照常', async () => {
  const exposure = [
    {
      kind: 'login',
      round: 1,
      items: [makeItem('BVn1', '挤爆了'), makeItem('BVn2', '随便看看')],
    },
    { kind: 'guest', round: 1, items: [ai('BVga1'), ai('BVga2')] },
  ];
  const r = await summaryOf(exposure);

  assert.equal(r.ok, true);
  assert.equal(r.feedFocus, null);
  assert.equal('feedFocusError' in r, false);
  assert.equal(r.login.count, 2);
  assert.equal(r.guest.count, 2);
  assert.ok(Array.isArray(r.amplification));
  assert.ok(r.trend);
});

test('trend：每个 point 带 basis，标明该点采样自观看历史还是首页 feed', async () => {
  const feedDay = (count) =>
    Array.from({ length: count }, (_, i) => ({
      bvid: `BVf${i}`,
      title: ['大模型评测', '游戏攻略', '美食探店'][i % 3],
      mid: 800 + i,
      upName: `推荐UP${i}`,
      tid: 1,
      tname: null,
    }));

  const r = await summaryOfDays(
    [
      { date: '2026-10-31', history: historyDay() },
      // rcmd rows only: below the history threshold, so the point is feed-based.
      { date: '2026-11-01', feed: feedDay(12) },
      // Three history rows and no feed: no usable sample at all.
      { date: TREND_END, history: historyDay(3) },
    ],
    exposureFor(TREND_END),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.trend.points.map((p) => p.date),
    ['2026-10-31', '2026-11-01', TREND_END],
  );
  assert.deepEqual(
    r.trend.points.map((p) => p.basis),
    ['history', 'feed', null],
  );
  assert.equal(r.trend.points[0].samples, 210);
  assert.equal(r.trend.points[1].samples, 12);
  assert.equal(r.trend.points[1].cocoon, Number(r.trend.points[1].cocoon));
  assert.equal(r.trend.points[2].cocoon, null);
  // A point with no usable sample must not claim a basis either.
  assert.equal(r.trend.points[2].basis, null);
});

