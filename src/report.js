// Renders a Markdown report from a cocoonScore result. Pure rendering, no IO.

import { categoryCounts, uploaderCounts } from './metrics.js';

const LEVEL_SENTENCE = {
  开阔: '你看到的内容在多个一级分区之间散开，UP 主分布也不算集中。',
  偏窄: '内容已经开始向你熟悉的领域倾斜，主动扩列能把视野拉回来。',
  明显收窄: '内容明显向少数分区和 UP 主集中，继续这样会越来越难刷到圈外内容。',
  强茧房: '内容高度集中在少数分区和 UP 主，已经形成较强茧房，需要主动打破循环。',
  无数据: '没有可用样本，什么也说明不了。',
};

// The index has no theme term and its level scale is blunt: a single theme only
// crosses 25 ("偏窄") at ~57% of the sample, so "开阔" covers most healthy-looking
// and many not-so-healthy samples alike. Say both next to the verdict, otherwise
// the level reads as a clean bill of health.
const SCOPE_CAVEAT =
  '这个数只反映分区和 UP 主的分布，不反映题材是否集中。' +
  '按当前刻度，单一主题要占到约 57% 才会被判定为「偏窄」；「开阔」是低门槛的默认档，不等于「没问题」。';

function pct(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '-';
  return `${(n * 100).toFixed(1)}%`;
}

function num(x, digits = 2) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function fallbackTop(items, kind) {
  const counts = kind === 'category' ? categoryCounts(items) : uploaderCounts(items);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, n]) => ({ name, n }));
}

export function renderReport(result, opts = {}) {
  if (!result || typeof result !== 'object') {
    throw new TypeError('renderReport 需要 cocoonScore 的结果对象');
  }

  const items = opts.items ?? opts.feed ?? result.items ?? [];
  const cats = result.topCategories?.length ? result.topCategories : fallbackTop(items, 'category');
  const ups = result.topUploaders?.length ? result.topUploaders : fallbackTop(items, 'uploader');
  const total = Number(result.sampleSize ?? 0);
  const basisLabel = result.basis === 'history' ? '观看历史' : '推荐流（历史样本不足）';

  const lines = [];
  lines.push(
    `> **结论：分区-UP 集中度 ${num(result.index, 1)} / 100 ——「${result.level}」**。${LEVEL_SENTENCE[result.level] ?? ''}`,
  );
  lines.push('>');
  lines.push(`> ${SCOPE_CAVEAT}`);
  lines.push('');
  lines.push(`## 🧭 分区-UP 集中度报告（${result.date ?? '-'}）`);
  lines.push('');
  lines.push(`- 样本：**${total}** 条${basisLabel}（推荐流 ${result.feedSize ?? 0} 条作对照）`);
  lines.push(`- 分区-UP 集中度：**${num(result.index, 1)} / 100**（越高越集中；公式不含题材维度）`);
  lines.push(`- 等级：**${result.level}**`);
  lines.push('');

  if (total < 100) {
    lines.push(`> ⚠️ 样本不足（${total} < 100），熵的估计不稳，结论仅供参考。`);
    lines.push('');
  }

  lines.push('### 📊 核心指标');
  lines.push('');
  lines.push('| 指标 | 值 | 这个数说明什么 |');
  lines.push('| --- | ---: | --- |');
  lines.push(
    `| 有效分区数 | ${num(result.effectiveCategories, 2)} | exp(熵)，等价于「你实际只看了约这么多个一级分区」 |`,
  );
  lines.push(
    `| 归一化熵 | ${num(result.entropyNorm, 3)} | 除以 ln(19) 后的宽度，1.0 = 19 个分区均分；95% 区间 ${result.entropyCI?.[0] ?? '-'} ~ ${result.entropyCI?.[1] ?? '-'} |`,
  );
  lines.push(`| 集中度 HHI | ${num(result.hhi, 3)} | 1.0 表示所有内容集中在一个分区 |`);
  lines.push(`| UP 曝光基尼 | ${num(result.gini, 3)} | 越高越说明内容来自少数几个 UP |`);
  lines.push(`| UP 重复率 | ${pct(result.uploaderRepeat)} | 出现超过一次的 UP 占比 |`);
  lines.push('');

  lines.push('### 🎚 子项分数（0–100）');
  lines.push('');
  lines.push('| 子项 | 分数 | 方向 |');
  lines.push('| --- | ---: | --- |');
  lines.push(`| 多样性 diversity | ${num(result.subscores?.diversity, 1)} | 越高越健康 |`);
  lines.push(`| 集中度 concentration | ${num(result.subscores?.concentration, 1)} | 越高越封闭 |`);
  lines.push(`| 重复度 repetition | ${num(result.subscores?.repetition, 1)} | 越高越封闭 |`);
  lines.push('');

  lines.push('### 🔬 诊断项（不进主分）');
  lines.push('');
  lines.push('| 指标 | 值 | 说明 |');
  lines.push('| --- | ---: | --- |');
  lines.push(
    `| 与全站热门重合度 | ${pct(result.overlapWithRanking)} | 抽样量小，结构上接近 0，**不能单独当结论** |`,
  );
  lines.push(
    `| 推荐 vs 历史 JSD | ${num(result.calibration, 3)} | 0 = 推荐和你在看的一致；越大越偏离 |`,
  );
  lines.push('');

  lines.push('### 🗂 TOP5 一级分区');
  lines.push('');
  lines.push('| # | 分区 | 条数 | 占比 |');
  lines.push('| ---: | --- | ---: | ---: |');
  cats.forEach((c, i) => {
    const share = total ? c.n / total : 0;
    lines.push(`| ${i + 1} | ${c.name} | ${c.n} | ${pct(share)} |`);
  });
  lines.push('');

  const th = result.themes;
  if (th && th.top?.length) {
    lines.push('### 🧩 主题浓度');
    lines.push('');
    lines.push(
      `分类口径：标题关键词优先，标题没信号时用二级分区兜底；覆盖率 **${pct(th.coverage)}**（未分类 ${th.unclassified} 条不进分母）。`,
    );
    lines.push('');
    lines.push('| 指标 | 值 | 说明 |');
    lines.push('| --- | ---: | --- |');
    lines.push(`| 主主题 | ${th.topName ?? '-'} | 占已分类内容的 ${pct(th.topShare)} |`);
    lines.push(`| 主题集中度 | ${num(th.concentration, 3)} | 已分类里最大主题的占比，越高越单一 |`);
    lines.push(
      `| 有效主题数 | ${num(th.effective, 2)} | exp(主题熵)。对比：有效分区数 ${num(result.effectiveCategories, 2)} |`,
    );
    lines.push('');
    lines.push('| # | 主题 | 条数 | 占已分类 |');
    lines.push('| ---: | --- | ---: | ---: |');
    th.top.forEach((t, i) => lines.push(`| ${i + 1} | ${t.name} | ${t.n} | ${pct(t.share)} |`));
    lines.push('');
    if ((result.effectiveCategories ?? 0) - (th.effective ?? 0) > 3) {
      lines.push(
        `> 分区维度有 ${num(result.effectiveCategories, 1)} 个，主题维度只有 ${num(th.effective, 1)} 个——` +
          '你刷的分区很宽，但这几天的内容其实收在少数几个主题上，换分区不等于换脑子。',
      );
      lines.push('');
    }
  }

  lines.push('### 👤 TOP5 UP 主');
  lines.push('');
  lines.push('| # | UP 主 | 条数 |');
  lines.push('| ---: | --- | ---: |');
  ups.forEach((u, i) => lines.push(`| ${i + 1} | ${u.name ?? '未知'} | ${u.n} |`));
  lines.push('');

  lines.push('### ✅ 可执行建议');
  lines.push('');
  const advice = [];
  if ((result.entropyNorm ?? 0) < 0.5) {
    advice.push('**主动扩分区**：每周挑 2~3 个你几乎不看的二级分区各看 3 条以上，把有效分区数拉起来。');
  }
  if ((result.hhi ?? 0) > 0.3) {
    advice.push('**打断单分区依赖**：主分区内容占比控制在一半以内，其余用搜索和关注列表补齐。');
  }
  if ((result.gini ?? 0) > 0.4) {
    advice.push('**换一批 UP**：连续两周刻意关注几个陌生 UP，降低曝光基尼。');
  }
  if (advice.length === 0) {
    advice.push('**保持现状**：当前结构健康，每两周复测一次即可。');
  }
  advice.push('**定期复测**：指数趋势比单次绝对值有意义，连续两次上升再调整。');
  advice.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(
    '口径：主指标沿用 Fu et al. (2024) 在 B站上的做法——**一级分区上的信息熵**，样本为观看历史；' +
      '有效分区数为 Hill 数 exp(H)；重合度与 JSD 仅作诊断。',
  );

  return lines.join('\n');
}
