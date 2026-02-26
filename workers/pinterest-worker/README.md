# Pinterest Email Worker

从 Pinterest 推荐邮件中自动提取图片，存储到 Backblaze B2（Private Bucket），通过 Worker 代理公开访问，供博客 Gallery 页面展示。

## 架构

```
┌──────────────── 数据写入 ────────────────┐
│                                                │
│  Pinterest Email → Gmail 转发 → CF Email Routing  │
│                                   ↓              │
│                          Email Worker (email())  │
│                            ↓                     │
│                    解析 → 下载 → 去重 → 存 B2     │
│                            ↓                     │
│                    更新 index.json → 触发 Vercel   │
└────────────────────────────────────────────────┘

┌──────────────── 数据读取 ────────────────┐
│                                                │
│  浏览器 / Vercel build                            │
│       ↓                                         │
│  Worker fetch() ── CF Edge Cache                │
│       │              │                             │
│       │   命中 → 直接返回（不打 B2）             │
│       │   未中 → S3 API → B2 Private Bucket      │
│       ↓                                         │
│  图片 / index.json                               │
└────────────────────────────────────────────────┘
```

**B2 Bucket 保持 Private**，Worker 的 `fetch()` handler 作为代理，用 S3 API 认证后返回图片。
Cloudflare Edge 自动缓存响应，图片是 immutable 的，缓存命中率极高。

## 部署步骤

### 1. 创建 B2 Bucket

1. 登录 [Backblaze B2](https://secure.backblaze.com/b2_buckets.htm)
2. 创建 Bucket：名称 `pinterest-gallery`，类型选 **Private**
3. 记下 Bucket 的 S3 **Endpoint**（如 `s3.us-west-004.backblazeb2.com`）

### 2. 创建 B2 Application Key

1. B2 → App Keys → Add a New Application Key
2. 限制到 `pinterest-gallery` bucket
3. 记下 **keyID** 和 **applicationKey**（仅显示一次）

### 3. 设置环境变量

编辑 `wrangler.toml`：

```toml
[vars]
B2_ENDPOINT = "https://s3.us-east-005.backblazeb2.com"
B2_BUCKET_NAME = "pinterest-gallery"
WORKER_PUBLIC_URL = "https://pinterest-email-worker.nianyi778.workers.dev"  # 部署后填入 Worker URL（见第 5 步）
FORWARD_TO = "nianyi778@gmail.com""
VERCEL_DEPLOY_HOOK = ""  # 可选
```

设置 Secrets：

```bash
cd workers/pinterest-worker
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APP_KEY
```

### 4. 安装依赖并部署

```bash
bun install
npx wrangler deploy
```

部署后会显示 Worker URL，如：
```
https://pinterest-email-worker.nianyi778.workers.dev
```

### 5. 填入 WORKER_PUBLIC_URL

把第 4 步得到的 URL 填入 `wrangler.toml` 的 `WORKER_PUBLIC_URL`，然后重新部署：

```bash
npx wrangler deploy
```

> 可选：在 Cloudflare Workers 设置中绑定自定义域名（如 `gallery.yourdomain.com`）作为 WORKER_PUBLIC_URL。

### 6. 配置 Cloudflare Email Routing

Cloudflare Dashboard → Email → Email Routing：

1. 启用 Email Routing（DNS 自动添加 MX 记录）
2. 添加路由规则：`pinterest@yourdomain.com` → Worker: `pinterest-email-worker`

### 7. 配置 Gmail 转发

Gmail → 设置 → 过滤器：

1. 创建过滤器：发件人包含 `pinterest.com`
2. 操作：转发至 `pinterest@yourdomain.com`

### 8. 配置 Vercel 环境变量

在 Vercel 项目设置中添加：

```
GALLERY_INDEX_URL = https://pinterest-email-worker.your-subdomain.workers.dev/gallery/index.json
```

博客 build 时通过 Worker 代理拉取最新图片列表。

### 9.（可选）Vercel Deploy Hook

Vercel → Settings → Git → Deploy Hooks 创建 hook，
填入 `wrangler.toml` 的 `VERCEL_DEPLOY_HOOK`。

Worker 处理完新图片后自动触发博客重建。

## Worker API

Worker 同时提供两个 handler：

| Handler | 触发方式 | 用途 |
|---------|---------|------|
| `email()` | Cloudflare Email Routing | 接收邮件、提取图片、存 B2 |
| `fetch()` | HTTP 请求 | 代理 B2 对象，服务图片和 index.json |

Fetch handler 路由：

| 路径 | 说明 | 缓存 |
|------|------|------|
| `GET /gallery/index.json` | 图片元数据清单 | 5 分钟 |
| `GET /gallery/{uuid}.jpg` | 原图 | 1 年（immutable） |

## 本地开发

```bash
cd workers/pinterest-worker
bun install
npx wrangler dev  # 启动本地 Worker（fetch handler 可测试，email handler 无法本地触发）
```

本地测试 fetch handler：
```bash
curl http://localhost:8787/gallery/index.json
```

## 数据结构

B2 Bucket 结构：

```
pinterest-gallery/
├── gallery/
│   ├── index.json           ← 图片元数据清单
│   ├── {uuid}.jpg           ← 原图
│   ├── {uuid}.png
│   └── ...
```

## 成本

| 资源 | B2 免费额度 | 月用量估算 |
|------|------------|-----------|
| 存储 | 10 GB | ~360 MB |
| 上传 | 无限 | ~360 次 |
| 下载 | Worker 代理 + Edge Cache | 极少打 B2 |
| Workers 请求 | 100K/天 | ~200/天 |

**预计费用：$0/月**
