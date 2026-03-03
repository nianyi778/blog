# Pinterest 邮件图片收集服务 — 技术方案文档

> **版本**: v1.0  
> **日期**: 2026-02-24  
> **状态**: 技术评审稿

---

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 系统架构](#2-系统架构)
- [3. 模块详细设计](#3-模块详细设计)
  - [3.1 邮件接收与解析](#31-邮件接收与解析)
  - [3.2 图片处理 Pipeline](#32-图片处理-pipeline)
  - [3.3 存储层设计](#33-存储层设计)
  - [3.4 图库前端](#34-图库前端)
- [4. 方案对比与技术选型](#4-方案对比与技术选型)
- [5. 数据流详解](#5-数据流详解)
- [6. 成本分析](#6-成本分析)
- [7. 法律与合规](#7-法律与合规)
- [8. 部署方案](#8-部署方案)
- [9. 扩展性考量](#9-扩展性考量)

---

## 1. 项目概述

### 1.1 背景

Pinterest 定期向用户邮箱推送个性化推荐邮件，内含大量高质量图片（插画、摄影、设计作品等）。这些图片分散在邮件中，无法系统性浏览和管理。

### 1.2 目标

构建一套自动化服务，实现：

1. **自动监听** — 实时捕获 Pinterest 推荐邮件
2. **图片提取** — 从邮件 HTML 中解析并获取高分辨率原图
3. **集中存储** — 上传至 Cloudflare R2 对象存储
4. **图库展示** — 通过瀑布流网站统一浏览和管理

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **Serverless 优先** | 全链路无服务器，零运维负担 |
| **零成本运行** | 利用 Cloudflare 免费额度，个人使用不产生费用 |
| **自动化** | 从邮件到图库全自动，无需人工干预 |
| **可扩展** | 架构支持后续接入更多图片来源（Newsletter、RSS 等） |

---

## 2. 系统架构

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        数据流入层                                │
│                                                                 │
│  Pinterest Email ──→ Gmail ──→ 转发规则 ──→ inbox@yourdomain.com │
│                                                                 │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Cloudflare Email Worker                        │
│                                                                 │
│  ┌──────────┐   ┌───────────┐   ┌────────────┐   ┌──────────┐ │
│  │ 接收邮件  │──▶│ 解析 HTML  │──▶│ 提取图片URL │──▶│ 升级分辨率│ │
│  │ postal-   │   │ cheerio/  │   │ img[src]   │   │ 236x →   │ │
│  │ mime      │   │ regex     │   │ 过滤去重    │   │ originals│ │
│  └──────────┘   └───────────┘   └────────────┘   └─────┬────┘ │
│                                                         │      │
└─────────────────────────────────────────────────────────┼──────┘
                                                          │
                               ▼                          │
┌─────────────────────────────────────────────────────────┼──────┐
│                    图片处理 Pipeline                      │      │
│                                                         │      │
│  ┌──────────┐   ┌───────────┐   ┌────────────┐         │      │
│  │ Fetch 原图│──▶│ SHA256去重 │──▶│ Sharp 缩略图│         │      │
│  │ + Referer │   │ 跳过重复   │   │ 400w WebP  │         │      │
│  └──────────┘   └───────────┘   └─────┬──────┘         │      │
│                                       │                 │      │
└───────────────────────────────────────┼─────────────────┘──────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    ▼                   ▼                   ▼
          ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
          │  Cloudflare   │   │  Cloudflare   │   │  Cloudflare   │
          │     R2        │   │     D1        │   │    Pages      │
          │               │   │               │   │               │
          │ originals/    │   │ images table  │   │  图库前端      │
          │   {id}.jpg    │   │  - id         │   │  Astro SSG    │
          │ thumbs/       │   │  - url        │   │  瀑布流布局    │
          │   {id}.webp   │   │  - hash       │   │  Lightbox     │
          │               │   │  - metadata   │   │  无限滚动      │
          └──────────────┘   └──────────────┘   └──────────────┘
```

### 2.2 技术栈总览

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 邮件接收 | Cloudflare Email Routing + Email Worker | 零成本实时邮件处理 |
| 邮件解析 | `postal-mime` | Cloudflare 团队成员开发的 MIME 解析库 |
| HTML 解析 | 正则 + `cheerio`（如需） | 提取 `<img>` 标签中的 Pinterest 图片 URL |
| 图片下载 | `fetch` + Referer 头 | 从 `i.pinimg.com` 获取原图 |
| 图片处理 | `sharp` (Node.js) / Cloudflare Images | 缩略图生成、格式转换 |
| 对象存储 | Cloudflare R2 | S3 兼容，出口流量免费 |
| 元数据库 | Cloudflare D1 (SQLite) | Edge SQLite，免费 5GB |
| 前端框架 | Astro (或 Next.js) | SSG 静态生成，SEO 友好 |
| 部署平台 | Cloudflare Pages | 自动部署，与 R2 同域 |

---

## 3. 模块详细设计

### 3.1 邮件接收与解析

#### 3.1.1 邮件转发配置

**Gmail 端设置**（一次性）：

1. Gmail → 设置 → 过滤器和屏蔽的地址
2. 创建过滤器：
   - **发件人**: `pinterest.com`（匹配所有 Pinterest 邮件地址）
3. 操作：
   - **转发至**: `pinterest@yourdomain.com`
   - 可选：同时保留在 Gmail 中

**Cloudflare 端设置**：

1. Cloudflare Dashboard → Email Routing → 启用
2. DNS 自动添加 MX 记录
3. 创建 Email Worker 路由：`pinterest@yourdomain.com` → Worker

#### 3.1.2 Email Worker 核心逻辑

```typescript
// src/email-worker.ts
import PostalMime from 'postal-mime';

interface Env {
  GALLERY_BUCKET: R2Bucket;
  IMAGE_DB: D1Database;
  IMAGE_QUEUE: Queue;  // 可选：用队列异步处理
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    // 1. 验证发件人
    const from = message.from;
    if (!from.includes('pinterest.com')) {
      // 非 Pinterest 邮件，直接转发到原始邮箱（兜底）
      await message.forward('your@gmail.com');
      return;
    }

    // 2. 解析邮件内容
    const rawEmail = new Response(message.raw);
    const arrayBuffer = await rawEmail.arrayBuffer();
    const parser = new PostalMime();
    const email = await parser.parse(arrayBuffer);

    // 3. 从 HTML 正文中提取图片 URL
    const imageUrls = extractPinterestImages(email.html || '');

    // 4. 异步处理每张图片（避免 Worker 超时）
    for (const url of imageUrls) {
      await env.IMAGE_QUEUE.send({
        originalUrl: url,
        highResUrl: upgradeToOriginal(url),
        emailDate: message.headers.get('date'),
        emailSubject: email.subject,
      });
    }

    // 5. 同时转发到 Gmail 保留副本（可选）
    await message.forward('your@gmail.com');
  },
};
```

#### 3.1.3 Pinterest 邮件 HTML 结构分析

Pinterest 推荐邮件的 HTML 遵循以下结构模式：

```html
<!-- Pinterest 邮件典型结构 -->
<table>
  <tr>
    <td>
      <a href="https://www.pinterest.com/pin/123456789/">
        <img src="https://i.pinimg.com/236x/ab/cd/ef/abcdef123456.jpg"
             alt="Pin description text"
             width="236"
             style="..." />
      </a>
    </td>
    <!-- 更多 Pin 卡片 -->
  </tr>
</table>
```

**关键特征**：

| 特征 | 说明 |
|------|------|
| 图片格式 | 外部 URL（非 base64 内嵌） |
| CDN 域名 | `i.pinimg.com` |
| 邮件中分辨率 | 通常为 `236x`（小图） |
| URL 过期 | **不会过期**，永久可访问 |
| 跟踪重定向 | Pin 链接经过 Pinterest 跟踪，但 `<img src>` 是直链 |
| 图片数量 | 每封邮件约 10-30 张 |

#### 3.1.4 图片 URL 提取

```typescript
// src/utils/extract-images.ts

/**
 * 从 Pinterest 邮件 HTML 中提取所有图片 URL
 * 
 * 匹配模式: <img src="https://i.pinimg.com/...">
 * 排除: 1x1 跟踪像素、Pinterest logo、UI 图标
 */
function extractPinterestImages(html: string): string[] {
  const imgRegex = /https:\/\/i\.pinimg\.com\/\d+x\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]+\.\w+/g;
  const matches = html.match(imgRegex) || [];

  // 去重（同一封邮件可能重复引用同一图片）
  const unique = [...new Set(matches)];

  // 过滤掉明显的非内容图片（如 75x75 的头像缩略图）
  return unique.filter(url => !url.includes('/75x75/'));
}

/**
 * 将邮件中的小图 URL 升级为原图 URL
 * 
 * 236x → originals (尝试最高分辨率)
 * 如果 originals 返回 404，降级到 736x
 */
function upgradeToOriginal(url: string): string {
  return url.replace(
    /i\.pinimg\.com\/(75x75|236x|474x|736x)/,
    'i.pinimg.com/originals'
  );
}
```

#### 3.1.5 Pinterest 图片 URL 分辨率体系

```
https://i.pinimg.com/{size}/ab/cd/ef/{hash}.jpg
                       │
                       ├── 75x75_s   → 75×75 正方形裁剪（头像）
                       ├── 170x      → 170px 宽（小缩略图）
                       ├── 236x      → 236px 宽（邮件/搜索默认）
                       ├── 474x      → 474px 宽（中等）
                       ├── 736x      → 736px 宽（大图）
                       └── originals → 原始上传分辨率（最高质量）
```

**升级策略**：

```
邮件中的 URL                                      升级后的 URL
─────────────────────────────────────────          ─────────────────────────────────────────
i.pinimg.com/236x/ab/cd/ef/hash.jpg       →       i.pinimg.com/originals/ab/cd/ef/hash.jpg
```

> ⚠️ **注意**：少量图片的 `originals` 版本可能不存在（上传者删除或 Pinterest 未保留）。需要实现降级逻辑：`originals` → `736x` → `474x`。

---

### 3.2 图片处理 Pipeline

#### 3.2.1 Queue Consumer（异步处理）

使用 Cloudflare Queues 解耦邮件接收和图片处理，避免 Email Worker 超时（30 秒限制）：

```typescript
// src/queue-consumer.ts

interface ImageTask {
  originalUrl: string;   // 邮件中的 236x URL
  highResUrl: string;    // 升级后的 originals URL
  emailDate: string;
  emailSubject: string;
}

export default {
  async queue(batch: MessageBatch<ImageTask>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processImage(msg.body, env);
        msg.ack();
      } catch (e) {
        msg.retry();  // 失败后自动重试
      }
    }
  },
};

async function processImage(task: ImageTask, env: Env) {
  // 1. 尝试下载原图（带降级）
  const { buffer, finalUrl, contentType } = await fetchWithFallback(
    task.highResUrl,
    [
      task.highResUrl,                                    // originals
      task.highResUrl.replace('originals', '736x'),       // 736x 降级
      task.originalUrl,                                    // 原始 236x 兜底
    ]
  );

  // 2. 计算内容哈希（去重）
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const contentHash = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // 3. 检查是否已存在
  const existing = await env.IMAGE_DB
    .prepare('SELECT id FROM images WHERE content_hash = ?')
    .bind(contentHash)
    .first();

  if (existing) {
    console.log(`Duplicate detected: ${contentHash.slice(0, 12)}...`);
    return;  // 跳过重复图片
  }

  // 4. 生成唯一 ID 和存储路径
  const imageId = crypto.randomUUID();
  const ext = contentType.includes('png') ? 'png' : 'jpg';

  // 5. 上传原图到 R2
  await env.GALLERY_BUCKET.put(
    `originals/${imageId}.${ext}`,
    buffer,
    {
      httpMetadata: { contentType },
      customMetadata: {
        sourceUrl: task.originalUrl,
        contentHash: contentHash,
      },
    }
  );

  // 6. 生成并上传缩略图 (在 Worker 中使用轻量方案)
  //    注意: Worker 环境无法使用 Sharp，可用 Cloudflare Image Resizing
  //    或在上传后通过 Image Transform URL 动态生成
  const thumbUrl = `/cdn-cgi/image/width=400,format=webp/${imageId}.${ext}`;

  // 7. 写入元数据
  await env.IMAGE_DB
    .prepare(`
      INSERT INTO images (id, content_hash, original_key, thumb_key, 
                          source_url, email_date, email_subject, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `)
    .bind(
      imageId,
      contentHash,
      `originals/${imageId}.${ext}`,
      thumbUrl,
      task.originalUrl,
      task.emailDate,
      task.emailSubject
    )
    .run();
}
```

#### 3.2.2 带降级的图片下载

```typescript
// src/utils/fetch-image.ts

interface FetchResult {
  buffer: ArrayBuffer;
  finalUrl: string;
  contentType: string;
}

async function fetchWithFallback(
  primaryUrl: string,
  fallbackUrls: string[]
): Promise<FetchResult> {
  for (const url of fallbackUrls) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Referer': 'https://www.pinterest.com/',
          'Accept': 'image/webp,image/avif,image/*,*/*;q=0.8',
        },
      });

      if (response.ok && response.headers.get('content-type')?.startsWith('image/')) {
        return {
          buffer: await response.arrayBuffer(),
          finalUrl: url,
          contentType: response.headers.get('content-type') || 'image/jpeg',
        };
      }
    } catch (e) {
      console.warn(`Failed to fetch ${url}: ${e}`);
    }
  }

  throw new Error(`All URLs failed for: ${primaryUrl}`);
}
```

#### 3.2.3 去重策略

采用 **两层去重** 机制：

| 层级 | 方法 | 目的 | 时机 |
|------|------|------|------|
| **L1: URL 去重** | URL 字符串完全匹配 | 同一封邮件内去重 | 解析时 |
| **L2: 内容哈希** | SHA-256 全文哈希 | 跨邮件精确去重（同图不同 URL） | 下载后 |

> **为什么不用感知哈希 (pHash)**：对于个人图库规模（< 10K 图），SHA-256 精确去重已经足够。pHash 更适合海量图片的「近似重复」检测（如不同分辨率的同一张图），但增加了实现复杂度。如后续有需求，可作为增强功能添加。

---

### 3.3 存储层设计

#### 3.3.1 R2 Bucket 结构

```
gallery-images/                     ← Bucket 名称
├── originals/                      ← 原始高分辨率图片
│   ├── 550e8400-e29b-41d4-a716-446655440000.jpg
│   ├── 6ba7b810-9dad-11d1-80b4-00c04fd430c8.png
│   └── ...
└── thumbs/                         ← 预生成缩略图 (可选, 或用 Image Transform)
    ├── 550e8400-e29b-41d4-a716-446655440000.webp
    └── ...
```

**命名约定**：
- 使用 UUID v4 作为文件名，与源 URL 解耦
- 保留原始扩展名（jpg/png/gif）
- 缩略图统一使用 WebP 格式

#### 3.3.2 R2 公开访问配置

```toml
# wrangler.toml
[[r2_buckets]]
binding = "GALLERY_BUCKET"
bucket_name = "gallery-images"

# 公开访问 (通过自定义域名)
# Dashboard → R2 → gallery-images → Settings → Public Access
# 绑定域名: images.yourdomain.com
```

**缓存策略**：

```
images.yourdomain.com
  ├── Cache-Control: public, max-age=31536000, immutable  ← 图片不变，永久缓存
  └── Cloudflare Cache: Everything (Page Rule)             ← Edge 缓存
```

图片一旦上传就不会修改（immutable），所以可以设置极长的缓存时间，减少 R2 Class B 操作。

#### 3.3.3 D1 数据库 Schema

```sql
-- schema.sql

CREATE TABLE IF NOT EXISTS images (
  id              TEXT PRIMARY KEY,           -- UUID v4
  content_hash    TEXT NOT NULL UNIQUE,       -- SHA-256，用于去重
  original_key    TEXT NOT NULL,              -- R2 中的原图 key
  thumb_key       TEXT,                       -- R2 中的缩略图 key（或 transform URL）
  source_url      TEXT NOT NULL,              -- Pinterest 原始 URL（用于溯源）
  pin_url         TEXT,                       -- Pinterest Pin 页面链接
  alt_text        TEXT,                       -- 从 <img alt=""> 提取的描述
  width           INTEGER,                    -- 图片宽度（像素）
  height          INTEGER,                    -- 图片高度（像素）
  file_size       INTEGER,                    -- 文件大小（字节）
  email_date      TEXT,                       -- 来源邮件日期
  email_subject   TEXT,                       -- 来源邮件标题
  tags            TEXT,                       -- JSON 数组，手动标签
  is_favorite     INTEGER DEFAULT 0,          -- 收藏标记
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX idx_images_created_at ON images(created_at DESC);
CREATE INDEX idx_images_content_hash ON images(content_hash);
CREATE INDEX idx_images_email_date ON images(email_date DESC);
CREATE INDEX idx_images_favorite ON images(is_favorite) WHERE is_favorite = 1;
```

#### 3.3.4 API 接口设计（Worker API）

```typescript
// src/api.ts — 图库 API (Cloudflare Worker)

// GET /api/images?page=1&limit=20&sort=created_at&order=desc
// → 分页获取图片列表

// GET /api/images/:id
// → 获取单张图片详情

// PATCH /api/images/:id
// → 更新图片元数据 (tags, is_favorite)

// DELETE /api/images/:id
// → 删除图片 (R2 + D1)

// GET /api/stats
// → 图库统计 (总数、存储大小、每日新增)
```

---

### 3.4 图库前端

#### 3.4.1 技术选型

| 选项 | 优势 | 劣势 | 推荐场景 |
|------|------|------|---------|
| **Astro** | 零 JS 默认、Islands、极快 | 交互功能需额外配置 | ✅ 图库场景最优 |
| Next.js | 生态强、ISR 增量生成 | 框架较重、JS 开销大 | 需要复杂交互时 |
| 纯 HTML + Vanilla JS | 最轻量 | 开发效率低 | 极简需求 |

**推荐 Astro**：图库本质是内容展示型网站，Astro 的零 JS 默认策略 + Islands 架构完美契合。

#### 3.4.2 页面结构

```
/                          → 首页：最新图片瀑布流
/favorites                 → 收藏页
/archive/2026/02           → 按月归档
/image/:id                 → 单图详情页（大图 + 元数据）
```

#### 3.4.3 瀑布流布局实现

```css
/* CSS Columns 原生瀑布流 — 零 JS 依赖 */
.gallery-grid {
  column-count: 4;
  column-gap: 16px;
  padding: 16px;
}

.gallery-item {
  break-inside: avoid;
  margin-bottom: 16px;
  border-radius: 12px;
  overflow: hidden;
}

.gallery-item img {
  width: 100%;
  height: auto;
  display: block;
}

/* 响应式断点 */
@media (max-width: 1200px) { .gallery-grid { column-count: 3; } }
@media (max-width: 768px)  { .gallery-grid { column-count: 2; } }
@media (max-width: 480px)  { .gallery-grid { column-count: 1; } }
```

#### 3.4.4 图片懒加载

```html
<!-- 原生懒加载 + 模糊占位 -->
<div class="gallery-item">
  <img
    src="https://images.yourdomain.com/thumbs/{id}.webp"
    data-full="https://images.yourdomain.com/originals/{id}.jpg"
    alt="{alt_text}"
    loading="lazy"
    decoding="async"
    width="{width}"
    height="{height}"
    style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
           aspect-ratio: {width}/{height};"
  />
</div>
```

#### 3.4.5 Lightbox 大图浏览

推荐 **lightgallery.js**（MIT 许可）：

```typescript
import lightGallery from 'lightgallery';
import lgZoom from 'lightgallery/plugins/zoom';
import lgThumbnail from 'lightgallery/plugins/thumbnail';

lightGallery(document.getElementById('gallery'), {
  plugins: [lgZoom, lgThumbnail],
  speed: 300,
  download: true,
  mobileSettings: {
    controls: true,
    showCloseIcon: true,
  },
});
```

---

## 4. 方案对比与技术选型

### 4.1 邮件监听方案对比

| 维度 | Cloudflare Email Worker | Gmail API + Pub/Sub | IMAP IDLE | 定时轮询 |
|------|------------------------|--------------------|-----------|---------| 
| **延迟** | ⚡ 实时（毫秒级） | ~1-5 秒 | ~1-5 秒 | 1-5 分钟 |
| **可靠性** | ✅ 极高 | ⚠️ 通知可能丢失 | ⚠️ 连接可能断开 | ✅ 高 |
| **运维成本** | 零（Serverless） | 低（但需续期 watch） | 高（需维持长连接） | 低 |
| **认证复杂度** | 无需认证 | OAuth2 + GCP 项目 | OAuth2 或应用密码 | 同 Gmail API |
| **与 R2 集成** | ✅ 原生绑定 | 需额外 HTTP 调用 | 需额外 HTTP 调用 | 需额外 HTTP 调用 |
| **免费额度** | ✅ 完全免费 | ✅ 免费 | ✅ 免费 | ✅ 免费 |
| **需要自有域名** | ✅ 是 | 否 | 否 | 否 |
| **适用场景** | 个人项目首选 | 企业级集成 | 已有 IMAP 基础设施 | 最简方案 |

**结论**：Cloudflare Email Worker 在所有维度上都是最优选择（前提是有自定义域名）。唯一的前置条件是需要在 Gmail 设置转发规则。

### 4.2 存储方案对比

| 方案 | 免费额度 | 出口流量 | 优势 | 劣势 |
|------|---------|---------|------|------|
| **Cloudflare R2** | 10GB + 1M 写 + 10M 读 | **免费** | CDN 内置、S3 兼容 | 需 Cloudflare 生态 |
| AWS S3 | 5GB (12个月) | $0.09/GB | 生态完善 | 出口流量昂贵 |
| Backblaze B2 | 10GB | 免费(通过CF) | 价格最低 | 需配合 CDN |
| Supabase Storage | 1GB | 2GB/月 | 自带 API | 容量小 |

**结论**：R2 的免费出口流量对图库场景是决定性优势。

---

## 5. 数据流详解

### 5.1 完整数据流（单封邮件处理）

```
时间线 ─────────────────────────────────────────────────────────▶

T+0s    Pinterest 发送推荐邮件到 Gmail
T+1s    Gmail 自动转发到 pinterest@yourdomain.com
T+1.1s  Cloudflare Email Worker 触发
        │
        ├─ 解析 MIME (postal-mime)           ~50ms
        ├─ 提取 HTML 中的 img src            ~10ms
        ├─ 正则过滤 i.pinimg.com URLs        ~5ms
        ├─ URL 去重 (Set)                    ~1ms
        ├─ 升级分辨率 236x → originals        ~1ms
        └─ 写入 Queue (每个 URL 一条消息)     ~20ms

T+2s    Queue Consumer 开始处理
        │
        ├─ Fetch originals 图片             ~200-500ms × N
        │   └─ 404? → 降级到 736x → 474x
        ├─ 计算 SHA-256                     ~10ms
        ├─ D1 查询去重                      ~5ms
        │   └─ 已存在? → 跳过
        ├─ 上传 R2 (originals/)             ~100ms
        ├─ 上传 R2 (thumbs/) 或标记 transform ~100ms
        └─ 写入 D1 元数据                   ~10ms

T+5s    所有图片处理完成（假设 10 张图片）

T+?     前端下次请求 /api/images 时获取新图片
```

### 5.2 错误处理策略

| 错误场景 | 处理方式 |
|---------|---------|
| Pinterest 图片 404 | 分辨率降级（originals → 736x → 474x → 236x） |
| Pinterest CDN 429 (限流) | Queue 自动重试（指数退避） |
| R2 上传失败 | Queue 自动重试（最多 3 次） |
| D1 写入冲突 (重复 hash) | 捕获 UNIQUE 约束错误，安全跳过 |
| Email Worker 超时 | Queue 解耦，Worker 仅负责 URL 提取 |
| 非 Pinterest 邮件误转发 | from 地址白名单过滤 |

---

## 6. 成本分析

### 6.1 Cloudflare 免费额度 vs 预估用量

**假设**：每周收到 3 封 Pinterest 邮件，每封含 15 张图，平均图片大小 2MB。

| 资源 | 免费额度/月 | 月用量估算 | 占比 |
|------|------------|-----------|------|
| **R2 存储** | 10 GB | ~360MB (180 张 × 2MB) | 3.6% |
| **R2 写入 (Class A)** | 1,000,000 次 | ~360 次 (含缩略图) | 0.04% |
| **R2 读取 (Class B)** | 10,000,000 次 | ~50,000 次 | 0.5% |
| **R2 出口流量** | ∞ (免费) | ~10 GB | $0 |
| **D1 读取** | 5,000,000 次 | ~10,000 次 | 0.2% |
| **D1 写入** | 100,000 次 | ~200 次 | 0.2% |
| **D1 存储** | 5 GB | ~1 MB | 0.02% |
| **Workers 请求** | 100,000 次/天 | ~200 次/天 | 0.2% |
| **Queue 操作** | 1,000,000 次 | ~400 次 | 0.04% |
| **Email Workers** | 无明确限制 | ~12 次 | ≈0 |
| **Pages 部署** | 500 次/月 | ~4 次 | 0.8% |

### 6.2 年度成本预测

| 场景 | 年累计图片 | 年存储量 | 年费用 |
|------|-----------|---------|--------|
| 当前用量 | ~2,160 张 | ~4.3 GB | **$0** |
| 2 倍增长 | ~4,320 张 | ~8.6 GB | **$0** |
| 5 倍增长 | ~10,800 张 | ~21.6 GB | ~$0.17/月 |
| 10 倍增长 | ~21,600 张 | ~43.2 GB | ~$0.50/月 |

**结论**：在可预见的 2-3 年内，成本为零。即使图片量暴增 10 倍，月成本也不到 1 美元。

---

## 7. 法律与合规

### 7.1 风险评级

| 使用场景 | 风险等级 | 分析 |
|---------|---------|------|
| **私有图库**（仅自己访问） | 🟢 **极低** | 从自己邮件中提取 → 存到自己的存储 → 自己浏览。属于个人合理使用。 |
| **半公开**（朋友间分享） | 🟡 **低** | 与私人共享图片集锦，风险可忽略，但理论上存在版权问题。 |
| **完全公开** | 🟠 **中** | 图片版权属于原始上传者，公开再托管可能收到 DMCA 通知。 |
| **商业使用** | 🔴 **高** | 明确违反版权法和 Pinterest TOS。 |

### 7.2 合规建议

1. **默认私有**：使用 Cloudflare Access 或 HTTP Basic Auth 保护图库
2. **保留溯源**：在每张图片旁显示指向原始 Pinterest Pin 的链接
3. **添加 DMCA 联系方式**：如果公开，在页面底部添加版权声明和联系方式
4. **不做商业用途**：纯个人欣赏和灵感收集

### 7.3 技术层面的合规差异

| | 爬虫抓取 Pinterest 网站 | 从自己邮件中提取 |
|---|---|---|
| Pinterest TOS | ❌ 明确禁止 scraping | ⚠️ 灰色地带（处理自己收到的邮件） |
| robots.txt | 受限 | 不适用（不涉及网站访问） |
| 访问方式 | 主动抓取 | 被动接收 |
| 技术性质 | 爬虫 | 邮件客户端 |

从自己邮件中提取图片 URL 并下载，技术上更接近「邮件客户端行为」而非「爬虫抓取」，法律风险显著低于传统爬虫方案。

---

## 8. 部署方案

### 8.1 项目结构

```
pinterest-gallery/
├── workers/
│   ├── email-worker/               ← Cloudflare Email Worker
│   │   ├── src/
│   │   │   ├── index.ts            ← email() handler
│   │   │   └── utils/
│   │   │       ├── extract-images.ts
│   │   │       └── fetch-image.ts
│   │   ├── wrangler.toml
│   │   └── package.json
│   │
│   └── api/                        ← 图库 API Worker
│       ├── src/
│       │   ├── index.ts            ← fetch() handler
│       │   └── routes/
│       │       ├── images.ts
│       │       └── stats.ts
│       ├── wrangler.toml
│       └── package.json
│
├── web/                            ← 图库前端 (Astro)
│   ├── src/
│   │   ├── pages/
│   │   │   ├── index.astro         ← 首页瀑布流
│   │   │   ├── favorites.astro
│   │   │   └── image/[id].astro    ← 单图详情
│   │   ├── components/
│   │   │   ├── GalleryGrid.astro
│   │   │   ├── ImageCard.astro
│   │   │   └── Lightbox.tsx        ← React Island
│   │   └── layouts/
│   │       └── Layout.astro
│   └── package.json
│
├── db/
│   └── schema.sql                  ← D1 数据库 schema
│
└── README.md
```

### 8.2 Cloudflare 配置清单

```toml
# workers/email-worker/wrangler.toml

name = "pinterest-email-worker"
main = "src/index.ts"
compatibility_date = "2026-02-01"

[[r2_buckets]]
binding = "GALLERY_BUCKET"
bucket_name = "gallery-images"

[[d1_databases]]
binding = "IMAGE_DB"
database_name = "gallery-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[[queues.producers]]
binding = "IMAGE_QUEUE"
queue = "image-processing"

# ─── 以下为 Queue Consumer Worker 配置 ───

# workers/queue-consumer/wrangler.toml (可合并到同一 Worker)
[[queues.consumers]]
queue = "image-processing"
max_batch_size = 5
max_retries = 3
dead_letter_queue = "image-processing-dlq"
```

### 8.3 部署步骤

```bash
# 1. 创建 R2 Bucket
npx wrangler r2 bucket create gallery-images

# 2. 创建 D1 Database
npx wrangler d1 create gallery-db
npx wrangler d1 execute gallery-db --file=./db/schema.sql

# 3. 创建 Queue
npx wrangler queues create image-processing

# 4. 部署 Email Worker
cd workers/email-worker && npx wrangler deploy

# 5. 配置 Email Routing (Dashboard)
#    Cloudflare Dashboard → Email → Email Routing
#    添加规则: pinterest@yourdomain.com → Worker: pinterest-email-worker

# 6. 配置 Gmail 转发规则
#    Gmail → Settings → Filters → Create filter
#    From: pinterest.com → Forward to: pinterest@yourdomain.com

# 7. 部署前端
cd web && npx astro build && npx wrangler pages deploy dist/
```

---

## 9. 扩展性考量

### 9.1 后续可扩展方向

| 扩展 | 描述 | 难度 |
|------|------|------|
| **多来源支持** | 接入其他 Newsletter 图片（Dribbble、Behance 等） | ⭐⭐ |
| **AI 自动标签** | 使用 Cloudflare Workers AI 进行图片分类/描述 | ⭐⭐ |
| **相似图片搜索** | 基于感知哈希 (pHash) 的相似图搜索 | ⭐⭐⭐ |
| **RSS 输出** | 将图库作为 RSS Feed 输出 | ⭐ |
| **移动端 PWA** | 添加 Service Worker 支持离线浏览 | ⭐⭐ |
| **批量管理** | 后台管理界面：批量标签、删除、归档 | ⭐⭐ |

### 9.2 架构扩展点

```
当前: Pinterest Email → Email Worker → R2/D1 → Gallery

扩展:
  ┌── Pinterest Email ──┐
  ├── Dribbble Email  ──┤
  ├── RSS Feed ─────────┤──→ 统一 Queue ──→ R2/D1 ──→ Gallery
  ├── 手动上传 ─────────┤
  └── Browser Extension ┘
```

通过 Queue 解耦，新增数据来源只需添加新的 Producer，消费端逻辑不变。

---

## 附录

### A. Pinterest 邮件发件人地址汇总

```
recommendations@reply.pinterest.com    ← 推荐邮件（主要来源）
pindigest@account.pinterest.com        ← 每周摘要
noreply@account.pinterest.com          ← 账户通知
```

建议过滤条件使用 `pinterest.com` 域名匹配，而非特定地址。

### B. 相关开源项目参考

| 项目 | 描述 | 链接 |
|------|------|------|
| cf-email-to-json-worker | CF Email Worker 解析邮件存 R2 | [GitHub](https://github.com/cvyl/cf-email-to-json-worker) |
| pinterest-scraper | Pinterest 图片质量升级 API | [GitHub](https://github.com/ifeiera/pinterest-scraper) |
| postal-mime | CF 团队开发的 MIME 解析库 | [npm](https://www.npmjs.com/package/postal-mime) |
| pinterest-dl | Python Pinterest 图片下载器 | [GitHub](https://github.com/sean1832/pinterest-dl) |

### C. 关键 API 参考

- [Cloudflare Email Workers 文档](https://developers.cloudflare.com/email-routing/email-workers/)
- [Cloudflare R2 API 文档](https://developers.cloudflare.com/r2/)
- [Cloudflare D1 文档](https://developers.cloudflare.com/d1/)
- [Cloudflare Queues 文档](https://developers.cloudflare.com/queues/)
