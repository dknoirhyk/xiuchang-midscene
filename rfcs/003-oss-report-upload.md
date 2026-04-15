# RFC 003: 报告上传至阿里云 OSS

## 背景与动机

当前 Midscene 生成的报告 HTML 文件只保存在本地 `midscene_run/report/` 目录下，无法方便地分享给他人。本方案旨在将报告自动上传到阿里云 OSS，生成可分享的在线链接，方便团队协作和远程查看报告。

## 现有报告生成流程分析

### 报告生成的核心路径

```
测试执行 → ReportGenerator.onExecutionUpdate() → 写入本地 HTML
         → ReportGenerator.finalize() → 输出本地报告路径
```

### 关键文件与类

| 文件 | 类/函数 | 职责 |
|------|---------|------|
| `packages/core/src/report-generator.ts` | `ReportGenerator` | 核心报告生成器，管理单个报告的写入与最终化 |
| `packages/core/src/report.ts` | `ReportMergingTool` | 多报告合并工具 |
| `packages/core/src/agent/utils.ts` | `printReportMsg()` | 输出报告路径到控制台 |
| `packages/web-integration/src/playwright/reporter/index.ts` | `MidsceneReporter` | Playwright 集成的报告生成器 |
| `packages/shared/src/common.ts` | `getMidsceneRunSubDir()` | 管理 `midscene_run/report/` 目录 |
| `packages/shared/src/env/types.ts` | 环境变量常量 | 定义 `MIDSCENE_REPORT_*` 等环境变量 |

### 报告输出模式

1. **single-html（内联模式）**：截图以 base64 嵌入单个 HTML 文件，最终产物为 `{name}.html`
2. **html-and-external-assets（目录模式）**：截图作为外部 PNG 文件，产物为 `{name}/index.html` + `{name}/screenshots/*.png`

### 报告路径控制台输出

目前有两个输出点：
- `ReportGenerator.printReportPath(verb)` — 在创建、首次写入、最终化时输出
- `printReportMsg(filepath)` — 被 Playwright Reporter 使用

输出格式示例：
```
report finalized: /path/to/midscene_run/report/web-2025-04-13_10-30-00-abcd1234.html
report file updated: /path/to/midscene_run/report/playwright-merged-xxx.html
```

## 凭证方案：STS 临时凭证

采用团队已有的 STS 临时凭证模式，通过内部 Token 服务动态获取凭证。参考团队 Python 实现：

```python
_oss_token_ufo_url = 'https://ufo2.alitrip.com/api/multiappAutoJob/getOssToken.json'

def get_token_from_ufo():
    request_data = {"token": int(round(time.time() * 1000))}
    response = requests.post(_oss_token_ufo_url, json=request_data)
    d = json.loads(response.text)['resultObj']
    return Authority(
        accessId=d['accessKeyId'],
        accessSecret=d['accessKeySecret'],
        stsToken=d['securityToken'],     # ← STS 临时 Token
        region='oss-cn-beijing',
        bucketName='xrayandroid'
    )
```

**核心流程**：POST Token Service URL → 获取临时 `accessKeyId` + `accessKeySecret` + `securityToken` → 初始化 OSS 客户端上传。

## 方案设计

### 整体架构

```
报告生成完成 (finalize/mergeReports)
      ↓
  检查 OSS 配置是否开启 (MIDSCENE_OSS_ENABLE)
      ↓ 是
  Dump 去重（仅保留最后一份 JSON Dump）
      ↓
  截图压缩（PNG → JPEG，可选，由 MIDSCENE_REPORT_JPEG_QUALITY 控制）
      ↓
  POST Token Service URL → 获取 STS 临时凭证
      ↓
  通过 ali-oss SDK 上传到 OSS
  (去掉 .html 后缀绕过强制下载，设置 Content-Type: text/html)
      ↓
  拼接在线访问 URL（无 .html 后缀）
      ↓
  输出在线报告地址到控制台
```

### 环境变量设计

在 `packages/shared/src/env/types.ts` 中新增以下环境变量：

| 环境变量 | 类型 | 必填 | 说明 |
|----------|------|------|------|
| `MIDSCENE_OSS_ENABLE` | boolean | 否 | 是否启用 OSS 上传，默认 `false` |
| `MIDSCENE_OSS_TOKEN_URL` | string | 是* | STS Token 服务地址，如 `https://ufo2.alitrip.com/api/multiappAutoJob/getOssToken.json` |
| `MIDSCENE_OSS_TOKEN_RESPONSE_PATH` | string | 否 | Token 响应中凭证对象的 JSON 路径，默认 `resultObj`。也可设为 `data` 以适配 qlive 接口 |
| `MIDSCENE_OSS_REGION` | string | 否 | OSS 区域，默认 `oss-cn-beijing`。可被 Token Service 返回值覆盖 |
| `MIDSCENE_OSS_BUCKET` | string | 否 | Bucket 名称，默认 `xrayandroid` |
| `MIDSCENE_OSS_ENDPOINT` | string | 否 | 自定义 Endpoint，如 `oss-cn-beijing.aliyuncs.com` |
| `MIDSCENE_OSS_PREFIX` | string | 否 | 上传路径前缀，默认 `report/` |
| `MIDSCENE_OSS_DOMAIN` | string | 否 | 自定义访问域名。如不设置使用 Bucket 默认域名拼接 |
| `MIDSCENE_REPORT_JPEG_QUALITY` | number (1-100) | 否 | 截图 JPEG 压缩质量。设置后自动将报告中的 PNG 截图转为 JPEG，推荐值 80。不设置则保持原始 PNG |

> *仅在 `MIDSCENE_OSS_ENABLE=true` 时必填

## 实现计划

开发分为两个独立阶段，避免上传部分的问题影响 Midscene 主流程运行。

---

### 第一步：实现独立上传工具 + 测试 Demo

**目标**：独立验证 STS 凭证获取、文件上传、HTML 在线预览全链路，不触碰 Midscene 任何现有代码。

#### 1.1 新增文件

| 文件 | 说明 |
|------|------|
| `packages/shared/src/oss/index.ts` | OSS 上传工具模块（STS 凭证获取 + 上传） |
| `packages/shared/src/oss/demo.ts` | 独立测试脚本，手动指定本地 HTML 文件上传并验证 |

#### 1.2 OSS 上传工具模块 — `packages/shared/src/oss/index.ts`

```typescript
// packages/shared/src/oss/index.ts
import OSS from 'ali-oss';
import path from 'node:path';

// ========================
// 类型定义
// ========================

export interface OSSUploadConfig {
  accessKeyId: string;
  accessKeySecret: string;
  stsToken: string;
  region: string;           // e.g. 'oss-cn-beijing'
  bucket: string;           // e.g. 'xrayandroid'
  endpoint?: string;        // e.g. 'oss-cn-beijing.aliyuncs.com'
  prefix?: string;          // e.g. 'report/'
  customDomain?: string;    // e.g. 'https://your-domain.com'
}

export interface OSSUploadResult {
  success: boolean;
  url?: string;       // 在线访问 URL
  ossPath?: string;   // OSS 上的完整路径
  error?: string;
}

/** Token Service 返回的凭证字段 */
interface STSTokenResponse {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  region?: string;
}

// ========================
// STS 凭证获取
// ========================

/**
 * 从 Token Service 获取 STS 临时凭证
 * 兼容两种响应格式：
 *   - { "resultObj": { accessKeyId, accessKeySecret, securityToken } }
 *   - { "data": { accessKeyId, accessKeySecret, securityToken, region } }
 */
async function fetchSTSToken(
  tokenUrl: string,
  responsePath: string,
): Promise<{
  accessKeyId: string;
  accessKeySecret: string;
  stsToken: string;
  region?: string;
} | null> {
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: Date.now() }),
    });

    if (!response.ok) {
      console.warn(`[Midscene OSS] Token service returned HTTP ${response.status}`);
      return null;
    }

    const json = await response.json();
    const tokenData = json[responsePath] as STSTokenResponse | undefined;

    if (!tokenData?.accessKeyId || !tokenData?.accessKeySecret || !tokenData?.securityToken) {
      console.warn(
        `[Midscene OSS] Token service response missing required fields at "${responsePath}"`,
      );
      return null;
    }

    return {
      accessKeyId: tokenData.accessKeyId,
      accessKeySecret: tokenData.accessKeySecret,
      stsToken: tokenData.securityToken,
      region: tokenData.region,
    };
  } catch (error: any) {
    console.warn(`[Midscene OSS] Failed to fetch STS token: ${error.message}`);
    return null;
  }
}

/**
 * 从环境变量获取 OSS 配置并动态获取 STS 凭证
 * 返回 null 表示未启用或凭证获取失败
 */
export async function getOSSConfigFromEnv(): Promise<OSSUploadConfig | null> {
  if (process.env.MIDSCENE_OSS_ENABLE !== 'true') return null;

  const tokenUrl = process.env.MIDSCENE_OSS_TOKEN_URL;
  if (!tokenUrl) {
    console.warn('[Midscene OSS] MIDSCENE_OSS_TOKEN_URL is required when OSS upload is enabled');
    return null;
  }

  const responsePath = process.env.MIDSCENE_OSS_TOKEN_RESPONSE_PATH || 'resultObj';
  const stsResult = await fetchSTSToken(tokenUrl, responsePath);
  if (!stsResult) return null;

  return {
    accessKeyId: stsResult.accessKeyId,
    accessKeySecret: stsResult.accessKeySecret,
    stsToken: stsResult.stsToken,
    region: process.env.MIDSCENE_OSS_REGION || stsResult.region || 'oss-cn-beijing',
    bucket: process.env.MIDSCENE_OSS_BUCKET || 'xrayandroid',
    endpoint: process.env.MIDSCENE_OSS_ENDPOINT,
    prefix: process.env.MIDSCENE_OSS_PREFIX || 'report/',
    customDomain: process.env.MIDSCENE_OSS_DOMAIN,
  };
}

// ========================
// 上传
// ========================

/**
 * 上传单个 HTML 报告文件到 OSS
 *
 * 关于 HTML 预览：
 * - 2017-10-01 之后创建的 Bucket，使用 OSS 默认域名访问 .html 文件时，
 *   OSS 会自动添加 x-oss-force-download: true 和 Content-Disposition: attachment，
 *   导致浏览器强制下载而非预览。
 * - 解决方案：上传时去掉 .html 后缀，通过 Content-Type 告诉浏览器按 HTML 渲染。
 *   如配置了自定义域名（MIDSCENE_OSS_DOMAIN），则保留原始文件名。
 */
export async function uploadReportToOSS(
  localFilePath: string,
  config: OSSUploadConfig,
): Promise<OSSUploadResult> {
  try {
    const client = new OSS({
      region: config.region,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      stsToken: config.stsToken,
      bucket: config.bucket,
      endpoint: config.endpoint ? `https://${config.endpoint}` : undefined,
    });

    const fileName = path.basename(localFilePath);

    // OSS 默认域名对路径以 .htm/.html 结尾的文件强制下载
    // 解决方案：去掉文件后缀，通过 Content-Type 告诉浏览器按 HTML 渲染
    let ossPath: string;
    if (config.customDomain) {
      // 自定义域名不受强制下载限制，保留原始文件名
      ossPath = `${config.prefix}${fileName}`;
    } else {
      // 默认域名：去掉 .html/.htm 后缀以绕过强制下载策略
      const nameWithoutExt = fileName.replace(/\.html?$/i, '');
      ossPath = `${config.prefix}${nameWithoutExt}`;
    }

    // 上传并设置元数据
    await client.put(ossPath, localFilePath, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-cache',
      },
    });

    // 拼接访问 URL
    const url = config.customDomain
      ? `${config.customDomain.replace(/\/$/, '')}/${ossPath}`
      : `https://${config.bucket}.${config.region}.aliyuncs.com/${ossPath}`;

    return { success: true, url, ossPath };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}
```

#### 1.3 独立测试 Demo — `packages/shared/src/oss/demo.ts`

用于手动验证上传和预览，不依赖 Midscene 任何模块：

```typescript
// packages/shared/src/oss/demo.ts
// 运行方式：npx tsx packages/shared/src/oss/demo.ts [本地HTML文件路径]
import { existsSync } from 'node:fs';
import { getOSSConfigFromEnv, uploadReportToOSS } from './index';

async function main() {
  const filePath = process.argv[2];

  if (!filePath || !existsSync(filePath)) {
    console.error('用法: npx tsx packages/shared/src/oss/demo.ts <本地HTML文件路径>');
    console.error('示例: npx tsx packages/shared/src/oss/demo.ts ./midscene_run/report/xxx.html');
    process.exit(1);
  }

  // 强制启用 OSS（demo 中不依赖环境变量开关）
  process.env.MIDSCENE_OSS_ENABLE = 'true';

  console.log('1. 获取 STS 凭证...');
  const config = await getOSSConfigFromEnv();
  if (!config) {
    console.error('获取 OSS 配置失败，请检查 MIDSCENE_OSS_TOKEN_URL 环境变量');
    process.exit(1);
  }
  console.log(`   ✓ 凭证获取成功 (region=${config.region}, bucket=${config.bucket})`);

  console.log(`2. 上传文件: ${filePath}`);
  const result = await uploadReportToOSS(filePath, config);

  if (result.success) {
    console.log('   ✓ 上传成功!');
    console.log(`   OSS 路径: ${result.ossPath}`);
    console.log(`   在线地址: ${result.url}`);
    console.log('');
    console.log('3. 请在浏览器中打开以上链接，验证是否可以直接预览（而非下载）');
  } else {
    console.error(`   ✗ 上传失败: ${result.error}`);
    process.exit(1);
  }
}

main();
```

#### 1.4 第一步验证流程

```bash
# 1. 安装依赖
pnpm add ali-oss --filter @midscene/shared
pnpm add -D @types/ali-oss --filter @midscene/shared

# 2. 配置环境变量
export MIDSCENE_OSS_TOKEN_URL=https://ufo2.alitrip.com/api/multiappAutoJob/getOssToken.json

# 3. 运行 demo（用 midscene_run 下已有的报告文件测试）
npx tsx packages/shared/src/oss/demo.ts ./midscene_run/report/xxx.html

# 预期输出：
# 1. 获取 STS 凭证...
#    ✓ 凭证获取成功 (region=oss-cn-beijing, bucket=xrayandroid)
# 2. 上传文件: ./midscene_run/report/xxx.html
#    ✓ 上传成功!
#    OSS 路径: report/xxx          ← 注意：无 .html 后缀
#    在线地址: https://xrayandroid.oss-cn-beijing.aliyuncs.com/report/xxx
#
# 3. 请在浏览器中打开以上链接，验证是否可以直接预览（而非下载）

# 4. 在浏览器中打开链接，确认：
#    - HTML 能直接预览（不是下载）
#    - 报告内容渲染正常
```

#### 1.5 第一步完成标准

- [ ] STS Token 获取成功
- [ ] HTML 文件上传到 OSS 成功
- [ ] 通过返回的 URL 可以在浏览器中直接预览报告（非下载）
- [ ] 报告内容渲染正常（CSS/JS/截图均正常显示）

#### 1.6 第一步涉及文件变更

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `packages/shared/src/oss/index.ts` | **新增** | OSS 上传工具模块 |
| `packages/shared/src/oss/demo.ts` | **新增** | 独立测试脚本 |
| `packages/shared/package.json` | 修改 | 添加 `ali-oss` + `@types/ali-oss` 依赖 |

> **注意**：第一步不修改 `packages/core` 或 `packages/web-integration` 的任何文件，与 Midscene 主流程完全隔离。

---

### 第二步：集成到 Midscene 报告流程

**前置条件**：第一步验证通过（上传成功 + 预览正常）后再进行。

**目标**：将上传能力嵌入 Midscene 报告生成的 finalize 阶段，自动上传并输出在线链接。

#### 2.1 新增环境变量

在 `packages/shared/src/env/types.ts` 中注册 OSS 相关环境变量常量。

#### 2.2 在 `packages/shared/package.json` 中添加 `./oss` export 入口

```json
"./oss": {
  "types": "./dist/types/oss/index.d.ts",
  "import": "./dist/es/oss/index.mjs",
  "require": "./dist/lib/oss/index.js"
}
```

#### 2.3 集成点 — `packages/core/src/report-generator.ts`

在 `ReportGenerator.finalize()` 方法中，输出本地路径之后触发 OSS 上传：

```typescript
// 在 ReportGenerator 中新增方法
private async uploadToOSSIfEnabled(): Promise<void> {
  try {
    // 动态 import 避免在不需要时加载 ali-oss
    const { getOSSConfigFromEnv, uploadReportToOSS } = await import('@midscene/shared/oss');
    const ossConfig = await getOSSConfigFromEnv();
    if (!ossConfig) return;

    // 仅支持 single-html 模式上传
    if (this.screenshotMode !== 'inline') return;

    const result = await uploadReportToOSS(this.reportPath, ossConfig);
    if (result.success) {
      logMsg(`online report: ${result.url}`);
    } else {
      logMsg(`OSS upload failed: ${result.error}`);
    }
  } catch {
    // 上传失败不影响主流程
  }
}

// 修改 finalize()
async finalize(): Promise<string | undefined> {
  // ... 现有逻辑不变 ...
  this.printReportPath('finalized');

  // 体积优化：Dump 去重 + 截图压缩
  this.deduplicateDumps();
  await this.compressScreenshots();

  // 新增：上传到 OSS（try-catch 保护，不影响返回值）
  await this.uploadToOSSIfEnabled();

  return this.reportPath;
}
```

#### 2.4 集成点 — `packages/core/src/report.ts`

在 `ReportMergingTool.mergeReports()` 返回之后，使用 fire-and-forget 模式异步上传，不改变同步签名：

```typescript
// mergeReports() 保持同步签名不变
// 在调用方（如 Playwright Reporter 的 onEnd）获取 mergeReports 返回值后触发上传
```

#### 2.5 集成点 — `packages/web-integration/src/playwright/reporter/index.ts`

在 Playwright Reporter 的 `onEnd()` 中上传最终报告：

```typescript
async onEnd() {
  // ... 现有逻辑不变 ...

  // 新增：上传到 OSS
  try {
    const { getOSSConfigFromEnv, uploadReportToOSS } = await import('@midscene/shared/oss');
    const ossConfig = await getOSSConfigFromEnv();
    if (ossConfig && this.mode === 'merged' && this.outputFormat === 'single-html') {
      const reportPath = this.getReportPath();
      const result = await uploadReportToOSS(reportPath, ossConfig);
      if (result.success) {
        console.log(`online report: ${result.url}`);
      }
    }
  } catch (e) {
    // 上传失败不影响主流程
    console.warn(`OSS upload failed: ${e}`);
  }
}
```

#### 2.6 控制台输出效果

启用 OSS 上传后，控制台输出示例：

```
report will be generated at: /Users/xxx/midscene_run/report/web-2025-04-13_10-30-00-abcd1234.html
report generated: /Users/xxx/midscene_run/report/web-2025-04-13_10-30-00-abcd1234.html
report finalized: /Users/xxx/midscene_run/report/web-2025-04-13_10-30-00-abcd1234.html
report optimized: removed 55 redundant dumps, saved 41.4 MB
screenshots compressed: 14 PNG → JPEG (quality=80), saved 19.2 MB
online report: https://xrayandroid.oss-cn-beijing.aliyuncs.com/report/web-2025-04-13_10-30-00-abcd1234
```

> 注意：在线地址无 `.html` 后缀，但浏览器通过 Content-Type 仍会按 HTML 渲染。

#### 2.7 第二步涉及文件变更

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `packages/shared/package.json` | 修改 | 添加 `./oss` export 入口 |
| `packages/shared/src/env/types.ts` | 修改 | 新增 `MIDSCENE_OSS_*` 环境变量常量 |
| `packages/core/src/report-generator.ts` | 修改 | `finalize()` 后触发 OSS 上传 |
| `packages/web-integration/src/playwright/reporter/index.ts` | 修改 | `onEnd()` 中触发 OSS 上传 |

#### 2.8 第二步完成标准

- [ ] `MIDSCENE_OSS_ENABLE=true` + `MIDSCENE_OSS_TOKEN_URL=...` 配置后，执行 case 自动上传报告
- [ ] 控制台在本地报告路径后追加输出在线报告地址
- [ ] `MIDSCENE_OSS_ENABLE` 未设置或为 `false` 时，行为与现有完全一致（无任何副作用）
- [ ] 上传失败时不影响测试执行和本地报告生成

---

## OSS 上传路径结构

```
xrayandroid/
  report/                                     ← MIDSCENE_OSS_PREFIX（默认）
    web-2025-04-13_10-30-00-abcd1234             ← 无 .html 后缀（默认域名）
    playwright-merged-2025-04-13_11-00-00-efgh5678
    ...
```

> 使用自定义域名（`MIDSCENE_OSS_DOMAIN`）时保留 `.html` 后缀。

## HTML 预览支持

### 问题背景

2017-10-01 之后创建的 Bucket，使用 OSS **默认域名**访问以 `.htm`/`.html` 结尾的文件时，OSS 会自动添加以下响应头，导致浏览器强制下载：
- `x-oss-force-download: true`
- `Content-Disposition: attachment`

此外，STS 临时凭证的 Session Policy 仅授予 `PutObject` 权限，不包含 `GetObject`，因此签名 URL（signatureUrl）方案也不可行（会返回 `AccessDenied`）。

### 最终方案：去掉 .html 后缀

上传时将 OSS 路径中的 `.html` 后缀去掉，同时保持 `Content-Type: text/html; charset=utf-8`：

- **OSS 强制下载策略**检查的是路径是否以 `.htm`/`.html` 结尾，去掉后缀即可绕过
- **浏览器**通过 `Content-Type` 响应头判断文件类型，仍会按 HTML 渲染
- **Bucket 公开可读**，无需认证即可访问，URL 永久有效

| 域名类型 | OSS 路径 | 说明 |
|----------|---------|------|
| 默认域名 | `report/xxx` | 去掉 `.html` 后缀，绕过强制下载 |
| 自定义域名 | `report/xxx.html` | 保留原始后缀，自定义域名无限制 |

### 备选方案对比（已排除）

| 方案 | 原因 |
|------|------|
| 签名 URL（signatureUrl） | STS 凭证无 `GetObject` 权限，签名 URL 返回 `AccessDenied` |
| 自定义域名 | 需要额外 DNS 配置，作为可选优化保留（`MIDSCENE_OSS_DOMAIN`） |
| 修改 Content-Type 为 text/plain | 浏览器会显示 HTML 源码而非渲染页面 |

## 报告体积优化

### 问题背景

内联模式（single-html）的报告文件可能非常大。以 Android Demo 为例，一份典型报告体积约 **136 MB**，组成如下：

| 组成部分 | 体积 | 占比 | 说明 |
|---------|------|------|------|
| 模板 JS（React 查看器） | ~31 MB | 23% | 固定开销，每份报告相同 |
| 截图（base64 PNG） | ~32 MB | 24% | 16 张 PNG 截图，平均 2 MB/张 |
| JSON Dump 数据 | ~70 MB | 52% | 68 份重复的 Dump，仅最后一份有效 |

上传到 OSS 前，需要尽量压缩体积以减少传输时间和存储成本。

### 优化一：Dump 去重

#### 背景

每次 `onExecutionUpdate()` 调用时，`ReportGenerator` 会向 HTML 追加一个包含完整任务数据的 `<script type="midscene_web_dump">` 标签。前端查看器只使用最后一份 Dump 数据，之前的所有 Dump 是冗余的。

#### 方案

在 `finalize()` 中，解析 HTML 找出所有 Dump 标签，只保留最后一个，删除前面的冗余标签。

#### 实现要点

使用**前向标签对解析器**遍历 `<script>...</script>` 对：

```typescript
private deduplicateDumps(): void {
  const content = readFileSync(this.reportPath, 'utf-8');
  const dumpType = 'midscene_web_dump';
  const positions: Array<{ start: number; end: number }> = [];

  let pos = 0;
  while (pos < content.length) {
    const scriptStart = content.indexOf('<script', pos);
    if (scriptStart === -1) break;
    const openEnd = content.indexOf('>', scriptStart);
    if (openEnd === -1) break;
    const openTag = content.slice(scriptStart, openEnd + 1);
    const closeIdx = content.indexOf('</script>', openEnd);
    if (closeIdx === -1) break;
    const tagEnd = closeIdx + '</script>'.length;

    if (openTag.includes(`type="${dumpType}"`)) {
      positions.push({ start: scriptStart, end: tagEnd });
    }
    pos = tagEnd;
  }

  if (positions.length <= 1) return;

  // 只保留最后一个 Dump 标签，删除前面的
  // ... 重建内容并写回 ...
}
```

**为什么不能用简单 `indexOf` 匹配 Dump 开始标签？**

`escapeContent()` 只转义 `</script` → `<\/script`，但不转义 `<script`。因此 Dump 的 JSON 内容中会包含 `<script type="midscene_web_dump"` 字面量。简单 `indexOf` 会匹配到 JSON 内容中的字符串，导致错误截断——具体表现为报告白屏（模板 JS 被误删）。

前向解析器利用 `</script>` 一定是真实闭合标签的特性（因为内容中的 `</script` 已被转义为 `<\/script`），逐对遍历 `<script>...</script>` 标签，正确识别真实的顶层标签。

#### 效果

| | 优化前 | 优化后 |
|--|--------|--------|
| Dump 数量 | 68 个 | 1 个 |
| Dump 体积 | ~70 MB | ~3 MB |
| **节省** | | **~67 MB** |

### 优化二：截图 JPEG 压缩

#### 背景

报告中的截图以 base64 PNG 格式内嵌在 `<script type="midscene-image">` 标签中。PNG 是无损格式，对 UI 截图来说体积偏大。

#### 方案

通过环境变量 `MIDSCENE_REPORT_JPEG_QUALITY` 配置 JPEG 压缩质量（1-100）。设置后，`finalize()` 会在 Dump 去重之后、OSS 上传之前，将所有 PNG 截图转为 JPEG。不设置则保持原始 PNG 不变。

#### 实现要点

```typescript
private async compressScreenshots(): Promise<void> {
  const qualityStr = process.env.MIDSCENE_REPORT_JPEG_QUALITY;
  if (!qualityStr) return;  // 未配置则跳过

  const quality = Number.parseInt(qualityStr, 10);
  if (Number.isNaN(quality) || quality < 1 || quality > 100) return;

  const { convertToJpegBase64 } = await import('@midscene/shared/img');
  // 使用前向标签对解析器找到所有 PNG 截图
  // 并行调用 Sharp（Node.js）或 Photon（WASM fallback）转换
  // 替换 data:image/png;base64,xxx → data:image/jpeg;base64,xxx
}
```

`convertToJpegBase64()` 优先使用 Sharp 库（`@midscene/shared` 已有依赖），性能更优；Sharp 不可用时回退到 Photon WASM 引擎。

#### 配置方式

```bash
# .env 文件（永久生效）
MIDSCENE_REPORT_JPEG_QUALITY=80

# 或命令行临时覆盖
MIDSCENE_REPORT_JPEG_QUALITY=60 npx tsx demo_android.ts
```

#### 效果（quality=80）

| | 优化前 | 优化后 |
|--|--------|--------|
| 截图格式 | PNG | JPEG (quality=80) |
| 截图体积 | ~32 MB (16 张，平均 2 MB/张) | ~8 MB (16 张，平均 504 KB/张) |
| **压缩比** | | **约 4:1** |

### 综合优化效果

以 Android Demo（16 张截图，68 次执行更新）为例：

| 组成部分 | 优化前 | 优化后 | 节省 |
|---------|--------|--------|------|
| Dump 数据 | 70 MB | 3 MB | -67 MB |
| 截图 | 32 MB | 8 MB | -24 MB |
| 模板 JS | 31 MB | 33 MB | 固定开销 |
| **总计** | **136 MB** | **44 MB** | **-92 MB (68%)** |

> 数据部分（Dump + 截图）从 102 MB 降至 11 MB，压缩 89%。剩余主要是模板 JS 固定开销（React 查看器应用），需通过构建优化进一步缩减。

### 涉及文件变更

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `packages/core/src/report-generator.ts` | 修改 | 新增 `deduplicateDumps()`、`compressScreenshots()` 方法 |
| `packages/shared/src/img/transform.ts` | 修改 | 新增 `convertToJpegBase64()` 函数 |
| `packages/shared/src/img/index.ts` | 修改 | 导出 `convertToJpegBase64` |
| `packages/shared/src/env/types.ts` | 修改 | 新增 `MIDSCENE_REPORT_JPEG_QUALITY` 环境变量常量 |

## 报告 UI 定制

### 品牌替换

将报告查看器的品牌标识从 Midscene 替换为飞碟报告：

| 元素 | 修改前 | 修改后 |
|------|--------|--------|
| 左上角图标 | Midscene 带文字 logo（深浅主题两版） | 飞碟图标 + "飞碟报告" 文字 |
| 图标跳转链接 | `https://midscenejs.com/` | `https://fl-auto-test.fc.alibaba-inc.com/` |
| 浏览器标签标题 | `Report - Midscene.js` | `飞碟报告` |
| 浏览器 favicon | Midscene favicon | 飞碟图标 |
| "Learn more" 链接 | `https://midscenejs.com/api#agentlogscreenshot` | `https://fl-auto-test.fc.alibaba-inc.com/` |

### 移除 Playground 入口

报告详情面板中的 "Open in Playground" 按钮已移除。该按钮在静态报告场景下会因无法获取 UI 上下文而报错（`Failed to get UI context`），且对报告查看无实际价值。

### 涉及文件变更

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `packages/visualizer/src/component/logo/index.tsx` | 修改 | 替换图标 URL、跳转链接、添加 "飞碟报告" 文字 |
| `packages/visualizer/src/component/logo/index.less` | 修改 | 图标 + 文字并排样式 |
| `apps/report/template/index.html` | 修改 | 页面标题、favicon |
| `apps/report/src/components/sidebar/index.tsx` | 修改 | "Learn more" 链接跳转目标 |
| `apps/report/src/components/detail-panel/index.tsx` | 修改 | 移除 OpenInPlayground 组件引用 |
| `apps/report/src/components/open-in-playground/index.tsx` | 修改 | 修复 Drawer 未打开时误触发 UI 上下文加载的 Bug |

## 依赖变更

在 `packages/shared/package.json` 中新增（第一步即安装）：

```json
{
  "dependencies": {
    "ali-oss": "^6.x"
  },
  "devDependencies": {
    "@types/ali-oss": "^6.x"
  }
}
```

> `ali-oss` 包体约 1MB+。第二步集成时通过**动态 import** 按需加载，不影响不使用 OSS 功能的用户。

## 设计考量

### 为什么分两步实现？

- **隔离风险**：第一步仅新增文件，不修改 Midscene 任何现有代码，即使 OSS 模块有 bug 也不会影响 Midscene
- **快速验证**：先用独立 demo 跑通全链路（STS 凭证 → 上传 → 预览），确认无误后再嵌入
- **方便调试**：如果上传或预览有问题，可以直接用 demo 脚本复现，不需要跑完整测试流程

### 为什么选择在 `finalize()` 中上传而不是在写入时上传？

- 报告在写入过程中会被多次追加内容（截图、dump 数据），只有 `finalize()` 后才是完整的
- 避免重复上传中间状态的文件

### 为什么使用动态 import？

- `ali-oss` 是一个较大的依赖包，大部分用户不需要 OSS 功能
- 动态 import 确保不影响启动性能和包体大小

### 为什么每次上传前重新获取 STS 凭证？

- STS 临时凭证有有效期（通常 1~12 小时）
- 每次 `finalize()` 时重新调用 Token Service 获取凭证，确保不会因 Token 过期导致上传失败

### 上传失败的处理策略

- 上传失败**不应影响**主流程（测试执行和本地报告生成正常进行）
- 所有集成点均使用 try-catch 保护，失败时输出警告信息
- 不会抛出异常中断测试流程

## 用户使用方式

在 `.env` 文件或系统环境变量中配置：

```bash
# 启用 OSS 上传
MIDSCENE_OSS_ENABLE=true

# STS Token 服务地址（必填）
MIDSCENE_OSS_TOKEN_URL=https://ufo2.alitrip.com/api/multiappAutoJob/getOssToken.json

# Token 响应中凭证对象的路径（默认 resultObj，适配 qlive 接口可设为 data）
# MIDSCENE_OSS_TOKEN_RESPONSE_PATH=resultObj

# 可选覆盖
# MIDSCENE_OSS_REGION=oss-cn-beijing
# MIDSCENE_OSS_BUCKET=xrayandroid
# MIDSCENE_OSS_PREFIX=report/
# MIDSCENE_OSS_DOMAIN=https://your-custom-domain.com

# 报告体积优化：截图 JPEG 压缩（可选，1-100，推荐 80）
MIDSCENE_REPORT_JPEG_QUALITY=80
```

执行测试后自动上传并输出在线链接：

```bash
npx midscene run ./demo_web.ts

# 输出：
# report finalized: /path/to/local/report.html
# report optimized: removed 55 redundant dumps, saved 41.4 MB
# screenshots compressed: 14 PNG → JPEG (quality=80), saved 19.2 MB
# online report: https://xrayandroid.oss-cn-beijing.aliyuncs.com/report/report
```

## 风险与注意事项

1. **Token Service 可用性**：依赖内部 Token Service 可达。如果获取失败，静默跳过上传，不影响主流程
2. **STS Token 过期**：方案中每次上传前重新获取凭证，可自然规避过期问题
3. **STS 权限范围**：当前 STS 凭证仅有 `PutObject` 权限，无 `GetObject` 权限。因此不能使用签名 URL，需依赖 Bucket 公开可读 + 去掉 `.html` 后缀的方式实现预览
4. **费用**：每次上传会产生 OSS 存储和请求费用，建议设置生命周期规则自动清理过期报告
5. **网络依赖**：上传需要网络连接，在离线环境中会静默失败
6. **文件大小**：内联模式的 HTML 文件可能因 base64 截图而较大。通过 Dump 去重（默认开启）和截图 JPEG 压缩（`MIDSCENE_REPORT_JPEG_QUALITY`）可将典型报告从 ~136 MB 降至 ~44 MB，但上传时间仍取决于网络带宽
7. **URL 无后缀**：使用默认域名时在线地址无 `.html` 后缀，不影响浏览器渲染，但转发分享时需注意保留完整 URL
