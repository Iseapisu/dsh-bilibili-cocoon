// Unit tests for metrics, theme classification and report rendering.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  shannonEntropy,
  normalizedEntropy,
  hhi,
  gini,
  topShare,
  jaccard,
  jsDivergence,
  effectiveCategories,
  categoryCounts,
  uploaderCounts,
  reasonMix,
  cocoonScore,
  MAX_CATEGORIES,
} from '../src/metrics.js';
import { renderReport } from '../src/report.js';
import { UNCLASSIFIED, classifyTheme } from '../src/themes.js';

function closeTo(actual, expected, eps = 1e-9, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${message} expected ${expected} ± ${eps}, got ${actual}`,
  );
}

function loadFixture(name) {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

function makeItem(index, overrides = {}) {
  return {
    bvid: `BV1Test${String(index).padStart(5, '0')}`,
    aid: 100000 + index,
    title: `测试视频 ${index}`,
    mid: 100 + index,
    upName: `UP${index}`,
    tid: 1,
    tname: '游戏',
    tags: ['测试'],
    duration: 300,
    pubdate: 1730000000,
    rcmdReason: null,
    view: 1000,
    like: 100,
    source: 'rcmd',
    ...overrides,
  };
}

const PARENTS = ['动画', '音乐', '游戏', '娱乐', '电视剧', '电影', '知识', '鬼畜', '舞蹈', '时尚', '生活', '纪录片'];

test('shannonEntropy：空 / 单元素为 0，均匀分布为 ln(K)', () => {
  assert.equal(shannonEntropy([]), 0);
  assert.equal(shannonEntropy([0, 0, 0]), 0);
  assert.equal(shannonEntropy([5]), 0);
  closeTo(shannonEntropy([1, 1, 1, 1]), Math.log(4), 1e-12);
  closeTo(shannonEntropy([8, 2]), 0.5004024235381879, 1e-12);
});

test('normalizedEntropy：默认除以 ln(19)，传 k 时可退回旧口径', () => {
  assert.equal(normalizedEntropy([]), 0);
  assert.equal(normalizedEntropy([9]), 0);
  assert.equal(normalizedEntropy([9, 0, 0]), 0);
  closeTo(normalizedEntropy(Array(MAX_CATEGORIES).fill(1)), 1, 1e-12);
  closeTo(normalizedEntropy([2, 2, 2]), Math.log(3) / Math.log(19), 1e-12);
  closeTo(normalizedEntropy([2, 2, 2], 3), 1, 1e-12);
  closeTo(normalizedEntropy([8, 2], 2), 0.7219280948873623, 1e-12);
});

test('hhi：单来源为 1，四等分为 0.25', () => {
  assert.equal(hhi([]), 0);
  assert.equal(hhi([0, 0]), 0);
  assert.equal(hhi([10]), 1);
  closeTo(hhi([1, 1, 1, 1]), 0.25);
  closeTo(hhi([3, 1]), 0.625);
});

test('gini：完全平均为 0，极端集中为 (n-1)/n', () => {
  assert.equal(gini([]), 0);
  assert.equal(gini([0, 0, 0]), 0);
  assert.equal(gini([5, 5, 5]), 0);
  closeTo(gini([1, 1, 1, 1]), 0);
  closeTo(gini([0, 0, 0, 10]), 0.75);
  closeTo(gini([0, 0, 0, 0, 10]), 0.8);
});

test('topShare：前 k 占比，k 越界安全', () => {
  assert.equal(topShare([]), 0);
  assert.equal(topShare([5, 3, 2], 1), 0.5);
  closeTo(topShare([5, 3, 2], 2), 0.8);
  closeTo(topShare([5, 3, 2], 10), 1);
  assert.equal(topShare([5, 3, 2], 0), 0);
});

test('jaccard：双空为 1、单空为 0', () => {
  assert.equal(jaccard([], []), 1);
  assert.equal(jaccard(['a'], []), 0);
  closeTo(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
});

test('effectiveCategories：均匀 4 类 → 4；单类 → 1', () => {
  closeTo(effectiveCategories([1, 1, 1, 1]), 4, 1e-12);
  closeTo(effectiveCategories([10]), 1, 1e-12);
  assert.equal(effectiveCategories([]), 1); // exp(0)
});

test('jsDivergence：同分布为 0，完全不同为 1', () => {
  const a = new Map([['游戏', 10]]);
  const a2 = new Map([['游戏', 10]]);
  const b = new Map([['知识', 10]]);
  closeTo(jsDivergence(a, a2), 0, 1e-12);
  closeTo(jsDivergence(a, b), 1, 1e-12);
  assert.equal(jsDivergence(new Map(), a), 0);
});

test('categoryCounts：二级分区折叠到一级，不认识的归「其他」', () => {
  const items = [
    makeItem(1, { tname: '单机游戏' }),
    makeItem(2, { tname: '手机游戏' }),
    makeItem(3, { tname: '美食记录' }),
    makeItem(4, { tname: '随便什么' }),
  ];
  const counts = categoryCounts(items);
  assert.equal(counts.get('游戏'), 2);
  assert.equal(counts.get('美食'), 1);
  assert.equal(counts.get('其他'), 1);
  assert.equal(counts.size, 3);
});

test('uploaderCounts：缺失 UP 不计数', () => {
  const items = [
    makeItem(1, { upName: '老番茄' }),
    makeItem(2, { upName: '老番茄' }),
    makeItem(3, { upName: null }),
  ];
  const ups = uploaderCounts(items);
  assert.equal(ups.get('老番茄'), 2);
  assert.equal(ups.size, 1);
});

test('reasonMix：rcmdReason 归四类，占比之和为 1', () => {
  const reasons = ['热门', '热门推荐', '相关推荐', '已关注', null, ''];
  const mix = reasonMix(reasons.map((r, i) => makeItem(i, { rcmdReason: r })));
  closeTo(mix.热门, 2 / 6);
  closeTo(mix.相关推荐, 1 / 6);
  closeTo(mix.关注, 1 / 6);
  closeTo(mix.其他, 2 / 6);
  assert.deepEqual(reasonMix([]), { 热门: 0, 相关推荐: 0, 关注: 0, 其他: 0 });
});

test('cocoonScore：同样输入两次调用完全一致（含 bootstrap 区间）', () => {
  const feed = loadFixture('feed.json');
  const ranking = loadFixture('ranking.json');
  const input = { feed, history: [], ranking, date: '2026-10-30' };
  const first = cocoonScore(input);
  const second = cocoonScore(input);
  assert.deepEqual(first, second);
  assert.equal(first.date, '2026-10-30');
  assert.equal(first.basis, 'feed');
});

test('cocoonScore：空输入不产出假结论', () => {
  const empty = cocoonScore({});
  assert.equal(empty.index, 0);
  assert.equal(empty.level, '无数据');
  assert.equal(empty.sampleSize, 0);
  assert.equal(Number.isNaN(empty.index), false);
});

test('cocoonScore：宽度单调 —— 开阔 < 偏窄 < 强茧房', () => {
  const openFeed = PARENTS.map((tname, i) => makeItem(i, { bvid: `BVopen${i}`, tname, upName: `UP${i}` }));
  const open = cocoonScore({ feed: openFeed, history: [], ranking: openFeed, date: '2026-10-30' });
  assert.equal(open.level, '开阔');

  const narrowFeed = Array.from({ length: 12 }, (_, i) =>
    makeItem(i, { bvid: `BVnarrow${i}`, tname: i < 6 ? '游戏' : '知识', upName: `UP${i}` }),
  );
  const narrow = cocoonScore({ feed: narrowFeed, history: [], date: '2026-10-30' });
  assert.ok(narrow.index > open.index, `narrow=${narrow.index} 应 > open=${open.index}`);

  const cocoonFeed = Array.from({ length: 12 }, (_, i) =>
    makeItem(i, { bvid: `BVcocoon${i}`, tname: '游戏', upName: '同一个UP' }),
  );
  const cocoon = cocoonScore({ feed: cocoonFeed, history: [], date: '2026-10-30' });
  assert.equal(cocoon.level, '强茧房');
  assert.ok(cocoon.index > narrow.index);

  assert.ok(cocoon.entropyNorm <= open.entropyNorm);
});

test('cocoonScore：样本优先用观看历史，且 index 严格由公式算出', () => {
  const feed = loadFixture('feed.json');
  const ranking = loadFixture('ranking.json');
  const history = Array.from({ length: 30 }, (_, i) =>
    makeItem(i, { bvid: `BVhist${i}`, tname: i < 20 ? '游戏' : '知识', upName: `UP${i % 5}` }),
  );

  const result = cocoonScore({ feed, history, ranking, date: '2026-10-30' });
  assert.equal(result.basis, 'history');
  assert.equal(result.sampleSize, 30);

  const expected = Math.round(
    (100 * (0.55 * (1 - result.entropyNorm) + 0.25 * result.hhi + 0.2 * result.gini) + Number.EPSILON) * 10,
  ) / 10;
  assert.equal(result.index, expected);
  assert.ok(result.index >= 0 && result.index <= 100);
  assert.ok(result.entropyCI[0] <= result.entropyNorm && result.entropyNorm <= result.entropyCI[1]);

  for (const value of Object.values(result.subscores)) {
    assert.ok(value >= 0 && value <= 100, `subscore 越界: ${value}`);
  }
});

test('fixtures：高集中 feed 被判为强茧房，且各口径自洽', () => {
  const feed = loadFixture('feed.json');
  const ranking = loadFixture('ranking.json');

  const requiredKeys = ['bvid', 'tid', 'tname', 'upName', 'rcmdReason', 'source'];
  for (const item of [...feed, ...ranking]) {
    for (const key of requiredKeys) {
      assert.ok(Object.hasOwn(item, key), `${item.bvid} 缺字段 ${key}`);
    }
  }

  const result = cocoonScore({ feed, history: [], ranking, date: '2026-10-30' });
  assert.equal(categoryCounts(feed).get('游戏'), 10);
  assert.ok(result.entropyNorm < 0.3, `entropyNorm=${result.entropyNorm}`);
  assert.ok(result.hhi > 0.5, `hhi=${result.hhi}`);
  assert.equal(result.level, '强茧房');
  assert.ok(result.index > 65, `index=${result.index}`);
  closeTo(result.overlapWithRanking, 0, 1e-9);
  closeTo(result.reasonMix.热门, 0.5, 1e-9);
});

test('renderReport：含结论、指标、建议；小样本给出提示', () => {
  const feed = loadFixture('feed.json');
  const ranking = loadFixture('ranking.json');
  const result = cocoonScore({ feed, history: [], ranking, date: '2026-10-30' });
  const markdown = renderReport(result);

  assert.ok(markdown.split('\n')[0].includes('结论'));
  assert.ok(markdown.includes('信息茧房指数'));
  assert.ok(markdown.includes(String(result.index)));
  assert.ok(markdown.includes(result.level));
  assert.ok(markdown.includes('多样性'));
  assert.ok(markdown.includes('集中度'));
  assert.ok(markdown.includes('可执行建议'));

  const shortResult = cocoonScore({ feed: feed.slice(0, 5), history: [], ranking, date: '2026-10-30' });
  assert.ok(renderReport(shortResult).includes('样本不足'));
});

test('classifyTheme：标题关键词优先，标题没信号时用二级分区兜底', () => {
  assert.equal(classifyTheme('DeepSeek V5 要来了，大模型又要更新'), 'ai');
  assert.equal(classifyTheme('全网最全的 GPT 提示词教程'), 'ai');
  assert.equal(classifyTheme('挤爆了', '日常'), 'life');
  assert.equal(classifyTheme('红烧肉', '美食记录'), 'food');
  assert.equal(classifyTheme('挤爆了'), UNCLASSIFIED);
  assert.equal(classifyTheme(''), UNCLASSIFIED);
  assert.equal(classifyTheme('RAID 阵列怎么配', '数码'), 'tech');
});

test('cocoonScore：主题浓度只统计已分类条目，未分类不进分母', () => {
  const items = [
    { ...makeItem(1), title: '大模型评测对比', tname: '计算机技术' },
    { ...makeItem(2), title: '又一个 AI 新闻', tname: '科技' },
    { ...makeItem(3), title: '红烧肉', tname: '美食记录' },
    { ...makeItem(4), title: '挤爆了', tname: null },
  ];
  const result = cocoonScore({ feed: items, history: items, ranking: [], date: '2026-11-02' });

  assert.equal(result.themes.unclassified, 1);
  closeTo(result.themes.coverage, 0.75, 1e-9);
  assert.equal(result.themes.topName, 'AI / 大模型');
  closeTo(result.themes.topShare, 2 / 3, 1e-3);
  assert.ok(result.themes.effective > 1 && result.themes.effective < 2.5, `effective=${result.themes.effective}`);
});
