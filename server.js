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
  console.log('No GEMINI_API_KEY set, using fallback mode');
}

// --- RSS Sources ---
const FEEDS = [
  { name: 'Hacker News', url: 'https://hnrss.org/newest?q=AI+OR+LLM+OR+GPT+OR+Claude+OR+machine+learning&points=50', weight: 3, color: '#ff6600' },
  { name: 'ArXiv CS.AI', url: 'http://export.arxiv.org/rss/cs.AI', weight: 2, color: '#b31b1b' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', weight: 2, color: '#0a9e01' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', weight: 2, color: '#e5127d' },
  { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', weight: 2, color: '#9b2fae' },
];

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
    if (top.length >= 10) break;
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

// --- Fallback: pure JS processing ---
function fallbackProcess(rawItems) {
  // Normalize scores to 0-100 range
  const maxRaw = Math.max(...rawItems.map(i => i.rawScore || 1), 1);

  return rawItems.map(item => {
    const normalizedScore = Math.round(Math.min(100, (item.rawScore || 0) / maxRaw * 80 + 20));
    return {
      title_zh: item.title,
      title_en: item.title,
      summary_zh: item.summary,
      summary_en: item.summary,
      detail_zh: item.summary,
      detail_en: item.summary,
      reason_zh: '基于来源权威性和时效性入选',
      reason_en: 'Selected based on source authority and recency',
      primary_source: { name: item.source, link: item.link },
      secondary_sources: [],
      tags: ['ai'],
      score: normalizedScore,
      scores: {
        technical: normalizedScore,
        industry: normalizedScore,
        public: normalizedScore,
        practical: normalizedScore,
        future: normalizedScore,
      },
      image: item.image,
      pubDate: item.pubDate,
      sourceColor: item.sourceColor,
    };
  });
}

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
        console.log('Gemini failed, falling back to JS processing');
        cachedNews = fallbackProcess(rawItems);
      }
    } else {
      cachedNews = fallbackProcess(rawItems);
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
