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
