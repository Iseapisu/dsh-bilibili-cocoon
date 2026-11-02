// Tests for the breakout block: which guest-only videos the host picks, and how
// the panel renders them. The client half is exercised through a fake React so
// the tree can be read as text without a browser or a build step.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildBreakout, buildSummary } from '../plugin/lib/index.js';
import { classifyTheme, THEMES, themeName } from '../src/themes.js';
import { closeStore, openStore, saveExposure } from '../src/store.js';

const DATE = '2026-11-02';

function makeItem(bvid, title, mid = null, upName = null) {
  return { bvid, title, mid, upName, tid: 1, tname: null };
}

// One title per theme, chosen so classifyTheme lands on it without help from
// tags or region: a title that hits two themes ties and the first one wins.
const TITLE = {
  ai: '大模型评测',
  game: '游戏攻略',
  food: '美食探店',
  knowledge: '科普原理',
  screen: '动漫解说',
  animal: '一只猫咪',
  music: '这首歌的翻唱',
  life: '日常生活',
  tech: '显卡',
  fun: '搞笑段子',
};

const vid = (theme, bvid, mid, upName) => makeItem(bvid, TITLE[theme], mid, upName);

// Sanity-check the fixtures once: a mislabeled title would silently make every
// expectation below assert the wrong theme.
test('breakout：测试夹具的标题确实落到预期主题', () => {
  for (const [theme, title] of Object.entries(TITLE)) {
    assert.equal(classifyTheme(title, null, [], null), theme, `${theme} 的标题判定不对`);
  }
});

// stand-in for the dynamically imported ../../src/themes.js
const themesModule = { classifyTheme, themeName, UNCLASSIFIED: 'unclassified', THEMES };

// login: ai 4, game 3, fun / screen / knowledge / tech / life 1 each = 12 videos.
// guest-only: music 1, animal 1, fun 2, knowledge 1, ai 2, tech 1, life 1, plus
// one unclassified video. Guest classified = 9 videos.
const LOGIN = [
  vid('ai', 'BVa1', 100, 'AI一号'),
  vid('ai', 'BVa2', 101, 'AI二号'),
  vid('ai', 'BVa3', 102, 'AI三号'),
  vid('ai', 'BVa4', 103, 'AI四号'),
  vid('game', 'BVg1', 200, '游戏一号'),
  vid('game', 'BVg2', 201, '游戏二号'),
  vid('game', 'BVg3', 202, '游戏三号'),
  vid('fun', 'BVf1', 300, '搞笑一号'),
  vid('screen', 'BVs1', 400, '影视一号'),
  vid('knowledge', 'BVk1', 500, '科普一号'),
  vid('tech', 'BVt1', 600, '数码一号'),
  vid('life', 'BVl1', 700, '生活一号'),
];

const GUEST = [
  vid('music', 'BVgm1', 800, '音乐UP'),
  vid('animal', 'BVgan1', 801, '萌宠UP'),
  vid('fun', 'BVgf2', 802, '搞笑二号'),
  vid('fun', 'BVgf3', 803, '搞笑三号'),
  vid('knowledge', 'BVgk9', 804, '科普九号'),
  vid('ai', 'BVga5', 805, 'AI五号'),
  vid('ai', 'BVga6', 806, 'AI六号'),
  vid('tech', 'BVgt9', 807, '数码九号'),
  vid('life', 'BVgl9', 808, '生活九号'),
  makeItem('BVgu1', '不 看 尾 巴 挑 战'),
];

const breakoutOf = (loginRows, guestRows) =>
  buildBreakout(null, {
    date: DATE,
    loginRows,
    guestRows,
    tagMap: null,
    themeMap: null,
    themes: themesModule,
  });

test('breakout：候选是游客侧去重后不在登录侧的视频，未分类只算候选不算推荐', () => {
  const r = breakoutOf(LOGIN, GUEST);

  // 10 distinct guest videos, none of them in the login feed.
  assert.equal(r.candidates, 10);
  // The unclassified one is a candidate but never a pick, so at most 9 remain -
  // and the list itself stops at 5.
  assert.equal(r.items.length, 5);
  assert.ok(!r.items.some((it) => it.theme === 'unclassified'));
  assert.ok(!r.items.some((it) => it.bvid === 'BVgu1'));

  // One video per theme: five rows have to say five things. Order is the home
  // share: music and animal are absent from home, then fun / knowledge / tech all
  // sit at 1/12 = 8.3% and fall back to gap descending. ai - the largest guest
  // share of all (22.2%) - is absent because home already carries it more (33.3%),
  // i.e. gap -11.1pp.
  assert.deepEqual(
    r.items.map((it) => it.theme),
    ['music', 'animal', 'fun', 'knowledge', 'tech'],
  );
});

test('breakout：按 loginShare 升序，同份额看 gap 降序，再同按稳定序', () => {
  const r = breakoutOf(LOGIN, GUEST);

  // music / animal are absent at home: 0% of the login feed. That is the
  // "basically unreachable" case the block is for, so they lead - each 1/9 =
  // 11.1% of the guest sample against 0% at home.
  assert.equal(r.items[0].theme, 'music');
  assert.equal(r.items[0].loginShare, 0);
  assert.equal(r.items[0].guestShare, 0.1111);
  assert.equal(r.items[0].gap, 0.1111);
  assert.equal(r.items[1].theme, 'animal');
  assert.equal(r.items[1].loginShare, 0);

  // fun is next at 1/12 = 8.3% at home even though its gap is the widest on the
  // fixture (+13.9pp): gap no longer decides the order.
  assert.equal(r.items[2].theme, 'fun');
  assert.equal(r.items[2].loginShare, 0.0833);
  assert.equal(r.items[2].gap, 0.1389);

  // knowledge / tech: also 8.3% at home, so the tie falls back to gap - both
  // +2.8pp - and then to guest-row order: knowledge appears before tech in
  // GUEST, so the list is stable between runs.
  assert.equal(r.items[3].theme, 'knowledge');
  assert.equal(r.items[3].gap, 0.0278);
  assert.equal(r.items[4].theme, 'tech');
  assert.equal(r.items[4].gap, 0.0278);

  // The whole list ascends by home share, and the widest gap is not the first row.
  // That is the regression this test exists for.
  const shares = r.items.map((it) => it.loginShare);
  assert.deepEqual(shares, [...shares].sort((a, b) => a - b));
  assert.equal(Math.max(...r.items.map((it) => it.gap)), r.items[2].gap);
});

test('breakout：loginShare 高但 gap 大的题材，排在 loginShare 低的题材之后', () => {
  // The trap this order exists for, on the shape of the 2026-11-02 data: 影视动漫
  // weighed 14.6% of the home feed against 20% of the guest sample (+5.4pp),
  // while music weighed 1.2% against 3.3% (+2.1pp). Screen's gap is the bigger
  // one, but 14.6% is not "basically unreachable", so music has to come first.
  // Same shape here: screen holds half the home feed and the widest gap.
  const login = [
    vid('screen', 'BVs1', 400, '影视一号'),
    vid('screen', 'BVs2', 401, '影视二号'),
    vid('screen', 'BVs3', 402, '影视三号'),
    vid('screen', 'BVs4', 403, '影视四号'),
    vid('ai', 'BVa1', 100, 'AI一号'),
    vid('ai', 'BVa2', 101, 'AI二号'),
    vid('ai', 'BVa3', 102, 'AI三号'),
    vid('ai', 'BVa4', 103, 'AI四号'),
  ];
  const guest = [
    vid('screen', 'BVs9', 409, '影视九号'),
    vid('screen', 'BVs10', 410, '影视十号'),
    vid('screen', 'BVs11', 411, '影视十一'),
    vid('screen', 'BVs12', 412, '影视十二'),
    vid('screen', 'BVs13', 413, '影视十三'),
    vid('music', 'BVgm1', 800, '音乐UP'),
  ];
  const r = breakoutOf(login, guest);

  // home: screen 4/8 = 50%, guest: screen 5/6 = 83.3% => gap +33.3pp.
  // home: music 0%, guest: music 1/6 = 16.7% => gap +16.7pp.
  assert.deepEqual(
    r.items.map((it) => it.theme),
    ['music', 'screen'],
  );
  assert.equal(r.items[0].loginShare, 0);
  assert.equal(r.items[0].gap, 0.1667);
  assert.equal(r.items[1].loginShare, 0.5);
  assert.equal(r.items[1].gap, 0.3333);
  // The bigger gap sits behind the smaller one: gap descending would invert this.
  assert.ok(r.items[0].gap < r.items[1].gap);
});

test('breakout：gap ≤ 0 的题材不推荐（游客那边不比你看得多，不属于被压制）', () => {
  const r = breakoutOf(LOGIN, GUEST);

  // ai: 22.2% for the guest against 33.3% at home = -11.1pp. Home already shows
  // more of it, so there is nothing suppressed to break out of.
  assert.ok(!r.items.some((it) => it.theme === 'ai'));
  assert.ok(!r.items.some((it) => it.loginShare > it.guestShare));
  for (const it of r.items) assert.ok(it.gap > 0, `${it.theme} 的 gap 必须为正`);

  // Exactly zero is dropped too - not ranked last and kept "for completeness".
  // screen is 1/2 at home and 1/2 for the guest, i.e. gap 0.
  const login = [vid('screen', 'BVs1', 400, '影视一号'), vid('ai', 'BVa1', 100, 'AI一号')];
  const guest = [vid('screen', 'BVs9', 409, '影视九号'), vid('music', 'BVgm1', 800, '音乐UP')];
  const zero = breakoutOf(login, guest);
  assert.equal(zero.candidates, 2);
  assert.deepEqual(
    zero.items.map((it) => [it.theme, it.gap]),
    [['music', 0.5]],
  );
});

test('breakout：每条都带 4 位小数的 gap，且 gap === guestShare − loginShare', () => {
  const r = breakoutOf(LOGIN, GUEST);
  assert.ok(r.items.length > 0);

  for (const it of r.items) {
    assert.equal(typeof it.gap, 'number');
    assert.equal(it.gap, Number(it.gap.toFixed(4)));
    assert.ok(
      Math.abs(it.gap - (it.guestShare - it.loginShare)) < 1e-9,
      `${it.theme}: gap ${it.gap} 与 ${it.guestShare} - ${it.loginShare} 不一致`,
    );
    assert.ok(it.gap > 0);
  }

  // The widest gap on the fixture still belongs to the funny one - and fun is
  // third, not first, because its home share is not the smallest.
  assert.equal(Math.max(...r.items.map((it) => it.gap)), 0.1389);
});

test('breakout：gap 为正的题材不足 5 个时只给这么多，不放宽门槛凑数', () => {
  // home: ai 3, game 1 (4 classified). guest: music, animal, ai, game (4).
  // gaps: ai 0.25-0.75 = -0.5, game 0.25-0.25 = 0, music 0.25, animal 0.25.
  const login = [
    vid('ai', 'BVa1', 100, 'AI一号'),
    vid('ai', 'BVa2', 101, 'AI二号'),
    vid('ai', 'BVa3', 102, 'AI三号'),
    vid('game', 'BVg1', 200, '游戏一号'),
  ];
  const guest = [
    vid('music', 'BVgm1', 800, '音乐UP'),
    vid('animal', 'BVgan1', 801, '萌宠UP'),
    vid('ai', 'BVga5', 805, 'AI五号'),
    vid('game', 'BVg9', 209, '游戏九号'),
  ];
  const r = breakoutOf(login, guest);

  // All four guest videos are candidates; only the two positive-gap themes become
  // picks. A short block is the honest answer - padding it with ai/game would turn
  // "break out" into "random recommendation".
  assert.equal(r.candidates, 4);
  assert.deepEqual(
    r.items.map((it) => [it.theme, it.gap]),
    [
      ['music', 0.25],
      ['animal', 0.25],
    ],
  );
});

test('breakout：每条都是 4 位小数的份额、可点击 url 与透传字段', () => {
  const r = breakoutOf(LOGIN, GUEST);
  const fun = r.items.find((it) => it.theme === 'fun');

  assert.equal(fun.bvid, 'BVgf2');
  assert.equal(fun.title, TITLE.fun);
  assert.equal(fun.upName, '搞笑二号');
  assert.equal(fun.mid, 802);
  assert.equal(fun.url, 'https://www.bilibili.com/video/BVgf2');
  assert.equal(fun.themeName, '搞笑整活');
  assert.equal(fun.loginShare, 0.0833);
  assert.equal(fun.guestShare, 0.2222);
  assert.equal(fun.gap, 0.1389);
  assert.equal(fun.upSeen, false);

  for (const it of r.items) {
    assert.equal(it.loginShare, Number(it.loginShare.toFixed(4)));
    assert.equal(it.guestShare, Number(it.guestShare.toFixed(4)));
    assert.equal(it.gap, Number(it.gap.toFixed(4)));
    assert.ok(it.loginShare >= 0 && it.loginShare <= 1);
    assert.ok(it.guestShare >= 0 && it.guestShare <= 1);
    assert.ok(it.gap > 0 && it.gap <= 1);
  }
});

test('breakout：upSeen 记录 UP 是否在登录首页出现过（字段保留，不参与排序）', () => {
  // Same loginShare for both themes (0), so only the gap tie-break and then the
  // guest-row order separate them. upSeen used to be a sort key; the ranking is
  // now about themes (loginShare, then gap), and one uploader flag must not
  // reorder it. The field stays for the panel.
  const login = [makeItem('BVx1', '美食探店', 900, '老熟人')];
  const guest = [
    makeItem('BVy1', '搞笑段子', 900, '老熟人'),
    makeItem('BVy2', '一只猫咪', 901, '新面孔'),
  ];
  const r = breakoutOf(login, guest);

  assert.deepEqual(
    r.items.map((it) => [it.theme, it.upSeen, it.gap]),
    [
      ['fun', true, 0.5],
      ['animal', false, 0.5],
    ],
  );
  // Both are absent at home, so neither the home share nor the gap separated them.
  assert.equal(r.items[0].loginShare, r.items[1].loginShare);
  assert.equal(r.items[0].gap, r.items[1].gap);
});

test('breakout：同一 UP 只出现一次，后续同 UP 的候选被跳过', () => {
  // mid 950 owns a video in two themes; only its first (higher-ranked) slot may
  // survive, and the later theme must not silently vanish - it gets no row, but
  // other themes still fill the list.
  const login = [vid('game', 'BVg1', 200, '游戏一号')];
  const guest = [
    makeItem('BVd1', '搞笑段子', 950, '多面手'),
    makeItem('BVd2', '一只猫咪', 950, '多面手'),
    makeItem('BVd3', '这首歌的翻唱', 951, '歌手'),
    makeItem('BVd4', '科普原理', 952, '科普人'),
  ];
  const r = breakoutOf(login, guest);

  const mids = r.items.map((it) => it.mid);
  assert.equal(new Set(mids).size, mids.length, 'UP 不能重复');
  assert.equal(mids.filter((mid) => mid === 950).length, 1);
  assert.ok(r.items.some((it) => it.mid === 951));
  assert.ok(r.items.some((it) => it.mid === 952));
});

test('breakout：游客侧或登录侧为空时返回空块', () => {
  for (const [login, guest] of [
    [[], GUEST],
    [LOGIN, []],
    [[], []],
  ]) {
    assert.deepEqual(breakoutOf(login, guest), { candidates: 0, items: [] });
  }
  // Non-array inputs must not throw either.
  assert.deepEqual(breakoutOf(null, GUEST), { candidates: 0, items: [] });
  assert.deepEqual(breakoutOf(LOGIN, undefined), { candidates: 0, items: [] });
});

test('breakout：登录侧全部未分类时没有可比份额，返回空块而不是 0', () => {
  // Every login video unclassified => classified denominator 0 => no share exists.
  const login = [makeItem('BVu1', '不 看 尾 巴 挑 战')];
  const r = breakoutOf(login, GUEST);
  assert.deepEqual(r, { candidates: 0, items: [] });
});

test('breakout：分类过程抛异常时整体降级为空块，绝不抛出', () => {
  const boom = {
    classifyTheme() {
      throw new Error('simulated classify failure');
    },
    themeName: (id) => id,
    UNCLASSIFIED: 'unclassified',
  };
  const r = buildBreakout(null, {
    date: DATE,
    loginRows: LOGIN,
    guestRows: GUEST,
    tagMap: null,
    themeMap: null,
    themes: boom,
  });
  assert.deepEqual(r, { candidates: 0, items: [] });

  // A themes module that is missing entirely behaves the same way.
  assert.deepEqual(
    buildBreakout(null, { loginRows: LOGIN, guestRows: GUEST, themes: null }),
    { candidates: 0, items: [] },
  );
});

test('breakout：没有 bvid 的行不是候选，重复 bvid 只算一次', () => {
  const guest = [
    makeItem(null, TITLE.fun),
    makeItem('', TITLE.fun),
    makeItem('BVr1', TITLE.fun, 810, 'UP甲'),
    makeItem('BVr1', TITLE.fun, 810, 'UP甲'),
  ];
  const r = breakoutOf([vid('game', 'BVg1', 200, '游戏一号')], guest);

  assert.equal(r.candidates, 1);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].bvid, 'BVr1');
});

test('breakout：游客侧回看登录侧的同一支视频不算候选', () => {
  const login = [vid('fun', 'BVdup', 300, '搞笑一号'), vid('game', 'BVg1', 200, '游戏一号')];
  const guest = [vid('fun', 'BVdup', 300, '搞笑一号'), vid('music', 'BVnew', 801, '音乐UP')];
  const r = breakoutOf(login, guest);

  assert.equal(r.candidates, 1);
  assert.deepEqual(
    r.items.map((it) => it.bvid),
    ['BVnew'],
  );
});

// ----------------------------------------------------------------------
// Summary integration
// ----------------------------------------------------------------------

async function summaryOf(exposure) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cocoon-breakout-'));
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

test('summary：breakout 挂在 feedFocus 之后，既有字段一个不少', async () => {
  const r = await summaryOf([
    { kind: 'login', round: 1, items: LOGIN },
    { kind: 'guest', round: 1, items: GUEST },
  ]);

  assert.equal(r.ok, true);
  assert.equal('breakoutError' in r, false);

  const keys = Object.keys(r);
  assert.equal(keys.indexOf('breakout'), keys.indexOf('feedFocus') + 1);
  for (const key of ['headline', 'feedFocus', 'attribution', 'advice', 'trend', 'amplification']) {
    assert.ok(key in r, `summary 不能丢掉 ${key}`);
  }

  assert.equal(r.breakout.candidates, 10);
  assert.equal(r.breakout.items.length, 5);
  // Lowest home share first: music is absent from the login feed, even though fun
  // owns the widest gap on this fixture.
  assert.equal(r.breakout.items[0].theme, 'music');
  assert.equal(r.breakout.items[0].gap, 0.1111);
  // Both shares still travel with the pick, so the panel can quote them.
  assert.equal(r.breakout.items[0].loginShare, 0);
  assert.equal(r.breakout.items[0].guestShare, 0.1111);
});

test('summary：guest 只有未分类视频时 breakout 为空块而面板其余照常', async () => {
  const r = await summaryOf([
    { kind: 'login', round: 1, items: LOGIN },
    { kind: 'guest', round: 1, items: [makeItem('BVu1', '不 看 尾 巴 挑 战')] },
  ]);

  assert.equal(r.ok, true);
  // The guest video is still a candidate: it reached the guest and not the login.
  assert.equal(r.breakout.candidates, 1);
  assert.deepEqual(r.breakout.items, []);
  // The rest of the panel is untouched: the login side still has a composition
  // block even though the guest baseline holds no classified video.
  assert.ok(r.feedFocus);
  assert.ok(Array.isArray(r.amplification) && r.amplification.length > 0);
  assert.equal(r.login.count, LOGIN.length);
});

// ----------------------------------------------------------------------
// Client rendering (fake React)
// ----------------------------------------------------------------------

// Minimal React stand-in: elements are plain objects, hooks return their initial
// value plus a no-op setter, effects never run (no fetch in tests).
function fakeReact(options = {}) {
  const state = { hooks: 0 };
  return {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2);
      const next = Object.assign({}, props);
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      return { type, props: next };
    },
    useState(init) {
      state.hooks += 1;
      // The pill's first hook is `open`; force the panel open so Body is mounted.
      if (options.openPanel === true && state.hooks === 1) return [true, () => {}];
      return [typeof init === 'function' ? init() : init, () => {}];
    },
    useEffect() {},
  };
}

// Loads the client half the way the host does: through __ModuleLoader__, with a
// require that refuses anything but react - the panel must stay a one-module,
// no-build, zero-dependency script.
function loadClient() {
  const source = readFileSync(new URL('../plugin/lib/client.js', import.meta.url), 'utf8');
  let captured = null;
  const windowStub = {
    __ModuleLoader__: {
      load: (options) => {
        captured = options;
      },
    },
  };
  new Function('window', source)(windowStub);
  assert.ok(captured, 'client 必须通过 __ModuleLoader__ 注册');

  const required = [];
  const React = fakeReact({ openPanel: true });
  const plugin = captured.factory((name) => {
    required.push(name);
    if (name !== 'react') throw new Error('unexpected require: ' + name);
    return React;
  });

  let component = null;
  let registered = null;
  plugin.apply({
    effect: (fn) => fn(),
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, comp) => {
        registered = { meta, component: comp };
        component = comp;
        return registered;
      },
    },
  });

  return { options: captured, plugin, required, component, registered, React };
}

function findByType(node, name) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByType(child, name);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node.type === 'function' && node.type.name === name) return node;
  return findByType(node.props && node.props.children, name);
}

function elementsOf(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out);
    return out;
  }
  out.push(node);
  if (node.props) elementsOf(node.props.children, out);
  return out;
}

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (typeof node === 'object' && node.props) textOf(node.props.children, out);
  return out;
}

// Mounts the pill, finds the Body element it renders and calls Body directly with
// the given summary, so only the panel body is under test.
function renderBody(data) {
  const client = loadClient();
  const tree = client.component({});
  const body = findByType(tree, 'Body');
  assert.ok(body, '面板应渲染 Body');

  const node = body.type(Object.assign({}, body.props, { phase: 'ready', data }));
  return {
    node,
    text: textOf(node).join(' '),
    elements: elementsOf(node),
    client,
  };
}

const LINKS = (elements) =>
  elements.filter(
    (el) => el.type === 'a' && el.props && typeof el.props.href === 'string' && el.props.href.includes('bilibili.com/video/'),
  );

const BREAKOUT_ITEMS = [
  {
    bvid: 'BV1TxxC6vEo4',
    title: '全球笑点下降2000倍而我不变【第二集】',
    upName: '逗比的雀巢',
    mid: 5294454,
    url: 'https://www.bilibili.com/video/BV1TxxC6vEo4',
    theme: 'fun',
    themeName: '搞笑整活',
    loginShare: 0.0488,
    guestShare: 0.1667,
    upSeen: false,
  },
  {
    bvid: 'BV1xixi6yELU',
    title: '假如带着豆包和蓝色大肥鱼等一众AI穿越到2018年',
    upName: '卜肉熊brx',
    mid: 123456,
    url: 'https://www.bilibili.com/video/BV1xixi6yELU',
    theme: 'screen',
    themeName: '影视动漫',
    loginShare: 0.1429,
    guestShare: 0.2,
    upSeen: false,
  },
  {
    bvid: 'BV1REx46NEc4',
    title: '【全网最全】DeepSeek Harness超详细教程',
    upName: 'Git源宝',
    mid: 789,
    url: 'https://www.bilibili.com/video/BV1REx46NEc4',
    theme: 'ai',
    themeName: 'AI / 大模型',
    loginShare: 0.2381,
    guestShare: 0.1053,
    upSeen: true,
  },
];

function fullData(overrides = {}) {
  return Object.assign(
    {
      ok: true,
      date: DATE,
      dbPath: 'C:/data/cocoon.db',
      rounds: 3,
      login: { count: 84, coverage: 0.9762, top: [] },
      guest: { count: 82, coverage: 1, top: [] },
      history: { count: 0, coverage: 0, top: [] },
      amplification: [
        {
          id: 'ai',
          name: 'AI / 大模型',
          loginShare: 0.2381,
          guestShare: 0.1053,
          loginShareDedup: 0.2381,
          guestShareDedup: 0.1053,
          historyShare: 0,
          ratio: 2.26,
          ratioDedup: 2.26,
        },
      ],
      headline: { id: 'ai', name: 'AI / 大模型', ratio: 2.26, ratioDedup: 2.26 },
      feedFocus: {
        top: {
          id: 'ai',
          name: 'AI / 大模型',
          share: 0.2381,
          baselineShare: 0.1053,
          baselineShareRows: 0.0976,
          ratio: 2.26,
          ratioDedup: 2.26,
        },
        top3Share: 0.6,
        effectiveThemes: 7.4,
        totalThemes: 10,
        units: { login: 84, guest: 38 },
        repeatRate: { login: 0, guest: 0.54 },
      },
      breakout: { candidates: 37, items: BREAKOUT_ITEMS },
      attribution: [],
      advice: { theme: 'ai', name: 'AI / 大模型', ratio: 2.26, ratioDedup: 2.26, kind: 'watch', text: '建议句：没有单一 UP 主主导。' },
      trend: null,
    },
    overrides,
  );
}

test('client：注册元信息不变（id / slot / order / inject）', () => {
  const { options, plugin, required, registered } = loadClient();

  assert.equal(options.id, 'dsh-bilibili-cocoon');
  assert.equal(registered.meta.name, 'conversation.session.header.actions');
  assert.equal(registered.meta.id, 'dsh-bilibili-cocoon');
  assert.equal(registered.meta.order, 13);
  assert.deepEqual(plugin.inject, ['slots']);
  assert.equal(plugin.name, 'dsh-bilibili-cocoon');
  // Only react: no new dependency, no JSX, no build step.
  assert.deepEqual(required, ['react']);
});

test('client：破茧推荐渲染在建议句之后，标题可点击且带安全属性', () => {
  const { node, text, elements } = renderBody(fullData());

  assert.match(text, /破茧推荐/);
  assert.match(text, /游客看到、你首页没有的 37 条里，这几条被压得最狠：/);

  // The block sits at the bottom: after the advice sentence and its note.
  const labels = textOf(node).map((s) => s.trim());
  const adviceAt = labels.findIndex((s) => s.includes('建议句'));
  const blockAt = labels.findIndex((s) => s.includes('破茧推荐'));
  assert.ok(adviceAt !== -1 && blockAt !== -1);
  assert.ok(blockAt > adviceAt, '破茧推荐应在建议句之后');

  // Every title is a link that opens in a new tab, safely.
  const links = LINKS(elements);
  assert.equal(links.length, BREAKOUT_ITEMS.length);
  for (const [i, item] of BREAKOUT_ITEMS.entries()) {
    assert.equal(links[i].props.href, item.url);
    assert.equal(links[i].props.target, '_blank');
    assert.equal(links[i].props.rel, 'noopener noreferrer');
    assert.equal(typeof links[i].props.onClick, 'function');
    assert.ok(text.includes(String(i + 1) + '. ' + item.title), '标题应带序号');
  }

  // The line under each title: uploader · theme (home share).
  assert.ok(text.includes('逗比的雀巢 · 搞笑整活（你首页 4.9%）'));
  assert.ok(text.includes('卜肉熊brx · 影视动漫（你首页 14.3%）'));
  assert.ok(text.includes('Git源宝 · AI / 大模型（你首页 23.8%）'));

  assert.ok(!/undefined|NaN/.test(text), text);
});

test('client：breakout 缺失 / items 为空 / items 不是数组时整块不渲染', () => {
  for (const breakout of [undefined, null, {}, { candidates: 37, items: [] }, { candidates: 37, items: 'nope' }, 'junk', 7]) {
    const { text } = renderBody(fullData({ breakout }));
    assert.ok(!text.includes('破茧推荐'), '不应渲染破茧推荐块');
    // The rest of the panel is untouched: theme row, advice and note still there.
    assert.match(text, /AI \/ 大模型/);
    assert.match(text, /建议句/);
    assert.match(text, /顺序按「推给你 − 路人」排/);
    assert.ok(!/undefined|NaN/.test(text), text);
  }
});

test('client：candidates 缺失或非法时去掉数字，不出现 NaN', () => {
  for (const candidates of [undefined, null, '', 'abc', NaN, -3]) {
    const { text } = renderBody(fullData({ breakout: { candidates, items: BREAKOUT_ITEMS } }));
    assert.match(text, /破茧推荐/);
    assert.match(text, /游客看得到、你首页没有的视频里，这几条被压得最狠：/);
    assert.ok(!/undefined|NaN/.test(text), text);
  }
});

test('client：标题 / UP 缺失时兜底，登录份额为 0 时照常显示 0.0%', () => {
  const items = [
    { bvid: 'BVz1', title: null, upName: null, mid: null, theme: 'fun', themeName: '搞笑整活', loginShare: 0, guestShare: 0.2 },
    // No themeName at all: the parenthetical share still renders.
    { bvid: 'BVz2', title: '一支视频', upName: '某UP', mid: 1, theme: 'ai', themeName: null, loginShare: 0.1234 },
    // No url: the bvid is enough to build one.
    { bvid: 'BVz3', title: '另一支视频', upName: '另一UP', mid: 2, theme: 'game', themeName: '游戏', loginShare: 0.2 },
    // No bvid, no url, no share: plain text, no link, no parenthetical.
    { title: '无链接视频', upName: '散人', theme: 'life', themeName: '生活日常' },
  ];
  const { text, elements } = renderBody(fullData({ breakout: { candidates: 4, items } }));

  assert.match(text, /1\. 未知标题/);
  assert.match(text, /未知 UP · 搞笑整活（你首页 0\.0%）/);
  assert.match(text, /某UP（你首页 12\.3%）/);
  assert.match(text, /无链接视频/);
  assert.ok(!/undefined|NaN/.test(text), text);

  const links = LINKS(elements);
  assert.equal(links.length, 3);
  assert.equal(links[0].props.href, 'https://www.bilibili.com/video/BVz1');
  assert.equal(links[2].props.href, 'https://www.bilibili.com/video/BVz3');
});

test('client：block 与 items 里的脏数据不抛异常', () => {
  const dirty = [
    null,
    undefined,
    'junk',
    7,
    [],
    { bvid: {}, title: 42, upName: [], loginShare: 'NaN', themeName: {} },
  ];
  const { text } = renderBody(fullData({ breakout: { candidates: 6, items: dirty } }));
  assert.match(text, /破茧推荐/);
  assert.ok(!/undefined|NaN/.test(text), text);
});
