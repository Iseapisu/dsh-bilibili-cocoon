// Unit tests for the exposure side: summarizeExposure must honour the tag
// evidence its caller attached, and must keep the pre-tag verdicts when the
// caller has none (older library, bvid not backfilled yet).

import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeExposure } from '../src/exposure.js';

// Login: 2 title-classified AI rows + 2 tag-only screen rows.
// Guest: 1 title-classified AI row + 3 tag-only screen rows.
function dataset() {
  return {
    rounds: 1,
    login: [
      {
        round: 1,
        items: [
          { bvid: 'BVl1', title: '大模型评测', tname: null, upName: 'UP甲' },
          { bvid: 'BVl2', title: '大模型评测', tname: null, upName: 'UP甲' },
          { bvid: 'BVl3', title: '这段正片', tname: null, upName: 'UP乙', tags: ['火影忍者', '写轮眼'] },
          { bvid: 'BVl4', title: '这段正片', tname: null, upName: 'UP乙', tags: ['火影忍者'] },
        ],
      },
    ],
    guest: [
      {
        round: 1,
        items: [
          { bvid: 'BVg1', title: '大模型评测', tname: null, upName: 'UP丙' },
          { bvid: 'BVg2', title: '这段正片', tname: null, upName: 'UP丁', tags: ['火影忍者'] },
          { bvid: 'BVg3', title: '这段正片', tname: null, upName: 'UP丁', tags: ['火影忍者'] },
          { bvid: 'BVg4', title: '这段正片', tname: null, upName: 'UP丁', tags: ['火影忍者'] },
        ],
      },
    ],
  };
}

const stripTags = (shots) =>
  shots.map((shot) => ({
    round: shot.round,
    items: shot.items.map(({ tags, ...rest }) => rest),
  }));

test('summarizeExposure：不传 tags 时保持旧口径（未分类不进分母、不算 screen）', () => {
  const d = dataset();
  const r = summarizeExposure({ login: stripTags(d.login), guest: stripTags(d.guest) });

  assert.equal(r.login.count, 4);
  assert.equal(r.login.unclassified, 2);
  assert.equal(r.login.classified, 2);
  assert.equal(r.login.coverage, 0.5);
  assert.equal(r.guest.unclassified, 3);
  assert.equal(r.guest.classified, 1);
  assert.equal(r.guest.coverage, 0.25);
  assert.deepEqual(
    r.amplification.map((a) => a.id),
    ['ai'],
  );
});

test('summarizeExposure：透传 tags 后 tag-only 行被救回，放大倍数按新分母算', () => {
  const r = summarizeExposure(dataset());

  assert.equal(r.login.unclassified, 0);
  assert.equal(r.guest.unclassified, 0);
  assert.equal(r.login.classified, 4);
  assert.equal(r.guest.classified, 4);
  assert.equal(r.login.coverage, 1);
  assert.equal(r.guest.coverage, 1);

  const ai = r.amplification.find((a) => a.id === 'ai');
  assert.equal(ai.loginShare, 0.5);
  assert.equal(ai.guestShare, 0.25);
  assert.equal(ai.ratio, 2);

  const screen = r.amplification.find((a) => a.id === 'screen');
  assert.ok(screen, 'tag 应把「这段正片」那几行救成 screen');
  assert.equal(screen.name, '影视动漫');
  assert.equal(screen.loginShare, 0.5);
  assert.equal(screen.guestShare, 0.75);
  assert.equal(screen.ratio, 0.67);

  // Sorted by login-guest gap, so the amplified theme leads.
  assert.equal(r.amplification[0].id, 'ai');
});

test('summarizeExposure：tags 为空数组与完全不传 tags 结果一致', () => {
  const d = dataset();
  const empty = {
    login: d.login.map((s) => ({ round: s.round, items: s.items.map((it) => ({ ...it, tags: [] })) })),
    guest: d.guest.map((s) => ({ round: s.round, items: s.items.map((it) => ({ ...it, tags: [] })) })),
  };
  const plain = summarizeExposure({ login: stripTags(d.login), guest: stripTags(d.guest) });
  const withEmpty = summarizeExposure(empty);

  assert.equal(withEmpty.login.unclassified, plain.login.unclassified);
  assert.equal(withEmpty.guest.unclassified, plain.guest.unclassified);
  assert.equal(withEmpty.login.coverage, plain.login.coverage);
  assert.deepEqual(withEmpty.amplification, plain.amplification);
});

// ----------------------------------------------------------------------
// Dedup measure
// ----------------------------------------------------------------------

const ai = (bvid, upName) => ({ bvid, title: '大模型评测', tname: null, upName });
const game = (bvid, upName) => ({ bvid, title: '游戏攻略', tname: null, upName });

// Guest resampling the way the real library does it: the login feed is 10
// distinct videos, while the guest keeps re-serving the same 6 game videos over 3
// rounds and only ever shows the 2 AI videos once. Counting rows dilutes the AI
// share (2/20 = 0.10) and inflates the ratio; counting distinct videos does not
// (2/8 = 0.25).
function repeatHeavyDataset() {
  const loginItems = [
    ai('BVla1', 'UP甲'),
    ai('BVla2', 'UP甲'),
    ai('BVla3', 'UP丙'),
    ai('BVla4', 'UP丙'),
    ...Array.from({ length: 6 }, (_, i) => game(`BVlg${i}`, 'UP乙')),
  ];
  const gameRound = () => Array.from({ length: 6 }, (_, i) => game(`BVgg${i}`, 'UP丁'));

  return {
    rounds: 3,
    login: [{ round: 1, items: loginItems }],
    guest: [
      { round: 1, items: [ai('BVga1', 'UP戊'), ai('BVga2', 'UP戊'), ...gameRound()] },
      { round: 2, items: gameRound() },
      { round: 3, items: gameRound() },
    ],
  };
}

test('summarizeExposure：去重口径按 bvid 计数，ratioDedup 不再被游客重采样抬高', () => {
  const r = summarizeExposure(repeatHeavyDataset());

  // Row measure: untouched, exactly as before.
  assert.equal(r.login.count, 10);
  assert.equal(r.login.classified, 10);
  assert.equal(r.guest.count, 20);
  assert.equal(r.guest.classified, 20);
  assert.equal(r.guest.themes.get('game'), 18);
  assert.equal(r.guest.themes.get('ai'), 2);

  // Dedup measure: 20 guest rows collapse to 8 videos, the login side has no
  // repeats at all.
  assert.equal(r.login.dedup.count, 10);
  assert.equal(r.login.dedup.classified, 10);
  assert.equal(r.guest.dedup.count, 8);
  assert.equal(r.guest.dedup.classified, 8);
  assert.equal(r.guest.dedup.unclassified, 0);
  assert.equal(r.guest.dedup.coverage, 1);
  assert.equal(r.guest.dedup.themes.get('ai'), 2);
  assert.equal(r.guest.dedup.themes.get('game'), 6);

  const aiRow = r.amplification.find((a) => a.id === 'ai');
  assert.equal(aiRow.loginShare, 0.4);
  assert.equal(aiRow.guestShare, 0.1);
  assert.equal(aiRow.ratio, 4);
  assert.equal(aiRow.ratioDedup, 1.6);
  assert.ok(aiRow.ratioDedup < aiRow.ratio, '去重口径必须比行数口径更小');

  const gameRow = r.amplification.find((a) => a.id === 'game');
  assert.equal(gameRow.ratio, 0.67);
  assert.equal(gameRow.ratioDedup, 0.8);
  assert.notEqual(gameRow.ratio, gameRow.ratioDedup);
});

test('summarizeExposure：没有重复 bvid 时两套口径给出同一组倍数', () => {
  const r = summarizeExposure(dataset());

  assert.equal(r.login.dedup.count, r.login.count);
  assert.equal(r.guest.dedup.count, r.guest.count);
  for (const a of r.amplification) assert.equal(a.ratioDedup, a.ratio);
});

test('summarizeExposure：同一 bvid 分类冲突时去重取第一条，未分类单独计数', () => {
  const loginItems = [
    ai('BVsame', 'UP甲'),
    game('BVsame', 'UP甲'),
    { bvid: 'BVmystery', title: '挤爆了', tname: null, upName: 'UP乙' },
  ];
  const r = summarizeExposure({
    login: [{ round: 1, items: loginItems }],
    guest: [{ round: 1, items: [ai('BVguest1', 'UP丙')] }],
  });

  assert.equal(r.login.count, 3);
  assert.equal(r.login.dedup.count, 2);
  assert.equal(r.login.dedup.themes.get('ai'), 1);
  assert.equal(r.login.dedup.themes.get('game'), undefined);
  assert.equal(r.login.dedup.unclassified, 1);
  assert.equal(r.login.dedup.classified, 1);
  assert.equal(r.login.dedup.coverage, 0.5);
});
