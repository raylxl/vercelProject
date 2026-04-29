# Vercel 全栈部署模板

这是一个可以直接部署到 Vercel 的最小全栈模板：

- 前端：Next.js App Router
- 后端：Next.js Route Handlers
- 数据库：PostgreSQL
- ORM：Prisma

## Prisma 版本说明

这个模板当前固定使用 `Prisma 6.x`。原因是 `Prisma 7` 已经调整了 datasource 和 client 的配置方式，
会让传统的 `schema.prisma + prisma migrate deploy` 模板额外增加一层配置复杂度。

如果你的目标是先把项目稳定部署到 Vercel，这个版本线更直接。

## 当前 Vercel 数据库方式

根据 Vercel 官方文档，`Vercel Postgres` 已在 2024 年 12 月迁移到 `Neon`，新项目应通过 Vercel Marketplace 安装 Postgres 集成，并把数据库环境变量自动注入到项目中。

因此这个模板统一使用标准的 `DATABASE_URL`，可以接：

- Prisma Postgres
- Neon
- Supabase
- Railway Postgres
- 任何兼容 PostgreSQL 的数据库

## 本地运行

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

把 `.env.example` 复制成 `.env.local`，填入你自己的 PostgreSQL 连接串：

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require"
```

3. 创建表结构

```bash
npx prisma migrate dev --name init
```

4. 启动项目

```bash
npm run dev
```

## 部署到 Vercel

1. 把当前项目推到 GitHub / GitLab / Bitbucket。
2. 在 Vercel 中 `Add New Project`，导入这个仓库。
3. 在项目的 `Storage` 页面添加一个 PostgreSQL 集成。
   推荐直接选 `Prisma Postgres` 或 `Neon`。
4. 确认 Vercel 已为项目注入 `DATABASE_URL`。
5. 重新部署。

项目里已经包含 `vercel.json`：

```json
{
  "buildCommand": "prisma migrate deploy && next build"
}
```

这意味着 Vercel 在构建时会先执行数据库 migration，再执行 Next.js 构建。

## 关键目录

- `app/page.tsx`：前端首页
- `app/api/messages/route.ts`：后端 API
- `lib/prisma.ts`：Prisma Client 单例
- `prisma/schema.prisma`：数据库模型
- `vercel.json`：Vercel 构建配置

## 可直接验证的接口

- 页面：`/`
- 读数据：`/api/messages`
- 写数据：`POST /api/messages`

## 参考文档

- [Vercel Postgres on Vercel](https://vercel.com/docs/postgres)
- [Next.js on Vercel](https://vercel.com/docs/frameworks/nextjs)
- [vercel.json buildCommand](https://vercel.com/docs/project-configuration/vercel-json)
- [Prisma Postgres via Vercel Marketplace](https://docs.prisma.io/docs/guides/postgres/vercel)
