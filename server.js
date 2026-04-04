const express = require('express');
const RSSParser = require('rss-parser');
const cron = require('node-cron');
const path = require('path');

const app = express();
const parser = new RSSParser({ timeout: 10000 });
const PORT = process.env.PORT || 3000;

// --- Gemini API Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let geminiModel = null;
if (GEMINI_API_KEY) {
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    console.log('Gemini API initialized');
  } catch (err) {
    console.warn('Failed to initialize Gemini API:', err.message);
  }
} else {
  console.log('No GEMINI_API_KEY set, using local processing mode');
}

// --- RSS Sources ---
const FEEDS = [
  { name: 'Hacker News', url: 'https://hnrss.org/newest?q=AI+OR+LLM+OR+GPT+OR+Claude+OR+machine+learning&points=50', weight: 3, color: '#ff6600' },
  { name: 'ArXiv CS.AI', url: 'http://export.arxiv.org/rss/cs.AI', weight: 2, color: '#b31b1b' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', weight: 2, color: '#0a9e01' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', weight: 2, color: '#e5127d' },
  { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', weight: 2, color: '#9b2fae' },
];

// --- AI Terms Dictionary (sorted by length descending for greedy matching) ---
const AI_TERMS = [
  ['large language model', '大语言模型'], ['language model', '语言模型'],
  ['machine learning', '机器学习'], ['deep learning', '深度学习'],
  ['reinforcement learning', '强化学习'], ['transfer learning', '迁移学习'],
  ['supervised learning', '监督学习'], ['unsupervised learning', '无监督学习'],
  ['context window', '上下文窗口'], ['attention mechanism', '注意力机制'],
  ['code generation', '代码生成'], ['image generation', '图像生成'],
  ['video generation', '视频生成'], ['text generation', '文本生成'],
  ['speech recognition', '语音识别'], ['object detection', '目标检测'],
  ['natural language processing', '自然语言处理'],
  ['natural language', '自然语言'], ['computer vision', '计算机视觉'],
  ['artificial intelligence', '人工智能'], ['neural network', '神经网络'],
  ['convolutional neural', '卷积神经'], ['recurrent neural', '循环神经'],
  ['generative adversarial', '生成对抗'], ['diffusion model', '扩散模型'],
  ['foundation model', '基础模型'], ['training method', '训练方法'],
  ['training data', '训练数据'], ['world model', '世界模型'],
  ['vision language', '视觉语言'], ['knowledge graph', '知识图谱'],
  ['autonomous driving', '自动驾驶'], ['autonomous agent', '自主智能体'],
  ['prompt engineering', '提示工程'], ['retrieval augmented', '检索增强'],
  ['open source', '开源'], ['open-source', '开源'],
  ['state-of-the-art', '最先进的'], ['real-time', '实时'],
  ['end-to-end', '端到端'], ['pre-trained', '预训练'],
  ['fine-tuned', '微调的'], ['fine-tuning', '微调'],
  ['zero-shot', '零样本'], ['few-shot', '少样本'],
  ['multi-modal', '多模态'], ['multimodal', '多模态'],
  ['transformer', 'Transformer'], ['benchmark', '基准测试'],
  ['reasoning', '推理能力'], ['inference', '推理'],
  ['alignment', '对齐'], ['safety', '安全性'],
  ['autonomous', '自主的'], ['regulation', '监管'],
  ['breakthrough', '突破性进展'], ['architecture', '架构'],
  ['deployment', '部署'], ['parameter', '参数'],
  ['agent', '智能体'], ['embedding', '嵌入'],
  ['hallucination', '幻觉问题'], ['scalability', '可扩展性'],
  ['healthcare', '医疗领域'], ['robotics', '机器人技术'],
  ['funding', '融资'], ['dataset', '数据集'],
  ['GPUs', 'GPU'], ['GPU', 'GPU'], ['TPU', 'TPU'], ['API', 'API'], ['APIs', 'API'],
  ['chatbot', '聊天机器人'], ['copilot', '智能助手'],
  ['plugin', '插件'], ['workflow', '工作流'],
  ['productivity', '生产力'], ['efficiency', '效率'],
  ['accuracy', '准确率'], ['latency', '延迟'],
  ['throughput', '吞吐量'], ['optimization', '优化'],
  ['model', '模型'], ['token', 'token'],
  ['launches', '发布了'], ['released', '发布了'],
  ['releases', '发布'], ['announces', '宣布'],
  ['introduced', '推出了'], ['unveiled', '揭示了'],
  ['achieves', '实现了'], ['enables', '实现了'],
  ['researchers', '研究人员'], ['developer', '开发者'],
  ['performance', '性能'], ['capability', '能力'],
  ['feature', '功能'], ['framework', '框架'],
];

// --- Translate text using dictionary ---
function translateText(enText) {
  let result = enText;
  for (const [en, zh] of AI_TERMS) {
    const regex = new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    result = result.replace(regex, zh);
  }
  return result;
}

// --- Auto-assign tags based on keywords ---
function assignTags(title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  const tags = [];

  if (/\b(model|architecture|algorithm|neural|transformer|diffusion|llm|gpt|bert)\b/i.test(text)) tags.push('model');
  if (/\b(launch|release|announc|new product|beta|preview|available|ship)\b/i.test(text)) tags.push('product');
  if (/\b(research|paper|arxiv|study|experiment|findings|propose|novel)\b/i.test(text)) tags.push('research');
  if (/\b(open.?source|github|apache|mit license|hugging\s*face)\b/i.test(text)) tags.push('open-source');
  if (/\b(regulat|law|act|compliance|eu ai|govern|policy|ban)\b/i.test(text)) tags.push('regulation');
  if (/\b(safety|bias|ethic|harmful|responsible|risk|guardrail)\b/i.test(text)) tags.push('safety');
  if (/\b(fund|rais|invest|series [a-d]|valuation|billion|million.*capital)\b/i.test(text)) tags.push('funding');
  if (/\b(breakthrough|state.of.the.art|sota|record|first|unprecedented|milestone)\b/i.test(text)) tags.push('breakthrough');
  if (/\b(infrastr|compute|gpu|hardware|chip|datacenter|cloud)\b/i.test(text)) tags.push('infrastructure');
  if (/\b(application|use case|deploy|production|real.world|healthcare|finance|education)\b/i.test(text)) tags.push('application');

  return tags.length > 0 ? [...new Set(tags)] : ['ai'];
}

// --- Five-dimension scoring ---
const DIMENSION_KEYWORDS = {
  technical: ['novel', 'breakthrough', 'architecture', 'benchmark', 'sota', 'state-of-the-art',
    'algorithm', 'efficient', 'scalable', 'transformer', 'diffusion', 'training',
    'optimization', 'parameter', 'accuracy', 'performance', 'method', 'technique',
    'innovation', 'advance', 'improve', 'outperform', 'surpass'],
  industry: ['company', 'enterprise', 'deploy', 'adoption', 'product', 'launch',
    'partnership', 'revenue', 'billion', 'market', 'commercial', 'release',
    'google', 'microsoft', 'openai', 'meta', 'anthropic', 'apple', 'amazon',
    'startup', 'business', 'customer', 'integration'],
  public: ['viral', 'trending', 'mainstream', 'consumer', 'accessible', 'user',
    'everyone', 'democratize', 'open source', 'free', 'popular', 'widely',
    'million users', 'download', 'community', 'social', 'media', 'attention',
    'controversial', 'debate', 'public'],
  practical: ['application', 'real-world', 'use case', 'production', 'deploy',
    'practical', 'solve', 'problem', 'improve', 'efficiency', 'productivity',
    'healthcare', 'finance', 'education', 'automate', 'tool', 'workflow',
    'cost', 'faster', 'better', 'mobile', 'device'],
  future: ['potential', 'future', 'could', 'possibility', 'path to', 'towards',
    'step towards', 'enable', 'unlock', 'next generation', 'revolutionize',
    'transformative', 'paradigm', 'emerging', 'frontier', 'vision',
    'long-term', 'implications', 'reshape'],
};

const TAG_DIMENSION_BOOST = {
  model: 'technical', product: 'industry', 'open-source': 'public',
  application: 'practical', research: 'future', breakthrough: 'technical',
  funding: 'industry', regulation: 'public', infrastructure: 'practical',
  safety: 'future',
};

function scoreDimensions(title, summary, tags) {
  const text = (title + ' ' + summary).toLowerCase();
  const scores = {};

  for (const [dim, keywords] of Object.entries(DIMENSION_KEYWORDS)) {
    let score = 20;
    let matchCount = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) matchCount++;
    }
    score += Math.min(matchCount * 8, 60);
    // Tag boost
    for (const tag of tags) {
      if (TAG_DIMENSION_BOOST[tag] === dim) score += 15;
    }
    scores[dim] = Math.min(100, score);
  }

  const overall = Math.round(
    (scores.technical + scores.industry + scores.public + scores.practical + scores.future) / 5
  );

  return { score: overall, scores };
}

// --- Generate detail text (different from summary) ---
const DETAIL_TEMPLATES_ZH = {
  model: [
    '该模型/架构的发布标志着AI技术的又一重要进展。',
    '从技术角度来看，这一创新有望推动相关领域的进一步发展，并为后续研究提供新的方向。',
  ],
  product: [
    '该产品的推出将为用户带来全新的AI体验。',
    '业内分析人士认为，这一举措将加速AI技术在实际场景中的落地应用。',
  ],
  research: [
    '这项研究为AI领域提供了新的理论基础和实践思路。',
    '研究成果有望在未来推动相关技术的突破性发展。',
  ],
  'open-source': [
    '开源社区对此反应积极，预计将吸引大量开发者参与贡献。',
    '开源策略有助于加速技术迭代和生态建设。',
  ],
  regulation: [
    '这一监管动态将对AI行业的发展方向产生深远影响。',
    '各方需要密切关注政策变化，及时调整合规策略。',
  ],
  safety: [
    'AI安全问题持续受到业界和公众的高度关注。',
    '如何在推动创新的同时确保安全性，仍是行业面临的核心挑战。',
  ],
  funding: [
    '此轮融资反映了资本市场对AI赛道的持续看好。',
    '充足的资金支持将加速产品研发和市场扩张。',
  ],
  breakthrough: [
    '这一突破性进展引发了业界的广泛关注和讨论。',
    '专家认为，这可能标志着该领域发展进入新阶段。',
  ],
  default: [
    '这一进展体现了AI技术持续快速发展的趋势。',
    '未来该领域有望涌现更多创新成果。',
  ],
};

const DETAIL_TEMPLATES_EN = {
  model: 'This advancement represents a significant step forward in AI model development, with potential implications for both research and commercial applications.',
  product: 'The release signals growing maturity in AI product development and could reshape how users interact with AI-powered tools.',
  research: 'This research contributes important new insights to the field and may open up novel directions for future investigation.',
  'open-source': 'The open-source approach is expected to accelerate community-driven innovation and broaden access to cutting-edge AI capabilities.',
  regulation: 'This regulatory development will have significant implications for how AI systems are developed, deployed, and governed.',
  safety: 'The focus on AI safety reflects the growing recognition that responsible development is essential for sustainable progress.',
  funding: 'This investment reflects strong market confidence in AI and will likely accelerate development timelines.',
  breakthrough: 'This breakthrough could mark a turning point in the field, opening up possibilities that were previously considered out of reach.',
  default: 'This development highlights the rapid pace of innovation in AI and its expanding influence across industries.',
};

function generateDetail(summary, tags, lang) {
  const primaryTag = tags[0] || 'default';
  if (lang === 'zh') {
    const zhSummary = translateText(summary);
    const templates = DETAIL_TEMPLATES_ZH[primaryTag] || DETAIL_TEMPLATES_ZH.default;
    return zhSummary + '\n\n' + templates.join('');
  } else {
    const template = DETAIL_TEMPLATES_EN[primaryTag] || DETAIL_TEMPLATES_EN.default;
    return summary + '\n\n' + template;
  }
}

// --- Generate reason ---
const REASON_MAP_ZH = {
  model: '涉及重要AI模型技术进展，具有较高技术价值',
  product: '重要AI产品发布，影响行业格局',
  research: '前沿AI研究成果，推动学术进步',
  'open-source': '开源项目动态，促进AI技术普惠',
  regulation: '重要AI监管政策变动，影响行业发展',
  safety: 'AI安全议题，关乎技术发展方向',
  funding: 'AI领域重要融资动态，反映市场趋势',
  breakthrough: '突破性AI技术进展，具有里程碑意义',
  infrastructure: 'AI基础设施发展，支撑行业生态',
  application: 'AI实际应用落地，展现技术价值',
  default: '近期AI领域值得关注的重要事件',
};

const REASON_MAP_EN = {
  model: 'Significant AI model advancement with high technical impact',
  product: 'Major AI product launch reshaping the industry landscape',
  research: 'Cutting-edge AI research pushing the boundaries of the field',
  'open-source': 'Open-source milestone promoting accessible AI development',
  regulation: 'Key regulatory development affecting AI industry direction',
  safety: 'Important AI safety topic shaping responsible development',
  funding: 'Notable AI investment reflecting market confidence and trends',
  breakthrough: 'Breakthrough achievement marking a milestone in AI progress',
  infrastructure: 'AI infrastructure advancement supporting ecosystem growth',
  application: 'Real-world AI application demonstrating practical value',
  default: 'Notable recent event in the AI landscape',
};

function generateReason(tags, lang) {
  const primaryTag = tags[0] || 'default';
  const map = lang === 'zh' ? REASON_MAP_ZH : REASON_MAP_EN;
  return map[primaryTag] || map.default;
}

// --- Event clustering ---
function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function extractEntities(text) {
  const words = text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) || [];
  const known = text.match(/\b(AI|LLM|GPT|RLHF|API|NLP|ML|GPU|TPU|AGI|RAG)\b/g) || [];
  return new Set([...words.map(w => w.toLowerCase()), ...known.map(w => w.toLowerCase())]);
}

function jaccardSimilarity(setA, setB) {
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  const wordsA = new Set(na.split(' '));
  const wordsB = new Set(nb.split(' '));
  return jaccardSimilarity(wordsA, wordsB);
}

function clusterEvents(items) {
  const clusters = [];
  const used = new Set();

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const cluster = { primary: items[i], members: [items[i]] };
    const entitiesA = extractEntities(items[i].title + ' ' + items[i].summary);

    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const tSim = titleSimilarity(items[i].title, items[j].title);
      if (tSim >= 0.5) {
        cluster.members.push(items[j]);
        used.add(j);
        if ((items[j].rawScore || 0) > (cluster.primary.rawScore || 0)) {
          cluster.primary = items[j];
        }
        continue;
      }
      const entitiesB = extractEntities(items[j].title + ' ' + items[j].summary);
      if (jaccardSimilarity(entitiesA, entitiesB) >= 0.5 && entitiesA.size >= 2) {
        cluster.members.push(items[j]);
        used.add(j);
        if ((items[j].rawScore || 0) > (cluster.primary.rawScore || 0)) {
          cluster.primary = items[j];
        }
      }
    }
    used.add(i);
    clusters.push(cluster);
  }
  return clusters;
}

// --- Local processing pipeline (default, no API needed) ---
function localProcess(rawItems) {
  // Step 1: Cluster events
  const clusters = clusterEvents(rawItems);

  // Step 2: Process each cluster
  const processed = clusters.map(cluster => {
    const item = cluster.primary;
    const tags = assignTags(item.title, item.summary);
    const { score, scores } = scoreDimensions(item.title, item.summary, tags);

    const secondarySources = cluster.members
      .filter(m => m !== item)
      .map(m => ({ name: m.source, link: m.link }));

    return {
      title_zh: translateText(item.title),
      title_en: item.title,
      summary_zh: translateText(item.summary),
      summary_en: item.summary,
      detail_zh: generateDetail(item.summary, tags, 'zh'),
      detail_en: generateDetail(item.summary, tags, 'en'),
      reason_zh: generateReason(tags, 'zh'),
      reason_en: generateReason(tags, 'en'),
      primary_source: { name: item.source, link: item.link },
      secondary_sources: secondarySources,
      tags,
      score,
      scores,
      image: item.image,
      pubDate: item.pubDate,
      sourceColor: item.sourceColor,
    };
  });

  // Step 3: Sort by score, take top 10
  processed.sort((a, b) => b.score - a.score);
  return processed.slice(0, 10);
}

// --- In-memory cache ---
let cachedNews = [];
let lastUpdated = null;

// --- Fetch & Rank ---
async function fetchAllFeeds() {
  const feedPromises = FEEDS.map(async (feed) => {
    try {
      const data = await parser.parseURL(feed.url);
      return (data.items || []).map(item => ({
        title: item.title || '',
        link: item.link || '',
        summary: stripHtml(item.contentSnippet || item.content || item.summary || '').slice(0, 300),
        pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
        source: feed.name,
        sourceColor: feed.color,
        weight: feed.weight,
        image: extractImage(item),
      }));
    } catch (err) {
      console.error(`Failed to fetch ${feed.name}: ${err.message}`);
      return [];
    }
  });

  const allItems = (await Promise.all(feedPromises)).flat();

  // Filter: past 24 hours only
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const recent = allItems.filter(item => item.pubDate.getTime() > oneDayAgo);

  // If not enough recent items, relax to 72h
  const pool = recent.length >= 10 ? recent : allItems.filter(item => item.pubDate.getTime() > now - 72 * 60 * 60 * 1000);

  // Score: weight * recency bonus
  pool.forEach(item => {
    const hoursAgo = (now - item.pubDate.getTime()) / (1000 * 60 * 60);
    item.rawScore = item.weight * (1 / (1 + hoursAgo * 0.1));
  });

  // Sort by score descending, deduplicate by title similarity
  pool.sort((a, b) => b.rawScore - a.rawScore);
  const seen = new Set();
  const top = [];
  for (const item of pool) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    top.push(item);
    if (top.length >= 20) break;
  }

  if (top.length === 0) return getDemoData();
  return top;
}

// --- Gemini Analysis ---
async function analyzeWithGemini(rawItems) {
  if (!geminiModel) return null;

  const itemsForPrompt = rawItems.map(item => ({
    title: item.title,
    summary: item.summary,
    link: item.link,
    source: item.source,
    pubDate: item.pubDate,
    image: item.image,
  }));

  const prompt = `You are an expert AI news analyst. Analyze these ${itemsForPrompt.length} RSS news items from the past 24 hours about artificial intelligence.

For each item, perform the following:
1. Cluster related stories about the same event. For clusters, pick the best title and merge information from all sources.
2. Generate bilingual (Chinese + English) content for each event.
3. Score each event on overall importance (0-100) and five dimensions (0-100 each).
4. Assign relevant tags.

Return a JSON array of exactly ${Math.min(itemsForPrompt.length, 10)} events, sorted by overall score descending. Each event must have this exact structure:
{
  "title_zh": "Chinese title",
  "title_en": "English title",
  "summary_zh": "2-3 sentence Chinese summary",
  "summary_en": "2-3 sentence English summary",
  "detail_zh": "3-5 sentence detailed Chinese analysis",
  "detail_en": "3-5 sentence detailed English analysis",
  "reason_zh": "One sentence explaining why this matters (Chinese)",
  "reason_en": "One sentence explaining why this matters (English)",
  "tags": ["model", "research"],
  "score": 85,
  "scores": {
    "technical": 80,
    "industry": 75,
    "public": 90,
    "practical": 70,
    "future": 85
  },
  "primary_source": { "name": "Source Name", "link": "https://..." },
  "secondary_sources": [{ "name": "Other Source", "link": "https://..." }],
  "image": "image URL or null",
  "pubDate": "ISO date string"
}

Tag options: model, product, research, regulation, funding, open-source, safety, infrastructure, application, breakthrough

Here are the RSS items to analyze:
${JSON.stringify(itemsForPrompt, null, 2)}

Return ONLY a valid JSON array. No markdown, no explanation, no code fences.`;

  try {
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.3,
      },
    });

    const text = result.response.text();
    const parsed = JSON.parse(text);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.warn('Gemini returned invalid structure');
      return null;
    }

    // Validate required fields
    const required = ['title_zh', 'title_en', 'summary_zh', 'summary_en', 'score', 'primary_source'];
    for (const item of parsed) {
      for (const field of required) {
        if (!item[field]) {
          console.warn(`Gemini response missing field: ${field}`);
          return null;
        }
      }
      // Ensure scores object exists with defaults
      if (!item.scores || typeof item.scores !== 'object') {
        item.scores = { technical: item.score, industry: item.score, public: item.score, practical: item.score, future: item.score };
      }
      // Ensure arrays exist
      if (!Array.isArray(item.secondary_sources)) item.secondary_sources = [];
      if (!Array.isArray(item.tags)) item.tags = ['ai'];
      // Ensure detail and reason fields exist
      if (!item.detail_zh) item.detail_zh = item.summary_zh;
      if (!item.detail_en) item.detail_en = item.summary_en;
      if (!item.reason_zh) item.reason_zh = '基于AI领域重要性入选';
      if (!item.reason_en) item.reason_en = 'Selected for significance in AI';
    }

    console.log(`Gemini analysis complete: ${parsed.length} events`);
    return parsed;
  } catch (err) {
    console.error('Gemini analysis failed:', err.message);
    return null;
  }
}

// (localProcess is defined above, replaces the old fallbackProcess)

// --- Refresh ---
async function refreshNews() {
  try {
    console.log('Refreshing news...');
    const rawItems = await fetchAllFeeds();

    if (geminiModel) {
      const analyzed = await analyzeWithGemini(rawItems);
      if (analyzed && analyzed.length > 0) {
        cachedNews = analyzed;
      } else {
        console.log('Gemini unavailable, using local processing');
        cachedNews = localProcess(rawItems);
      }
    } else {
      cachedNews = localProcess(rawItems);
    }

    lastUpdated = new Date().toISOString();
    console.log(`Refreshed: ${cachedNews.length} items at ${lastUpdated}`);
  } catch (err) {
    console.error('Refresh failed:', err.message);
  }
}

// --- Demo Data (new format) ---
function getDemoData() {
  const now = new Date();
  const h = (hoursAgo) => new Date(now.getTime() - hoursAgo * 3600000);
  return [
    { title: 'Claude 4.5 Launches with 1M Context Window and Agentic Capabilities', summary: 'Anthropic releases Claude 4.5, featuring a massive 1 million token context window, improved reasoning, and native tool use for building autonomous agents.', link: 'https://anthropic.com', source: 'TechCrunch', sourceColor: '#0a9e01', pubDate: h(1), image: null, rawScore: 6 },
    { title: 'Google DeepMind Achieves Breakthrough in Protein-Drug Interaction Prediction', summary: 'New AlphaFold 4 model can predict how drug molecules interact with proteins at atomic resolution, potentially revolutionizing pharmaceutical research.', link: 'https://deepmind.google', source: 'MIT Tech Review', sourceColor: '#9b2fae', pubDate: h(3), image: null, rawScore: 5 },
    { title: 'Open Source LLM Llama 4 Matches GPT-5 on Major Benchmarks', summary: 'Meta releases Llama 4 with 400B parameters, achieving state-of-the-art performance on reasoning, coding, and math benchmarks while remaining fully open source.', link: 'https://ai.meta.com', source: 'Hacker News', sourceColor: '#ff6600', pubDate: h(4), image: null, rawScore: 5 },
    { title: 'Yann LeCun: "World Models Are the Path to True AI Understanding"', summary: 'In a keynote at ICLR 2026, Yann LeCun presents new evidence that world models trained on video data develop emergent reasoning capabilities beyond language models.', link: 'https://iclr.cc', source: 'Hacker News', sourceColor: '#ff6600', pubDate: h(5), image: null, rawScore: 4.5 },
    { title: 'Diffusion Transformers Achieve Real-Time 4K Video Generation', summary: 'A new architecture combining diffusion models with efficient transformers enables generating photorealistic 4K video at 30fps on consumer GPUs.', link: 'https://arxiv.org', source: 'ArXiv CS.AI', sourceColor: '#b31b1b', pubDate: h(6), image: null, rawScore: 4 },
    { title: 'Microsoft Copilot Workspace: AI-Powered Full-Stack Development Environment', summary: 'Microsoft launches Copilot Workspace, an AI-native IDE that can plan, implement, test, and deploy entire features from natural language descriptions.', link: 'https://microsoft.com', source: 'The Verge', sourceColor: '#e5127d', pubDate: h(8), image: null, rawScore: 3.5 },
    { title: 'New RLHF Alternative "Direct Nash Optimization" Shows 40% Better Alignment', summary: 'Researchers propose Direct Nash Optimization (DNO), a training method that produces more helpful and harmless AI without the instability of traditional RLHF.', link: 'https://arxiv.org', source: 'ArXiv CS.AI', sourceColor: '#b31b1b', pubDate: h(10), image: null, rawScore: 3 },
    { title: 'AI Coding Agents Now Write 30% of New Code at Google', summary: 'Google reveals that AI coding assistants are now responsible for generating 30% of new code across the company, up from 10% last year, with increasing code quality.', link: 'https://blog.google', source: 'TechCrunch', sourceColor: '#0a9e01', pubDate: h(12), image: null, rawScore: 2.5 },
    { title: 'Hugging Face Releases SmolVLM-2B: A Tiny But Mighty Vision-Language Model', summary: 'The new 2-billion parameter vision-language model runs on mobile devices while matching GPT-4V on document understanding and visual QA tasks.', link: 'https://huggingface.co', source: 'Hacker News', sourceColor: '#ff6600', pubDate: h(14), image: null, rawScore: 2 },
    { title: 'EU AI Act Enforcement Begins: What Developers Need to Know', summary: 'The EU AI Act officially enters enforcement phase. High-risk AI systems must now comply with transparency, testing, and documentation requirements.', link: 'https://ec.europa.eu', source: 'MIT Tech Review', sourceColor: '#9b2fae', pubDate: h(18), image: null, rawScore: 1.5 },
  ];
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}

function extractImage(item) {
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  const match = (item.content || item['content:encoded'] || '').match(/<img[^>]+src=["']([^"']+)["']/);
  if (match) return match[1];
  return null;
}

// --- Email ---
async function sendDigestEmail() {
  const apiKey = process.env.RESEND_API_KEY;
  const emailTo = process.env.EMAIL_TO;
  const emailFrom = process.env.EMAIL_FROM || 'onboarding@resend.dev';

  if (!apiKey || !emailTo) {
    console.log('Email not configured, skipping. Set RESEND_API_KEY and EMAIL_TO in .env');
    return;
  }

  const { Resend } = require('resend');
  const resend = new Resend(apiKey);

  const itemsHtml = cachedNews.map((item, i) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #333;">
        <div style="color:#888;font-size:12px;margin-bottom:4px;">
          ${item.primary_source ? item.primary_source.name : 'Unknown'} · ${new Date(item.pubDate).toLocaleString()}
          <span style="background:#f0883e;color:#fff;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;margin-left:8px;">${item.score}</span>
        </div>
        <a href="${item.primary_source ? item.primary_source.link : '#'}" style="color:#58a6ff;font-size:16px;text-decoration:none;font-weight:600;">${i + 1}. ${item.title_en}</a>
        <div style="color:#aaa;font-size:13px;margin-top:4px;">${(item.summary_en || '').slice(0, 150)}...</div>
        <div style="color:#666;font-size:12px;margin-top:4px;font-style:italic;">${item.reason_en || ''}</div>
      </td>
    </tr>
  `).join('');

  const html = `
    <div style="max-width:600px;margin:0 auto;background:#0d1117;color:#e6edf3;padding:24px;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
      <h1 style="color:#58a6ff;font-size:22px;margin-bottom:4px;">🤖 AI Intelligence Feed</h1>
      <p style="color:#666;font-size:13px;">Top 10 AI stories in the past 24 hours · ${new Date().toLocaleDateString()}</p>
      <table style="width:100%;border-collapse:collapse;">${itemsHtml}</table>
      <p style="color:#555;font-size:12px;margin-top:16px;text-align:center;">Powered by AI Intelligence Feed</p>
    </div>
  `;

  try {
    await resend.emails.send({
      from: emailFrom,
      to: emailTo,
      subject: `🤖 AI Daily Digest — ${new Date().toLocaleDateString()}`,
      html,
    });
    console.log(`Digest email sent to ${emailTo}`);
  } catch (err) {
    console.error('Failed to send email:', err.message);
  }
}

// --- Routes ---
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/news', (req, res) => {
  res.json({ news: cachedNews, lastUpdated });
});

app.post('/api/refresh', async (req, res) => {
  await refreshNews();
  res.json({ news: cachedNews, lastUpdated });
});

// --- Cron: every day at 9:00 AM ---
cron.schedule('0 9 * * *', async () => {
  console.log('Cron: daily refresh + email');
  await refreshNews();
  await sendDigestEmail();
});

// --- Start ---
app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  await refreshNews();
});
