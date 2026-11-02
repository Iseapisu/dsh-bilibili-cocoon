// src/themes.js
// 主题归类：把一条内容归到一个粗粒度主题上，用来度量「主题浓度」。
//
// 为什么需要：分区熵只回答「你看了多少个分区」。一个人可以在 19 个一级分区里横跳，
// 内容却全挤在「AI / 大模型」这一个主题带上——分区熵满分，主题浓度很高。
// 2026-11-02 的数据就是这样：熵 0.726（开阔），AI 相关标题占 16.7%。
//
// 判定顺序（先强信号，后弱信号）：
//   1. 标题关键词——命中词最多的主题胜出，平票取 THEMES 里靠前的
//   2. 二级分区兜底——标题常常是纯口语（「挤爆了」「草莓咪」），没有主题信息；
//      这时用 tname 查主题的 regions 列表。二级分区比一级精确得多，不会把
//      「知识区里的编程教程」错算成 AI
//   3. 都没有 → unclassified，覆盖率单独报告，不混进浓度
//
// 英文词的边界：中文环境里 \b 不可靠（「AI早报」里 AI 后面是中文），
// 所以用「前后不是 ASCII 字母」来界定，见 notLetter。

/** 「前后不是英文字母」——给 AI/GPT 这类短词用的边界，避免匹配到 RAID / Mail。 */
const notLetter = (w) => new RegExp(`(?<![A-Za-z])${w}(?![A-Za-z])`, 'i');

export const THEMES = [
  {
    id: 'ai',
    name: 'AI / 大模型',
    keywords: [
      '大模型', '人工智能', '机器学习', '深度学习', '神经网络', '智能体', '提示词',
      '文生图', '文生视频', '算力', '微调', '推理', '模型评测', '开源模型',
      'AIGC', 'ComfyUI', 'Stable Diffusion', 'Midjourney', 'DeepSeek', 'ChatGPT',
      'Claude', 'Gemini', 'Copilot', 'Qwen', '千问', 'FLUX', 'MOSS', 'ChatGLM',
      'Sora', 'token', 'prompt', 'Agent', 'LLM', 'GPT', notLetter('AI'),
    ],
    // 这些二级分区里的内容几乎必然是 AI 相关（但 AI 内容也会出现在其他分区，
    // 所以只做兜底、不做唯一来源）
    regions: [],
  },
  {
    id: 'game',
    name: '游戏',
    keywords: [
      '游戏', '攻略', '实况', '通关', '速通', '开荒', '卡组', '炉石', '我的世界',
      'Minecraft', '缺氧', '原神', '星穹铁道', '星铁', '明日方舟', '三角洲', '影之刃',
      '黑神话', '塞尔达', '宝可梦', '排位', '上分', '存档', '法环',
      '英雄联盟', 'LOL', 'CSGO', 'Valorant', '无畏契约', '永劫无间', '蛋仔',
      'PVP', '副本', 'BOSS',
    ],
    regions: [
      '单机游戏', '网络游戏', '手机游戏', '桌游棋牌', '电子竞技', '音游',
      'GMV', '主机游戏',
    ],
  },
  {
    id: 'tech',
    name: '科技数码',
    keywords: [
      '显卡', 'CPU', '笔记本', '装机', '跑分', '评测', '外设', '键盘', '显示器',
      '芯片', '苹果', '华为', '小米', 'iOS', '安卓', '鸿蒙', '刷机', 'NAS', 'nas',
      '软路由', 'docker', 'Docker', '服务器', 'Linux', 'linux', '编程', '代码',
      '算法', '数据结构', '插件', '机器人', '光伏', '风电', '火箭', '卫星',
    ],
    regions: ['数码', '计算机技术', '软件应用', '极客DIY', '科工机械'],
  },
  {
    id: 'knowledge',
    name: '知识科普',
    keywords: [
      '科普', '原理', '为什么会', '揭秘', '冷知识', '历史', '数学', '物理', '化学',
      '生物', '哲学', '心理', '法律', '考古', '天文', '量子', '战争', '军事',
      '经济学', '社会学', '语言学', '维特根斯坦', '达尔文', '恐龙', '遗忘曲线',
    ],
    regions: [
      '科学科普', '人文历史', '社科·法律·心理', '校园学习', '财经商业',
      '职业职场', '设计·创意', '野生技能协会',
    ],
  },
  {
    id: 'life',
    name: '生活日常',
    keywords: [
      'vlog', 'Vlog', '日常', '记录', '生活', '旅游', '旅行', '减肥', '健身',
      '装修', '租房', '副业', '存钱', '打工人', '上班', '学生', '大学', '支教',
      '乡村', '农村', '相亲', '结婚', '带娃', '亲子', '二手', '省钱', '摆摊',
    ],
    regions: ['日常', '亲子', '出行', '三农', '家居房产', '健身', '运动文化'],
  },
  {
    id: 'food',
    name: '美食',
    keywords: [
      '美食', '做饭', '菜谱', '料理', '探店', '小吃', '火锅', '烧烤', '面包',
      '咖啡', '奶茶', '零食', '食堂', '厨', '烘焙', '下厨', '酱香饼',
    ],
    regions: ['美食记录', '美食制作', '美食测评', '美食侦探', '田园美食'],
  },
  {
    id: 'animal',
    name: '动物萌宠',
    keywords: [
      '猫', '狗', '宠物', '喵', '汪', '动物', '野生动物', '熊猫', '仓鼠', '鹦鹉',
      '动物园', '萌宠', '小宠', '异宠', '救助', '白蚁',
    ],
    regions: ['喵星人', '汪星人', '野生动物', '小宠异宠', '动物二创', '动物圈', '动物综合'],
  },
  {
    id: 'fun',
    name: '搞笑整活',
    keywords: [
      '搞笑', '整活', '沙雕', '抽象', '段子', '笑死', '离谱', '鬼畜', '名场面',
      '迷惑行为', '社死', '翻车', '嘴硬', '整蛊',
    ],
    regions: ['鬼畜调教', '鬼畜剧场', '搞笑'],
  },
  {
    id: 'screen',
    name: '影视动漫',
    keywords: [
      '电影', '电视剧', '动漫', '番剧', '新番', '解说', '影评', '剧情', '角色',
      'MAD', 'AMV', 'cos', 'COS', '预告', '短片', '手书', '同人',
    ],
    regions: ['影视剪辑', '影视杂谈', '短片', '小剧场', '预告·资讯', '动漫杂谈', 'MMD·3D', 'MAD·AMV', '同人·手书'],
  },
  {
    id: 'music',
    name: '音乐',
    keywords: [
      '音乐', '翻唱', '演奏', '编曲', '吉他', '钢琴', '唱歌', '歌曲', 'MV',
      'VOCALOID', '乐评', '演唱会', 'live', 'Live',
    ],
    regions: ['音乐综合', '原创音乐', '翻唱', '演奏', '乐评盘点', 'MV', '音乐现场', '音乐教学'],
  },
];

export const UNCLASSIFIED = 'unclassified';

const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]));
export const THEME_NAMES = new Map([
  [UNCLASSIFIED, '其他/未分类'],
  ...THEMES.map((t) => [t.id, t.name]),
]);

// 二级分区名 → 主题 id 的倒排表
const REGION_TO_THEME = new Map();
for (const theme of THEMES) {
  for (const region of theme.regions) REGION_TO_THEME.set(region, theme.id);
}

/**
 * 归类一条内容。
 * @param {string} title 视频标题
 * @param {string} [tname] 二级分区名（可选，用于兜底）
 * @returns {string} 主题 id 或 UNCLASSIFIED
 */
export function classifyTheme(title, tname) {
  const text = String(title ?? '');
  if (text) {
    let bestId = UNCLASSIFIED;
    let bestScore = 0;
    for (const theme of THEMES) {
      let score = 0;
      for (const kw of theme.keywords) {
        if (kw instanceof RegExp ? kw.test(text) : text.includes(kw)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestId = theme.id;
      }
    }
    if (bestScore > 0) return bestId;
  }
  const region = String(tname ?? '').trim();
  if (region) {
    const byRegion = REGION_TO_THEME.get(region);
    if (byRegion) return byRegion;
  }
  return UNCLASSIFIED;
}

export function themeName(id) {
  return THEME_BY_ID.get(id)?.name ?? THEME_NAMES.get(id) ?? '其他/未分类';
}
