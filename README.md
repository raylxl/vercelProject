# 智能多格式批量下单系统

面向物流/快递批量下单场景的万能导入 V2 考试项目。系统通过 Next.js App Router + TypeScript 构建，支持 Excel / Word / PDF 文件上传，使用大模型生成可编辑解析规则，再由规则引擎把复杂文件解析为结构化出库单并持久化到数据库。

## 在线地址与仓库

- 生产地址：https://vercelproject-roan-theta.vercel.app
- 源码仓库：git@github.com:raylxl/vercelProject.git
- 默认入口：`/` 自动跳转到 `/universal-import`

## 考试技术要求对应关系

以下结论按当前仓库代码、当前生产地址和当前环境配置逐项核对。

| 考试要求 | 当前实现 | 对应位置 | 结论 |
| --- | --- | --- | --- |
| 技术栈：Next.js App Router + TypeScript | 项目基于 `next`、`react`、`typescript`，页面与接口均采用 App Router 目录结构。 | `package.json`、`app/`、`app/api/` | 满足 |
| 部署：Vercel，提供可访问 URL | 已部署到 Vercel，当前生产地址可访问：`https://vercelproject-roan-theta.vercel.app`。`vercel.json` 已声明 Next.js 构建命令。 | `vercel.json`、生产地址 | 满足 |
| UI 风格：与鲸天系统保持一致，主色 `#0fc6c2`、圆角卡片、清爽蓝绿色调 | 全局样式使用 `#0fc6c2` 作为主色，页面采用圆角卡片、浅蓝绿色背景、管理后台式布局。页签标题和考试菜单已收敛为“智能多格式批量下单系统”。 | `app/globals.css`、`app/layout.tsx`、`app/universal-import/universal-import-client.tsx` | 满足 |
| 大模型：通过 API 调用 DeepSeek / GPT / Claude 等，将文件内容转为结构化下单数据 | 当前实现通过服务端 API 调用 DeepSeek 官网或 SiliconFlow。AI 先生成可编辑解析规则，再由规则解释器将文件转为结构化下单数据。不是前端假数据。 | `lib/siliconflow.ts`、`app/api/universal-import/templates/ai-suggest/route.ts`、`app/api/universal-import/templates/test/route.ts` | 满足 |
| 数据库：Neon / Supabase / Turso 等，通过 Vercel Marketplace 集成 | 当前代码通过 Prisma + PostgreSQL 持久化规则、批次、运单、SKU 明细。当前环境变量使用云端 Postgres 连接串，功能层面满足“云数据库持久化”。但若考试严格要求“必须明确展示为 Vercel Marketplace 中的 Neon / Supabase / Turso 某一项”，则还需要在答辩时补充对应集成截图或在 README 中附上具体数据库产品名称。 | `prisma/schema.prisma`、`lib/prisma.ts`、`.env.local` 中 `DATABASE_URL` | 部分满足 |

### 技术要求结论

- `Next.js App Router + TypeScript`：满足
- `Vercel 生产部署并提供 URL`：满足
- `鲸天系统风格 UI`：满足
- `大模型 API 真实接入`：满足
- `数据库通过云端持久化`：满足
- `数据库产品与 Vercel Marketplace 对应关系的证明材料`：当前仓库内未直接保留 Marketplace 截图或数据库产品说明，因此按考试“材料完整度”口径记为部分满足

### 建议答辩口径

- 如果考官关注“有没有数据库”，当前项目可以明确回答：有，规则、导入批次、运单、SKU 明细都已落库。
- 如果考官继续追问“是不是通过 Vercel Marketplace 接的哪一家”，建议补一张 Vercel Project Storage / Marketplace 的截图，或把实际数据库供应商名称补进本文档，这样这一项就能从“部分满足”提升为“完全满足”。

## 核心能力

- 规则管理：解析规则持久化到 PostgreSQL，支持新建、编辑、删除、复制。
- 手动选择规则：导入页必须由用户手动选择解析规则，系统不做文件自动匹配。
- AI 辅助生成规则：上传样例文件后调用大模型分析文件结构，输出字段映射、transform config、置信度报告和风险提示。
- 规则预览测试：保存前可用当前文件试解析，确认后再保存规则。
- 通用规则引擎：支持 `header_mapping`、`multisheet_merge`、`group_by_external_code`、`matrix_pivot`、`split_multiline_cell`、`tail_text_extract`、`card_split`、`text_record_split` 等 transform，不按文件名写 if-else。
- 数据预览与校验：类 Excel 表格在线编辑、行内标红、全部错误汇总、外部编码同批次和历史重复检测、删除行、新增行、导出 Excel。
- 提交下单：有错误禁止提交，成功后按外部编码聚合为运单和 SKU 明细并写入数据库。
- 历史运单：支持按外部编码、收件人姓名、提交日期筛选和分页查看。
- 高性能：预览表格使用分批渲染，1000+ 行先渲染首批数据，其余数据仍参与校验、导出和提交。
- 钉钉预警：可选配置 `DINGTALK_WEBHOOK_URL`，对 AI 降级、试解析失败、提交校验失败和提交异常进行非阻塞告警。

## 技术栈

- Next.js App Router
- TypeScript / React 19
- Prisma ORM
- PostgreSQL，适配 Neon / Supabase / Prisma Postgres 等 Vercel Marketplace 数据库
- Vercel 部署

## 大模型配置

优先使用 DeepSeek 官网 API；未配置 DeepSeek 时可使用 SiliconFlow；两者都未配置时返回本地兜底规则，并在界面标识为兜底结果。

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require"

DEEPSEEK_API_KEY="sk-..."
DEEPSEEK_BASE_URL="https://api.deepseek.com"
DEEPSEEK_MODEL="deepseek-v4-flash"

SILICONFLOW_API_KEY="sk-..."
SILICONFLOW_BASE_URL="https://api.siliconflow.cn/v1"
SILICONFLOW_MODEL="deepseek-ai/DeepSeek-V4-Pro"

DINGTALK_WEBHOOK_URL=""
DINGTALK_SECRET=""
```

API Key 只放在服务端环境变量中，前端不会暴露。AI 生成规则接口位于 `app/api/universal-import/templates/ai-suggest/route.ts`，大模型调用封装在 `lib/siliconflow.ts`。

## Prompt 设计思路

系统先把原始文件转换成统一文档摘要，包括 headers、rawRows、sections 和 textPreview；再把标准下单字段、规则 DSL schema、支持的 transform 类型和约束一起发给大模型。Prompt 要求模型只返回 JSON，明确输出：

- `mapping`：标准字段到文档列的映射。
- `enabledTransforms`：需要启用的通用 transform。
- `transformConfigs`：每个 transform 的可解释配置。
- `confidenceReport`：每个字段映射的置信度与来源，用于界面标注“高置信 / AI推测 / 需确认”。
- `riskNotes`：需要人工确认的风险点。

系统执行的是 AI 生成的规则，而不是让 AI 直接返回最终下单数据，因此新增格式时只需要新增或调整规则，不需要改业务代码。

## 本地运行

```bash
npm install
npx prisma migrate dev
npm run dev
```

生产构建验证：

```bash
npm run build
npm run start
```

## 部署

项目包含 `vercel.json`：

```json
{
  "buildCommand": "prisma migrate deploy && next build"
}
```

Vercel 部署时会先执行数据库 migration，再执行 Next.js 构建。
