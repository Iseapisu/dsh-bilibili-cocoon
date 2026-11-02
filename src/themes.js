// Theme classification: title keywords, second-level category fallback, and
// real video tags as a last-resort rescue for rows nothing else can read.
// Feeds the theme-concentration diagnostic, which is separate from category entropy.

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

// ---
// Tag vocabulary: the third (and last) evidence level, keyed by theme id.
//
// This is now a *seed and fallback*, not the source of truth. Per-tag verdicts
// live in the tag_theme table (src/store.js): one tag is judged once and stays
// valid forever, while videos arrive by the hundred every day, so the table is
// what absorbs new tags without a code change. The vocabulary below still runs
// for every tag the table does not own yet, which is why it has to stay
// byte-identical: it also produced every verdict the table was seeded from.
//
// Separate from THEMES[].keywords on purpose. Title keywords are tuned for
// written titles and stay frozen for comparability; tags are a different
// language (shorter, lowercase, some of them pure platform noise), so they get
// their own table that can be widened without touching a single past verdict.
//
// Every entry is lowercase because tag matching lowercases both sides: real
// tags come back as `comfyui` / `ComfyUi` / `deepseek`, while the title table
// spells them `ComfyUI` / `DeepSeek`, and the case-sensitive includes() used for
// titles silently misses the lowercase spelling.
//
// Assignments worth calling out:
// - 时政/地缘 tags (中东局势, 伊朗, 伊以局势, 胡塞, 亚洲局势, 也门, 沙特,
//   巴基斯坦, 欧洲局势, 地缘博弈) go to `knowledge`, not `life`. The existing
//   knowledge table already owns 战争/军事/历史/经济学/社会学, i.e. "explain how
//   the world works", and every one of these tags names a geopolitical topic.
//   Their region is almost always 日常/生活 (the uploader's own bucket), which is
//   precisely the coarse-and-wrong case this layer exists to catch. `life` would
//   only re-state the region we already had.
// - AI-ish tooling tags (comfyui, deepseek, qwen, qwenimage, seedance, minimax,
//   aivideo) go to `ai`, not `tech`: `tech` is hardware / DIY / 科工机械 (显卡,
//   装机, 火箭), while model, prompt and generation-workflow tags are the
//   `ai` theme's own subject matter.
// ---
export const TAG_KEYWORDS = new Map([
  ['ai', [
    'ai', 'aigc', '人工智能', '大模型', '生成式', '智能体', '提示词', '工作流',
    '数据集', 'ai绘画', 'ai视频', 'ai音乐', 'ai翻唱', 'ai短剧', 'ai生成',
    'ai创作', 'ai形象', 'ai剧情', 'aimv', 'comfyui', 'deepseek', 'qwen',
    'qwenimage', 'seedance', 'minimax', 'aivideo', 'midjourney',
    'stable diffusion', 'sora', 'chatgpt', 'claude', 'gemini', 'gpt', 'openai',
    'llm', 'krea', 'updream', 'runninghub', 'hugging face', '豆包',
  ]],
  ['game', [
    '游戏', '攻略', '速通', '解谜', '桌游', '卡牌', '炉石', '万智牌',
    '天天卡牌', '沙盒游戏', '我的世界', 'minecraft', '缺氧', '环世界', '饥荒',
    '宝可梦', 'pokemon', 'rpg', '明日方舟',
  ]],
  ['tech', [
    '硬件', '显卡', '芯片', '服务器', '编程', 'nas', '软件', '开源项目', '数码',
    '机械', '火箭', '星舰', '光伏', '风电', '输电', '变电站', '特高压',
  ]],
  ['knowledge', [
    '科普', '科学', '历史', '人文', '天文', '银河', '星系', '光学', '折射',
    '生物', '解剖', '财经', '股市', '金融', '投资', '经济', '国际', '时政',
    '地缘', '战争', '军事', '考古', '未解之谜',
    '中东', '伊朗', '伊以', '胡塞', '亚洲局势', '也门', '沙特', '巴基斯坦',
    '欧洲局势',
  ]],
  ['life', [
    '减肥', '减脂', '减重', '户外', '露营', '园艺', '种菜', '装修', '租房',
    '亲子', '旅行', '旅游',
  ]],
  ['food', [
    '美食', '探店', '关东煮', '日本料理', '吃货', '拉面', '烧烤', '饺子',
    '食品加工', '街头美食', '美食测评', '试吃', '干饭', '酱香饼', '火锅',
    '小吃', '咖啡', '烘焙', '菜谱', '做饭',
  ]],
  ['animal', [
    '动物', '萌宠', '宠物', '野生动物', '熊猫', '鹦鹉', '鸟类', '观鸟', '猫',
    '狗', '八哥', '神奇动物', '动物成精', '白蚁', '大象',
  ]],
  ['fun', [
    '搞笑', '抽象', '段子', '沙雕', '离谱', '翻车', '鬼畜', '名场面', '整蛊',
    '社死', '烂梗',
  ]],
  ['screen', [
    '电影', '影评', '影视', '动漫', '番剧', '动画', '短片', '微电影', '剧情',
    '二次元', 'cos', 'cosplay', '火影忍者', '写轮眼', '宇智波', '别天神', '天照',
  ]],
  ['music', [
    '音乐', '钢琴', '吉他', '翻唱', '演奏', '乐队', '演唱会', '歌曲', '听歌',
    'live',
  ]],
]);

// Tags that carry no subject matter: they describe the platform or the upload
// habit, not the topic. Filtered before matching so a video tagged only
// ['vlog', '原创'] reaches the next level instead of producing a wrong verdict.
const NOISE_TAGS = new Set([
  'vlog', '原创', '生活记录', '高能', '4k', '经验分享', '评论区', '整活', '吐槽',
  '官方知识付费内容',
]);

// Campaign / event tags, which name a Bilibili activity rather than a subject.
const ACTIVITY_TAG = /B站|大赛|计划|总动员|必看|有奖|共创|无限竞技场/i;

// Short ASCII keys ('ai', 'gpt', 'cos') must not match inside unrelated words -
// plain includes() would read 'paint' or 'trailer' as AI. They match on both
// sides of a non-alphanumeric boundary instead. Longer keys stay substring
// matches so 'comfyui' still hits 'comfyui工作流'.
const SHORT_ASCII = /^[a-z0-9]{1,3}$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matcherFor(kw) {
  if (!SHORT_ASCII.test(kw)) return (tag) => tag.includes(kw);
  const re = new RegExp(`(?<![a-z0-9])${escapeRe(kw)}(?![a-z0-9])`);
  return (tag) => re.test(tag);
}

const TAG_MATCHERS = new Map(
  [...TAG_KEYWORDS].map(([id, keywords]) => [id, keywords.map(matcherFor)]),
);

export const UNCLASSIFIED = 'unclassified';

const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]));
export const THEME_NAMES = new Map([
  [UNCLASSIFIED, '其他/未分类'],
  ...THEMES.map((t) => [t.id, t.name]),
]);

const REGION_TO_THEME = new Map();
for (const theme of THEMES) {
  for (const region of theme.regions) REGION_TO_THEME.set(region, theme.id);
}

// ---
// Single-tag resolution: the unit of classification is a tag, not a video.
//
// 2.5k tags need one verdict each and stay valid forever; videos are turnover.
// So the pipeline is: tag_theme table first (permanent verdicts), then the
// lexicon (free fast path), and only then a human or an LLM. This round only
// wires the first two.
// ---

// A themeMap value is either a bare theme id (host-side Map<tag, theme>) or the
// store's { theme, source, confidence } entry. Accepting both keeps the callers
// from having to remember which one a given helper returns.
function themeOfEntry(value) {
  if (typeof value === 'string') return value;
  return typeof value?.theme === 'string' ? value.theme : null;
}

const cleanTagOf = (tag) => String(tag ?? '').trim().toLowerCase();

// True for tags that name the platform or a campaign rather than a subject.
// Exported so tools/classify-tags.mjs can tell "no theme by policy" from "no
// theme yet" and skip permanent noise like 'vlog'.
export function isNoiseTag(tag) {
  const clean = cleanTagOf(tag);
  if (!clean) return false;
  return NOISE_TAGS.has(clean) || ACTIVITY_TAG.test(clean);
}

// Every theme the lexicon credits for one tag, in THEMES order (usually 0 or 1,
// occasionally several for composite tags such as 'ai音乐'). Exported because
// the offline filler has to tell an unambiguous tag (exactly one theme: safe to
// freeze in the table) from an ambiguous one (several: never guessed into the
// table).
export function lexiconThemesOf(tag) {
  const clean = cleanTagOf(tag);
  if (!clean || isNoiseTag(clean)) return [];

  const out = [];
  for (const theme of THEMES) {
    const matchers = TAG_MATCHERS.get(theme.id);
    if (matchers && matchers.some((matches) => matches(clean))) out.push(theme.id);
  }
  return out;
}

// One tag -> one theme id, or null when no evidence resolves it. The table wins
// over the lexicon, so a manual/llm correction takes effect without touching
// this file. Noise and campaign tags resolve to null by policy, whether or not
// someone wrote a row for them: they name the platform, not a subject.
export function resolveTagTheme(tag, themeMap) {
  const clean = cleanTagOf(tag);
  if (!clean || isNoiseTag(clean)) return null;

  const stored = themeOfEntry(themeMap?.get?.(clean));
  if (stored && THEME_BY_ID.has(stored)) return stored;

  const byLexicon = lexiconThemesOf(clean);
  return byLexicon.length ? byLexicon[0] : null;
}

// Tag-only verdict: lowercase, drop noise, then score each theme by how many
// distinct tags it can explain. Ties keep the THEMES order, exactly like the
// title pass. Returns UNCLASSIFIED when nothing survives.
//
// Two evidence sources feed the same vote:
//   - tag_theme (`themeMap`) - authoritative for the tags it owns. Keys are the
//     lowercased tag; values may be a theme id or the store's
//     { theme, source, confidence } entry. A tag it owns casts exactly one vote.
//   - TAG_KEYWORDS - the seed/fallback for tags it does not own. A composite tag
//     can be credited to more than one theme here ('ai音乐' holds both an `ai`
//     and a `music` keyword), and that multiplicity is part of the frozen
//     scoring every published figure was measured under, so it is reproduced
//     verbatim rather than collapsed to a single theme.
function classifyByTags(tags, themeMap) {
  if (!Array.isArray(tags) || tags.length === 0) return UNCLASSIFIED;

  const cleaned = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase();
    if (!tag) continue;
    // Noise and campaign tags carry no subject matter; the check runs before the
    // table is consulted so a stray manual row can never turn 'vlog' into a theme.
    if (NOISE_TAGS.has(tag) || ACTIVITY_TAG.test(tag)) continue;
    cleaned.push(tag);
  }
  if (!cleaned.length) return UNCLASSIFIED;

  const scores = new Map();
  for (const tag of cleaned) {
    const stored = themeOfEntry(themeMap?.get?.(tag));
    const ids = stored && THEME_BY_ID.has(stored) ? [stored] : lexiconThemesOf(tag);
    for (const id of ids) scores.set(id, (scores.get(id) ?? 0) + 1);
  }

  let bestId = UNCLASSIFIED;
  let bestScore = 0;
  for (const theme of THEMES) {
    const score = scores.get(theme.id) ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestId = theme.id;
    }
  }
  return bestScore > 0 ? bestId : UNCLASSIFIED;
}

// Evidence order, and why the tag level sits last rather than above the region:
//   1. title keywords - unchanged, byte for byte. Such rows already have a
//                       verdict and tags never get a say.
//   2. region         - also unchanged. It alone classifies the majority of rows
//                       that have no title signal; letting tags answer before it
//                       rewrote 26 of those verdicts when measured on the real
//                       library, and every downstream figure (the AI
//                       amplification ratio, the cocoon index, the whole trend
//                       line) is only comparable while the verdicts hold still.
//                       Tags therefore never override a region verdict.
//   3. tags           - new layer, fires only where title and region both miss.
//   4. unclassified
// The order costs nothing: a tag verdict can only rescue a row the region
// already failed on, so coverage is identical either way. The only difference is
// whether 26 past verdicts get rewritten.
//
// `themeMap` is optional and fourth on purpose: omitting it reproduces the
// pre-table verdicts byte for byte, which is what every stored figure was
// measured under. Pass loadTagThemeMap(db) / listTagThemes(store) to let the
// table's per-tag verdicts stand in for the lexicon.
export function classifyTheme(title, tname, tags, themeMap) {
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
  return classifyByTags(tags, themeMap);
}

export function themeName(id) {
  return THEME_BY_ID.get(id)?.name ?? THEME_NAMES.get(id) ?? '其他/未分类';
}
