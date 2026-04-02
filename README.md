# AI News Digest 24h

自动抓取过去 24 小时 AI 领域最有影响力的 10 件事，以精美暗色卡片页面展示，支持一键刷新和每日邮件推送。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（邮件功能需要，不配也能跑）
cp .env.example .env
# 编辑 .env 填入你的配置

# 3. 启动
node server.js

# 4. 打开浏览器
# http://localhost:3000
```

## 环境变量 (.env)

| 变量 | 说明 | 必填 | 默认值 |
|------|------|------|--------|
| `PORT` | 服务端口 | 否 | `3000` |
| `RESEND_API_KEY` | [Resend](https://resend.com) API Key，用于发送每日邮件 | 否 | 无（不配则跳过邮件） |
| `EMAIL_TO` | 接收邮件的地址 | 否 | 无 |
| `EMAIL_FROM` | 发件人地址（需在 Resend 中验证域名） | 否 | `onboarding@resend.dev` |

> 不配置邮件相关变量，网页功能完全不受影响，只是不会发邮件。

## 可自定义的参数

以下参数直接在 `server.js` 中修改：

### RSS 数据源 (第 11-17 行)

```js
const FEEDS = [
  { name: 'Hacker News', url: '...', weight: 3, color: '#ff6600' },
  { name: 'ArXiv CS.AI', url: '...', weight: 2, color: '#b31b1b' },
  // ...
];
```

- **`name`** — 来源显示名称
- **`url`** — RSS 地址，可替换为任何有效的 RSS/Atom feed
- **`weight`** — 权重 (1-5)，值越大该来源的文章排名越靠前
- **`color`** — 来源标签的颜色

你可以自由增删 RSS 源，比如加入 Reddit、OpenAI Blog 等。

### 显示数量 (第 71 行)

```js
if (top.length >= 10) break;  // 改成你想要的数量
```

### 定时任务 (第 179 行)

```js
cron.schedule('0 9 * * *', ...)  // cron 表达式，默认每天早上 9:00
```

常用 cron 表达式：
- `0 9 * * *` — 每天 09:00
- `0 9,18 * * *` — 每天 09:00 和 18:00
- `*/30 * * * *` — 每 30 分钟
- `0 9 * * 1-5` — 工作日 09:00

### RSS 请求超时 (第 7 行)

```js
const parser = new RSSParser({ timeout: 10000 });  // 毫秒，默认 10 秒
```

### 时间窗口 (第 50-54 行)

```js
const oneDayAgo = now - 24 * 60 * 60 * 1000;  // 默认 24 小时
// 如果 24h 内不足 10 条，自动放宽到 72 小时
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/news` | 获取当前缓存的新闻列表 |
| POST | `/api/refresh` | 手动触发刷新并返回最新数据 |

## 项目结构

```
├── server.js          # 后端：Express + RSS 抓取 + 定时任务 + 邮件
├── public/
│   └── index.html     # 前端：暗色科技风单页面
├── package.json       # 依赖（仅 4 个）
├── .env.example       # 环境变量模板
└── .gitignore
```

## 数据源说明

| 来源 | 内容类型 | 默认权重 |
|------|---------|---------|
| Hacker News | 社区热帖（50+ points 的 AI 相关） | 3 |
| ArXiv CS.AI | 最新 AI 论文 | 2 |
| TechCrunch | AI 产品与行业新闻 | 2 |
| The Verge | 科技新闻 | 2 |
| MIT Tech Review | 深度报道 | 2 |

## 排序算法

```
score = weight * (1 / (1 + hoursAgo * 0.1))
```

- 来源权重越高、发布时间越近的文章得分越高
- 自动按标题去重，避免多个源报道同一事件

## 邮件配置指南

1. 前往 [resend.com](https://resend.com) 注册账号
2. 获取 API Key（免费版每天可发 100 封）
3. 填入 `.env` 文件
4. 重启服务即生效

## License

MIT
