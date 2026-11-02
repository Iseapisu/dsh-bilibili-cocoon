// Unit tests for the tag_theme migration: single-tag resolution, the frozen
// vote that the table must not disturb, the table's CRUD, and the host's
// degradation when the new tables are absent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildSummary } from '../plugin/lib/index.js';
import {
  classifyTheme,
  lexiconThemesOf,
  resolveTagTheme,
  THEMES,
  UNCLASSIFIED,
} from '../src/themes.js';
import {
  closeStore,
  countTagThemes,
  listTagThemes,
  listUnresolvedTags,
  openStore,
  saveExposure,
  saveTagThemes,
  saveUnresolvedTags,
  saveVideoTags,
} from '../src/store.js';

const DATE = '2026-11-01';

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cocoon-tagtheme-'));
  return { dir, file: path.join(dir, 'cocoon.db') };
}

const makeItem = (bvid, title) => ({ bvid, title, mid: null, upName: null, tid: 1, tname: null });

// ----------------------------------------------------------------------
// resolveTagTheme: table first, lexicon second, null when neither speaks
// ----------------------------------------------------------------------

test('resolveTagTheme：表命中时以表为准，即使词根结论相反', () => {
  // 'comfyui' is an `ai` tag in the lexicon; this row deliberately says game.
  assert.equal(resolveTagTheme('comfyui', new Map([['comfyui', 'game']])), 'game');
  // Lookup lowercases the tag, so any casing of the same tag hits the row.
  const map = new Map([['comfyui', 'ai']]);
  for (const spelling of ['comfyui', 'ComfyUI', 'COMFYUI', ' ComfyUi ']) {
    assert.equal(resolveTagTheme(spelling, map), 'ai', `${spelling} 应命中表中行`);
  }
});

test('resolveTagTheme：表里没有时走词根，且保留词根的全部细节', () => {
  assert.equal(resolveTagTheme('comfyui', new Map()), 'ai');
  assert.equal(resolveTagTheme('ComfyUI 工作流', new Map()), 'ai');
  assert.equal(resolveTagTheme('中东局势', undefined), 'knowledge');
  assert.equal(resolveTagTheme('AI 绘画', new Map()), 'ai');
  // ≤3 位 ASCII 走词边界，不能误伤 paint / trailer。
  assert.equal(resolveTagTheme('paint', new Map()), null);
  assert.equal(resolveTagTheme('trailer', new Map()), null);
  assert.equal(resolveTagTheme('#cos', new Map()), 'screen');
});

test('resolveTagTheme：词根也判不出时返回 null', () => {
  assert.equal(resolveTagTheme('大肥鱼', new Map()), null);
  assert.equal(resolveTagTheme('万物研究所', new Map()), null);
  assert.equal(resolveTagTheme('', new Map()), null);
  assert.equal(resolveTagTheme(null, new Map()), null);
  assert.equal(resolveTagTheme(undefined, new Map()), null);
  assert.equal(resolveTagTheme('   ', new Map()), null);
});

test('resolveTagTheme：噪声/活动 tag 即使表里有行也不给主题', () => {
  const map = new Map([
    ['vlog', 'life'],
    ['原创', 'life'],
    ['b站ai无限竞技场', 'ai'],
    ['动物总动员', 'animal'],
  ]);
  assert.equal(resolveTagTheme('vlog', map), null);
  assert.equal(resolveTagTheme('原创', map), null);
  assert.equal(resolveTagTheme('B站AI无限竞技场', map), null);
  assert.equal(resolveTagTheme('动物总动员', map), null);
});

test('resolveTagTheme：接受 store 的 { theme, source, confidence } 值', () => {
  const map = new Map([['大肥鱼', { theme: 'life', source: 'manual', confidence: 0.8 }]]);
  assert.equal(resolveTagTheme('大肥鱼', map), 'life');
});

test('lexiconThemesOf：复合 tag 会同时命中多个主题（即歧义）', () => {
  // THEMES 顺序：ai < ... < music，所以 'ai音乐' 的候选是 ['ai', 'music']。
  assert.deepEqual(lexiconThemesOf('ai音乐'), ['ai', 'music']);
  assert.deepEqual(lexiconThemesOf('AI音乐'), ['ai', 'music']);
  assert.deepEqual(lexiconThemesOf('搞笑动物'), ['animal', 'fun']);
  assert.deepEqual(lexiconThemesOf('comfyui'), ['ai']);
  assert.deepEqual(lexiconThemesOf('中东局势'), ['knowledge']);
  assert.deepEqual(lexiconThemesOf('大肥鱼'), []);
  assert.deepEqual(lexiconThemesOf('vlog'), []);
  assert.deepEqual(lexiconThemesOf(''), []);
  // The vocabulary may only name themes that exist.
  for (const id of lexiconThemesOf('ai音乐')) {
    assert.ok(THEMES.some((t) => t.id === id), `lexiconThemesOf 返回未知主题 ${id}`);
  }
});

// ----------------------------------------------------------------------
// classifyTheme: the fourth argument must not move any existing verdict
// ----------------------------------------------------------------------

// Tag pools that must classify identically with and without the table. The
// second pool is the interesting one: 'AI音乐' is credited to both `ai` and
// `music` by the lexicon, and it is the 'music' keyword inside it that keeps the
// video in `music`. Collapsing that tag to a single theme would rewrite the row.
const POOLS = [
  ['AI音乐', '司凤音乐', '精灵宝可梦'],
  ['comfyui', 'deepseek', 'qwenimage'],
  ['火影忍者', '写轮眼', '宇智波'],
  ['炉石传说', '万智牌'],
  ['中东局势', '伊朗', '胡塞'],
  ['vlog', '原创', '探店'],
  ['大肥鱼', '万物研究所'],
  [],
];

test('classifyTheme：表里只放唯一命中的 tag 时，结论与不传表逐条一致', () => {
  for (const pool of POOLS) {
    // Exactly what tools/classify-tags.mjs writes: one theme per tag, ambiguous
    // tags left to the lexicon.
    const map = new Map();
    for (const tag of pool) {
      const ids = lexiconThemesOf(tag);
      if (ids.length === 1) map.set(tag.toLowerCase(), ids[0]);
    }
    for (const title of ['', '随便看看这个']) {
      assert.equal(
        classifyTheme(title, null, pool, map),
        classifyTheme(title, null, pool),
        `pool ${JSON.stringify(pool)} 在传入表后结论变了`,
      );
    }
  }
});

test('classifyTheme：复合 tag 的多主题投票是冻结口径，不能被压成单票', () => {
  const tags = ['AI音乐', '司凤音乐', '精灵宝可梦'];
  // ai 1 票、music 2 票、animal 1 票 -> music。若把 'AI音乐' 只算 ai，就是 ai 1 /
  // music 1 / animal 1，平票按 THEMES 顺序落到 ai，历史数字会被改写。
  assert.equal(classifyTheme('', null, tags), 'music');
  assert.equal(classifyTheme('', null, tags, new Map()), 'music');
  // 表里只有无歧义 tag 时，歧义 tag 继续走词根，结论不变。
  const map = new Map([['精灵宝可梦', 'animal']]);
  assert.equal(classifyTheme('', null, tags, map), 'music');
});

test('classifyTheme：传 themeMap 时表优先于词根', () => {
  assert.equal(classifyTheme('', null, ['comfyui']), 'ai');
  assert.equal(classifyTheme('', null, ['comfyui'], new Map([['comfyui', 'game']])), 'game');
  // A tag the lexicon cannot read at all can still be resolved by the table.
  assert.equal(classifyTheme('', null, ['大肥鱼']), UNCLASSIFIED);
  assert.equal(classifyTheme('', null, ['大肥鱼'], new Map([['大肥鱼', 'life']])), 'life');
  // Table votes and lexicon votes land in the same tally.
  assert.equal(
    classifyTheme('', null, ['大肥鱼', '炉石传说'], new Map([['大肥鱼', 'game']])),
    'game',
  );
});

test('classifyTheme：表里的未知主题 id 不生效，退回词根而不是吞掉这一票', () => {
  const map = new Map([['comfyui', 'no-such-theme']]);
  assert.equal(classifyTheme('', null, ['comfyui'], map), 'ai');
  assert.equal(classifyTheme('', null, ['comfyui', '炉石传说'], map), 'ai');
});

test('classifyTheme：表也救不了噪声 tag 和活动 tag', () => {
  const map = new Map([
    ['vlog', 'life'],
    ['b站ai无限竞技场', 'ai'],
  ]);
  assert.equal(classifyTheme('', null, ['vlog', '原创'], map), UNCLASSIFIED);
  assert.equal(classifyTheme('', null, ['B站AI无限竞技场'], map), UNCLASSIFIED);
});

test('classifyTheme：themeMap 为 null / 非 Map 时等同于不传', () => {
  const tags = ['comfyui', '炉石传说'];
  assert.equal(classifyTheme('', null, tags, null), classifyTheme('', null, tags));
  assert.equal(classifyTheme('', null, tags, {}), classifyTheme('', null, tags));
});

// ----------------------------------------------------------------------
// store: tag_theme / tag_unresolved
// ----------------------------------------------------------------------

test('saveTagThemes：批量 upsert、大小写归一、脏条目跳过', () => {
  const store = openStore(':memory:');
  try {
    const out = saveTagThemes(store, [
      { tag: 'ComfyUI', theme: 'ai' },
      { tag: '大肥鱼', theme: 'life', source: 'manual', confidence: 0.8 },
      { tag: '', theme: 'ai' },
      { tag: '炉石传说' },
      null,
    ]);
    assert.equal(out.written, 2);
    assert.equal(out.skipped, 3);

    const map = listTagThemes(store);
    // Stored lowercased: the primary key is the matching key.
    assert.equal(map.has('comfyui'), true);
    assert.equal(map.has('ComfyUI'), false);
    assert.deepEqual(map.get('comfyui'), { theme: 'ai', source: 'lexicon', confidence: 1 });
    assert.deepEqual(map.get('大肥鱼'), { theme: 'life', source: 'manual', confidence: 0.8 });
  } finally {
    closeStore(store);
  }
});

test('saveTagThemes：lexicon 覆盖不了 manual，manual 可以覆盖 lexicon', () => {
  const store = openStore(':memory:');
  try {
    saveTagThemes(store, [{ tag: 'comfyui', theme: 'ai', source: 'manual' }]);
    const blocked = saveTagThemes(store, [{ tag: 'comfyui', theme: 'tech', source: 'lexicon' }]);
    assert.equal(blocked.written, 0);
    assert.equal(blocked.blocked, 1);
    assert.equal(listTagThemes(store).get('comfyui').theme, 'ai');

    const manualAgain = saveTagThemes(store, [{ tag: 'comfyui', theme: 'tech', source: 'manual' }]);
    assert.equal(manualAgain.written, 1);
    assert.equal(listTagThemes(store).get('comfyui').theme, 'tech');

    // A lexicon row is still fair game for a later lexicon pass.
    saveTagThemes(store, [{ tag: '炉石传说', theme: 'game' }]);
    assert.equal(saveTagThemes(store, [{ tag: '炉石传说', theme: 'fun' }]).written, 1);
    assert.equal(listTagThemes(store).get('炉石传说').theme, 'fun');
  } finally {
    closeStore(store);
  }
});

test('saveUnresolvedTags：seen_count 累加，first_seen 不动', () => {
  const store = openStore(':memory:');
  try {
    saveUnresolvedTags(store, [{ tag: 'Foo', count: 2 }, 'bar']);
    const first = listUnresolvedTags(store);
    assert.equal(first.length, 2);
    const foo = first.find((r) => r.tag === 'foo');
    assert.equal(foo.seenCount, 2);
    // Plain strings weigh one sighting.
    assert.equal(first.find((r) => r.tag === 'bar').seenCount, 1);

    saveUnresolvedTags(store, [{ tag: 'foo', count: 5 }, { tag: 'bar' }]);
    const after = listUnresolvedTags(store);
    const foo2 = after.find((r) => r.tag === 'foo');
    assert.equal(foo2.seenCount, 7);
    assert.equal(foo2.firstSeen, foo.firstSeen);
    assert.ok(foo2.lastSeen >= foo.firstSeen);
    assert.equal(after.find((r) => r.tag === 'bar').seenCount, 2);
    // attempts is left for a future LLM pass and must not move here.
    assert.equal(foo2.attempts, 0);
  } finally {
    closeStore(store);
  }
});

test('listUnresolvedTags：按 seen_count 降序，支持 limit', () => {
  const store = openStore(':memory:');
  try {
    saveUnresolvedTags(store, [
      { tag: 'low', count: 1 },
      { tag: 'high', count: 40 },
      { tag: 'mid', count: 7 },
    ]);
    assert.deepEqual(listUnresolvedTags(store).map((r) => r.tag), ['high', 'mid', 'low']);
    assert.deepEqual(listUnresolvedTags(store, 2).map((r) => r.tag), ['high', 'mid']);
    assert.deepEqual(listUnresolvedTags(store, 0).map((r) => r.tag), ['high', 'mid', 'low']);
    assert.deepEqual(listUnresolvedTags(store, -1).map((r) => r.tag), ['high', 'mid', 'low']);
  } finally {
    closeStore(store);
  }
});

test('countTagThemes：总数、按 source 分组、待办数', () => {
  const store = openStore(':memory:');
  try {
    assert.deepEqual(countTagThemes(store), { total: 0, bySource: {}, unresolved: 0 });
    saveTagThemes(store, [
      { tag: 'a', theme: 'ai' },
      { tag: 'b', theme: 'game', source: 'lexicon' },
      { tag: 'c', theme: 'life', source: 'manual' },
      { tag: 'd', theme: 'food', source: 'llm' },
    ]);
    saveUnresolvedTags(store, ['x', 'y']);
    const counts = countTagThemes(store);
    assert.equal(counts.total, 4);
    assert.equal(counts.bySource.lexicon, 2);
    assert.equal(counts.bySource.manual, 1);
    assert.equal(counts.bySource.llm, 1);
    assert.equal(counts.unresolved, 2);
  } finally {
    closeStore(store);
  }
});

// ----------------------------------------------------------------------
// Host: the table is read, and its absence is not fatal
// ----------------------------------------------------------------------

test('summary：tag_theme 生效；两张新表不存在时退化为纯词根且不崩', async () => {
  const { dir, file } = tempDb();
  try {
    const store = openStore(file);
    try {
      saveExposure(store, DATE, 'login', 1, [
        makeItem('BVtag', '火影忍者 写轮眼解析'),
        makeItem('BVtable', '随便看看这个'),
      ]);
      saveVideoTags(store, 'BVtag', { tags: ['火影忍者', '写轮眼'], tagIds: [1, 2] });
      // The lexicon has no rule for '大肥鱼', so only the table can rescue this row.
      saveVideoTags(store, 'BVtable', { tags: ['大肥鱼'], tagIds: [3] });
    } finally {
      closeStore(store);
    }

    const lexOnly = await buildSummary(file);
    assert.equal(lexOnly.ok, true);
    assert.equal(lexOnly.login.coverage, 0.5);
    assert.equal(lexOnly.login.top.some((t) => t.id === 'life'), false);

    const seeded = openStore(file);
    try {
      saveTagThemes(seeded, [{ tag: '大肥鱼', theme: 'life', source: 'manual' }]);
    } finally {
      closeStore(seeded);
    }

    const withTable = await buildSummary(file);
    assert.equal(withTable.ok, true);
    assert.equal(withTable.login.coverage, 1);
    assert.ok(withTable.login.top.some((t) => t.id === 'life'));

    // An older database without the new tables: empty maps, no throw, pre-table
    // behaviour for every row.
    const dropped = openStore(file);
    try {
      dropped.db.exec('DROP TABLE tag_theme');
      dropped.db.exec('DROP TABLE tag_unresolved');
    } finally {
      closeStore(dropped);
    }

    const degraded = await buildSummary(file);
    assert.equal(degraded.ok, true);
    assert.equal(degraded.login.coverage, 0.5);
    assert.equal(degraded.login.top.some((t) => t.id === 'life'), false);
    assert.equal('feedFocusError' in degraded, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summary：tag_theme 里的坏行（空 tag / 未知主题）不拖垮摘要', async () => {
  const { dir, file } = tempDb();
  try {
    const store = openStore(file);
    try {
      saveExposure(store, DATE, 'login', 1, [makeItem('BVtag', '随便看看这个')]);
      saveVideoTags(store, 'BVtag', { tags: ['comfyui'], tagIds: [1] });
      store.db
        .prepare('INSERT INTO tag_theme(tag, theme, source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('comfyui', '', 'manual', 1, 1, 1);
    } finally {
      closeStore(store);
    }
    const r = await buildSummary(file);
    assert.equal(r.ok, true);
    // The empty theme id is not a known theme, so the lexicon still answers.
    assert.equal(r.login.coverage, 1);
    assert.ok(r.login.top.some((t) => t.id === 'ai'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
