// Unit tests for the host summary: attribution and deterministic advice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildSummary } from '../plugin/lib/index.js';
import { THEMES } from '../src/themes.js';
import { closeStore, openStore, saveExposure } from '../src/store.js';

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
  assert.match(r.advice.text, /50\.0%/);
  assert.match(r.advice.text, /2\.50 倍/);
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
