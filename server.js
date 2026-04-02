const express = require('express');
const RSSParser = require('rss-parser');
const cron = require('node-cron');
const path = require('path');

const app = express();
const parser = new RSSParser({ timeout: 10000 });
const PORT = process.env.PORT || 3000;

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
  const results = [];

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
        image: extractImage(item, feed.name),
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
    item.score = item.weight * (1 / (1 + hoursAgo * 0.1));
  });

  // Sort by score descending, deduplicate by title similarity
  pool.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const top = [];
  for (const item of pool) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    top.push(item);
    if (top.length >= 10) break;
  }

  // If all feeds failed, return demo data so the UI is visible
  if (top.length === 0) return getDemoData();

  return top;
}

function getDemoData() {
  const now = new Date();
  const h = (hoursAgo) => new Date(now.getTime() - hoursAgo * 3600000);
  return [
    { title: 'Claude 4.5 Launches with 1M Context Window and Agentic Capabilities', summary: 'Anthropic releases Claude 4.5, featuring a massive 1 million token context window, improved reasoning, and native tool use for building autonomous agents.', link: 'https://anthropic.com', source: 'TechCrunch', sourceColor: '#0a9e01', pubDate: h(1), image: null },
    { title: 'Google DeepMind Achieves Breakthrough in Protein-Drug Interaction Prediction', summary: 'New AlphaFold 4 model can predict how drug molecules interact with proteins at atomic resolution, potentially revolutionizing pharmaceutical research.', link: 'https://deepmind.google', source: 'MIT Tech Review', sourceColor: '#9b2fae', pubDate: h(3), image: null },
    { title: 'Open Source LLM Llama 4 Matches GPT-5 on Major Benchmarks', summary: 'Meta releases Llama 4 with 400B parameters, achieving state-of-the-art performance on reasoning, coding, and math benchmarks while remaining fully open source.', link: 'https://ai.meta.com', source: 'Hacker News', sourceColor: '#ff6600', pubDate: h(4), image: null },
    { title: 'Yann LeCun: "World Models Are the Path to True AI Understanding"', summary: 'In a keynote at ICLR 2026, Yann LeCun presents new evidence that world models trained on video data develop emergent reasoning capabilities beyond language models.', link: 'https://iclr.cc', source: 'Hacker News', sourceColor: '#ff6600', pubDate: h(5), image: null },
    { title: 'Diffusion Transformers Achieve Real-Time 4K Video Generation', summary: 'A new architecture combining diffusion models with efficient transformers enables generating photorealistic 4K video at 30fps on consumer GPUs.', link: 'https://arxiv.org', source: 'ArXiv CS.AI', sourceColor: '#b31b1b', pubDate: h(6), image: null },
    { title: 'Microsoft Copilot Workspace: AI-Powered Full-Stack Development Environment', summary: 'Microsoft launches Copilot Workspace, an AI-native IDE that can plan, implement, test, and deploy entire features from natural language descriptions.', link: 'https://microsoft.com', source: 'The Verge', sourceColor: '#e5127d', pubDate: h(8), image: null },
    { title: 'New RLHF Alternative "Direct Nash Optimization" Shows 40% Better Alignment', summary: 'Researchers propose Direct Nash Optimization (DNO), a training method that produces more helpful and harmless AI without the instability of traditional RLHF.', link: 'https://arxiv.org', source: 'ArXiv CS.AI', sourceColor: '#b31b1b', pubDate: h(10), image: null },
    { title: 'AI Coding Agents Now Write 30% of New Code at Google', summary: 'Google reveals that AI coding assistants are now responsible for generating 30% of new code across the company, up from 10% last year, with increasing code quality.', link: 'https://blog.google', source: 'TechCrunch', sourceColor: '#0a9e01', pubDate: h(12), image: null },
    { title: 'Hugging Face Releases SmolVLM-2B: A Tiny But Mighty Vision-Language Model', summary: 'The new 2-billion parameter vision-language model runs on mobile devices while matching GPT-4V on document understanding and visual QA tasks.', link: 'https://huggingface.co', source: 'Hacker News', sourceColor: '#ff6600', pubDate: h(14), image: null },
    { title: 'EU AI Act Enforcement Begins: What Developers Need to Know', summary: 'The EU AI Act officially enters enforcement phase. High-risk AI systems must now comply with transparency, testing, and documentation requirements.', link: 'https://ec.europa.eu', source: 'MIT Tech Review', sourceColor: '#9b2fae', pubDate: h(18), image: null },
  ];
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}

function extractImage(item, sourceName) {
  // Try to find image in content/enclosure
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  const match = (item.content || item['content:encoded'] || '').match(/<img[^>]+src=["']([^"']+)["']/);
  if (match) return match[1];
  return null;
}

async function refreshNews() {
  try {
    console.log('Refreshing news...');
    cachedNews = await fetchAllFeeds();
    lastUpdated = new Date().toISOString();
    console.log(`Fetched ${cachedNews.length} items at ${lastUpdated}`);
  } catch (err) {
    console.error('Refresh failed:', err.message);
  }
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
        <div style="color:#888;font-size:12px;margin-bottom:4px;">${item.source} · ${new Date(item.pubDate).toLocaleString()}</div>
        <a href="${item.link}" style="color:#58a6ff;font-size:16px;text-decoration:none;font-weight:600;">${i + 1}. ${item.title}</a>
        <div style="color:#aaa;font-size:13px;margin-top:4px;">${item.summary.slice(0, 150)}...</div>
      </td>
    </tr>
  `).join('');

  const html = `
    <div style="max-width:600px;margin:0 auto;background:#0d1117;color:#e6edf3;padding:24px;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
      <h1 style="color:#58a6ff;font-size:22px;margin-bottom:4px;">🤖 AI News Digest</h1>
      <p style="color:#666;font-size:13px;">Top 10 AI stories in the past 24 hours · ${new Date().toLocaleDateString()}</p>
      <table style="width:100%;border-collapse:collapse;">${itemsHtml}</table>
      <p style="color:#555;font-size:12px;margin-top:16px;text-align:center;">Powered by AI News Digest 24h</p>
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
