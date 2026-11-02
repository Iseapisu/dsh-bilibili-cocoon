// Unit tests for theme classification: the tag evidence level, its precedence
// against title/region, and the host wire-up that feeds it from video_tag.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildSummary } from '../plugin/lib/index.js';
import { classifyTheme, TAG_KEYWORDS, THEMES, UNCLASSIFIED } from '../src/themes.js';
import {
  closeStore,
  openStore,
  saveExposure,
  saveVideoTags,
} from '../src/store.js';

const DATE = '2026-11-01';

function makeItem(bvid, title, mid = null, upName = null) {
  return { bvid, title, mid, upName, tid: 1, tname: null };
}

// ----------------------------------------------------------------------
// Evidence precedence
// ----------------------------------------------------------------------

test('classifyTheme：标题命中时 tags 完全不干扰结论', () => {
  const noisy = ['炉石传说', '万智牌', '写轮眼', '探店', '中东局势'];
  assert.equal(classifyTheme('大模型评测', null, noisy), 'ai');
  // Region must not rescue a title verdict either.
  assert.equal(classifyTheme('大模型评测', '桌游棋牌', noisy), 'ai');
});

test('classifyTheme：标题没信号时由 tags 给出结论', () => {
  // "火影忍者" is not a title keyword: legacy logic returns unclassified here.
  assert.equal(classifyTheme('火影忍者 写轮眼解析', null), UNCLASSIFIED);
  assert.equal(classifyTheme('火影忍者 写轮眼解析', null, ['火影忍者', '写轮眼']), 'screen');
});

test('classifyTheme：tags 也没信号时走二级分区', () => {
  assert.equal(classifyTheme('随便看看这个', '日常', ['vlog', '原创']), 'life');
  assert.equal(classifyTheme('随便看看这个', '美食侦探', ['做饭']), 'food');
  // No tags at all at this level still behaves exactly like the old code.
  assert.equal(classifyTheme('随便看看这个', '日常'), 'life');
  assert.equal(classifyTheme('随便看看这个', null, []), UNCLASSIFIED);
});

test('classifyTheme：分区已有结论时不被 tags 改写（历史口径锁定）', () => {
  // 时政 tag 在知识主题里，但这条记录原本被分区判成 life。为了让历史指标
  // （AI 2.36x、茧房指数 21.1、整条趋势线）保持可比，tag 层只救 unclassified。
  assert.equal(classifyTheme('中东局势最新进展', '日常', ['中东局势', '伊朗', '胡塞']), 'life');
  assert.equal(classifyTheme('随便看看这个', '日常', ['火影忍者', '写轮眼']), 'life');
});

// ----------------------------------------------------------------------
// Backward compatibility: no third argument == the pre-change function
// ----------------------------------------------------------------------

// Expected values captured from classifyTheme(title, tname) before the tag
// layer existed. If any of these move, existing reports stop being comparable.
const LEGACY_CASES = [
  ['大模型评测', null, 'ai'],
  ['DeepSeek 新版本发布', '数码', 'ai'],
  ['游戏攻略合集', null, 'game'],
  ['炉石传说新版本', '桌游棋牌', 'game'],
  ['美食探店：关东煮', '美食侦探', 'food'],
  ['猫咪日常', null, 'life'],
  ['火影忍者 写轮眼解析', null, UNCLASSIFIED],
  ['中东局势最新进展', '日常', 'life'],
  ['2026 年 10 月总结', '日常', 'life'],
  ['随便看看这个', null, UNCLASSIFIED],
  ['随便看看这个', '日常', 'life'],
  ['【原创】今天的晚饭', null, UNCLASSIFIED],
  ['vlog 生活记录', null, 'life'],
  ['', null, UNCLASSIFIED],
  [null, null, UNCLASSIFIED],
  [undefined, undefined, UNCLASSIFIED],
  ['匿名 vlog', '未知分区', 'life'],
  ['AI 绘画 ComfyUI 工作流', null, 'ai'],
  ['钢琴演奏', '音乐综合', 'music'],
  ['NBA 篮球集锦', '篮球', UNCLASSIFIED],
  ['天文摄影 银河', '科学科普', 'knowledge'],
  ['八哥学说话', '日常', 'life'],
  ['量子力学 科普', '科学科普', 'knowledge'],
  ['装修避坑指南', '家居房产', 'life'],
  ['Cooking 火锅底料', '美食制作', 'food'],
  ['随机一句话', '动物二创', 'animal'],
];

test('classifyTheme：不传第三参时与改动前逐条一致', () => {
  for (const [title, tname, expected] of LEGACY_CASES) {
    assert.equal(
      classifyTheme(title, tname),
      expected,
      `classifyTheme(${JSON.stringify(title)}, ${JSON.stringify(tname)}) 变了`,
    );
  }
});

test('classifyTheme：已有结论不被 tags 翻动', () => {
  const tagPools = [
    ['中东局势', '伊朗', '胡塞'],
    ['火影忍者', '写轮眼'],
    ['炉石传说', '万智牌'],
    ['探店', '关东煮'],
    ['comfyui', 'deepseek'],
    ['vlog', '原创'],
  ];
  for (const [title, tname, expected] of LEGACY_CASES) {
    if (expected === UNCLASSIFIED) continue;
    for (const tags of tagPools) {
      assert.equal(
        classifyTheme(title, tname, tags),
        expected,
        `classifyTheme(${JSON.stringify(title)}, ${JSON.stringify(tname)}, ${JSON.stringify(tags)}) 被 tag 改写了`,
      );
    }
  }
});

// ----------------------------------------------------------------------
// Tag vocabulary behaviour
// ----------------------------------------------------------------------

test('classifyTheme：tag 匹配大小写不敏感', () => {
  for (const spelling of ['comfyui', 'ComfyUI', 'ComfyUi', 'COMFYUI']) {
    assert.equal(classifyTheme('', null, [spelling]), 'ai', `${spelling} 应命中 ai`);
  }
  assert.equal(classifyTheme('', null, ['DeepSeek']), 'ai');
  assert.equal(classifyTheme('', null, ['deepseek']), 'ai');
  assert.equal(classifyTheme('', null, ['Seedance']), 'ai');
  // Mixed casing inside a longer tag also has to work.
  assert.equal(classifyTheme('', null, ['ComfyUI 工作流']), 'ai');
});

test('classifyTheme：纯噪声 tag 不产生错误结论', () => {
  assert.equal(classifyTheme('', null, ['vlog', '原创']), UNCLASSIFIED);
  assert.equal(classifyTheme('', null, ['vlog', '原创', '生活记录', '高能', '4K']), UNCLASSIFIED);
  assert.equal(classifyTheme('', null, ['经验分享', '评论区', '整活', '吐槽']), UNCLASSIFIED);
  assert.equal(classifyTheme('', null, ['官方知识付费内容']), UNCLASSIFIED);
  // Noise mixed with one real signal still classifies on the real signal.
  assert.equal(classifyTheme('', null, ['vlog', '原创', '探店']), 'food');
});

test('classifyTheme：活动类 tag 被过滤，不与主题词混淆', () => {
  const activity = ['B站AI创造公开赛', 'AI MV 大赛', '萌宠UP主加更计划', '亚运玩家总动员', 'B站好片有奖种草'];
  for (const tag of activity) {
    assert.equal(classifyTheme('', null, [tag]), UNCLASSIFIED, `${tag} 是活动 tag，不应分类`);
  }
  assert.equal(classifyTheme('', null, ['B站AI无限竞技场', '共创']), UNCLASSIFIED);
});

test('classifyTheme：tags 为 undefined / null / 空数组 / 脏数据时不崩', () => {
  assert.equal(classifyTheme('', null, undefined), UNCLASSIFIED);
  assert.equal(classifyTheme('', null, null), UNCLASSIFIED);
  assert.equal(classifyTheme('', null, []), UNCLASSIFIED);
  assert.equal(classifyTheme('', null, [null, 42, {}, [], '   ']), UNCLASSIFIED);
  assert.equal(classifyTheme('', null, ['火影忍者']), 'screen');
  assert.equal(classifyTheme('', null, 'not-an-array'), UNCLASSIFIED);
});

test('classifyTheme：短英文键不误伤无关 tag', () => {
  // 'ai' / 'cos' / 'gpt' are matched on word boundaries, so these are not AI.
  assert.equal(classifyTheme('', null, ['paint']), UNCLASSIFIED);
  assert.equal(classifyTheme('', null, ['trailer']), UNCLASSIFIED);
  assert.equal(classifyTheme('', null, ['costume']), UNCLASSIFIED);

  assert.equal(classifyTheme('', null, ['ai']), 'ai');
  assert.equal(classifyTheme('', null, ['AI 绘画']), 'ai');
  assert.equal(classifyTheme('', null, ['#cos']), 'screen');
  assert.equal(classifyTheme('', null, ['cosplay']), 'screen');
});

test('TAG_KEYWORDS：实测标签都有归属', () => {
  const required = {
    knowledge: ['中东局势', '伊朗', '伊以局势', '地缘博弈', '胡塞', '亚洲局势', '也门', '沙特', '巴基斯坦', '欧洲局势', '天文', '银河', '星系'],
    screen: ['火影忍者', '写轮眼', '宇智波', '别天神', '天照'],
    game: ['炉石传说', '万智牌', '天天卡牌'],
    food: ['探店', '关东煮', '日本料理', '吃货'],
    animal: ['八哥', '神奇动物', '动物成精'],
    ai: ['comfyui', 'deepseek', 'qwenimage', 'seedance', 'minimax', 'aivideo'],
  };
  for (const [want, tags] of Object.entries(required)) {
    for (const tag of tags) {
      assert.equal(classifyTheme('', null, [tag]), want, `tag ${tag} 应归入 ${want}`);
    }
  }

  // The vocabulary may only name themes that exist.
  for (const id of TAG_KEYWORDS.keys()) {
    assert.ok(THEMES.some((t) => t.id === id), `TAG_KEYWORDS 有未知主题 ${id}`);
  }
});

// ----------------------------------------------------------------------
// Host wire-up: video_tag -> summary
// ----------------------------------------------------------------------

// One login pair (ai title + tag-only title) and three guest rows, so every
// section of buildSummary has something to chew on.
function seedDb({ withTagTable = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cocoon-themes-'));
  const file = path.join(dir, 'cocoon.db');
  const store = openStore(file);
  try {
    saveExposure(store, DATE, 'login', 1, [
      makeItem('BVtitle', '大模型评测'),
      makeItem('BVtag', '火影忍者 写轮眼解析'),
    ]);
    saveExposure(store, DATE, 'guest', 1, [makeItem('BVg1', '大模型评测'), makeItem('BVg2', '大模型评测')]);
    saveExposure(store, DATE, 'guest', 2, [makeItem('BVg3', '大模型评测')]);
    saveVideoTags(store, 'BVtag', { tags: ['火影忍者', '写轮眼'], tagIds: [1, 2] });
    if (!withTagTable) store.db.exec('DROP TABLE video_tag');
  } finally {
    closeStore(store);
  }
  return { dir, file };
}

async function summaryOf(seedOptions) {
  const { dir, file } = seedDb(seedOptions);
  try {
    return await buildSummary(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('summary：有 video_tag 数据时 tag 救回的行计入主题', async () => {
  const r = await summaryOf();
  assert.equal(r.ok, true);
  assert.equal(r.login.count, 2);
  // Both login rows are classified: one by title, one by tag.
  assert.equal(r.login.coverage, 1);
  assert.ok(r.login.top.some((t) => t.id === 'ai'));
  const screen = r.login.top.find((t) => t.id === 'screen');
  assert.ok(screen, 'tag 应把「火影忍者」那行救成 screen');
  assert.equal(screen.n, 1);
  assert.equal(screen.name, '影视动漫');
  assert.equal('attributionError' in r, false);
  assert.equal('trendError' in r, false);
});

test('summary：video_tag 表不存在时退化为旧行为且 ok:true', async () => {
  const r = await summaryOf({ withTagTable: false });
  assert.equal(r.ok, true);
  assert.equal(r.login.count, 2);
  // Without the table the tag row stays unclassified, exactly like before.
  assert.equal(r.login.coverage, 0.5);
  assert.equal(r.login.top.some((t) => t.id === 'screen'), false);
  assert.ok(r.login.top.some((t) => t.id === 'ai'));
  assert.equal(r.guest.count, 3);
});

test('summary：video_tag 里的坏 JSON 不拖垮摘要', async () => {
  const { dir, file } = seedDb();
  try {
    const store = openStore(file);
    try {
      store.db.prepare('UPDATE video_tag SET tags = ? WHERE bvid = ?').run('{not json', 'BVtag');
    } finally {
      closeStore(store);
    }
    const r = await buildSummary(file);
    assert.equal(r.ok, true);
    assert.equal(r.login.coverage, 0.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
