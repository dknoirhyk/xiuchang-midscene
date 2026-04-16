# RFC 004: 知识库上云 — 本地读取改为 OSS 云端读取

## 背景与动机

上一版方案（外部 CLI 参数传入知识库）在截图知识库上存在问题：截图是在 planning 阶段根据 pageId 动态获取的，不适合一次性外部传入。

新方案：将知识库内容（文字 + 截图）整体上云到 OSS，读取时从 OSS HTTP 获取，保留动态按需加载的机制。

### 核心优势

- 知识库内容可独立于代码发布进行更新
- 无需 CLI 额外参数，自动从 OSS 读取
- 截图在 planning 阶段按 pageId 动态获取，不一次性加载全部
- 复用现有 OSS 基础设施（bucket、region、STS 凭证）

## OSS 目录结构

OSS 根目录 `app-knowledge/`，结构与本地 `packages/android/src/app-knowledge/` 一致：

```
app-knowledge/
  fliggy/
    manifest.json                          # 知识库元信息
    knowledge.txt                          # 文字知识内容
    screenshots/
      home/
        home-page-annotated.jpg
      search-default/
        search-default-annotated.jpg
      search-result/
        search-result-annotated.jpg
        search-result-quickfilter-annotated.jpg
      ...
```

### manifest.json

```json
{
  "defaultPage": "home",
  "pageIds": ["home", "search-default", "search-sug", "search-result", ...],
  "screenshots": {
    "home": ["home-page-annotated.jpg"],
    "search-default": ["search-default-annotated.jpg"],
    "search-result": ["search-result-annotated.jpg", "search-result-quickfilter-annotated.jpg"]
  }
}
```

manifest.json 的作用是消除对 OSS 目录列举 API 的依赖（ListObject 需要额外权限），通过 HTTP GET 即可获取完整文件清单。

## 实现方案

### 1. OSS 读取模块（`oss-reader.ts`）

**文件**: `packages/android/src/app-knowledge/oss-reader.ts`

| 函数 | 功能 | 缓存策略 |
|---|---|---|
| `fetchAppManifest(appDirName)` | 获取 manifest.json | 内存缓存 |
| `fetchTextKnowledge(appDirName)` | 获取 knowledge.txt | 内存缓存 |
| `fetchScreenshotAsBase64(appDirName, pageId, fileName)` | 获取截图并转 base64 data URL | 不缓存 |

**关键设计：**
- 使用 Node.js 内置 `fetch()`（Node 18+），无额外依赖
- 网络失败不抛错，返回 null 并打印 debug 日志
- URL 构建优先使用 `MIDSCENE_OSS_DOMAIN`，否则使用 `bucket.region.aliyuncs.com`

### 2. 知识库接口层改造（`index.ts`）

**文件**: `packages/android/src/app-knowledge/index.ts`

| 函数 | 改造前（本地 FS） | 改造后（OSS） |
|---|---|---|
| `getKnowledgeForPackage` | sync, 从常量读取 | async, `fetchTextKnowledge()` |
| `getScreenshotsForPage` | sync, `fs.readdirSync` + 返回文件路径 | async, manifest + `fetchScreenshotAsBase64()` → 返回 `{name, url}[]` |
| `getDefaultPageForPackage` | sync, 从配置读取 | async, manifest 获取 |
| `getPageIdsForPackage` | sync, 从配置读取 | async, manifest 获取 |

包名到 OSS 目录名的映射：
```typescript
const packageOssDirMap: Record<string, string> = {
  'com.taobao.trip': 'fliggy',
};
```

### 3. AndroidAgent 异步适配

**文件**: `packages/android/src/agent.ts`

- `loadAppKnowledge` 签名从 `void` 改为 `async ... Promise<void>`
- 内部调用全部加 `await`
- `referenceScreenshotProvider` 直接调用 `getScreenshotsForPage`（已返回 base64 data URL）
- 移除 `resolveReferenceScreenshots` 私有方法（不再需要本地文件读取和 `fs`/`path` 模块）
- `detectAndLoadAppKnowledge` 内部 `loadAppKnowledge` 调用加 `await`

### 4. 上传脚本

**文件**: `packages/android/scripts/upload-knowledge.ts`

```bash
npx tsx packages/android/scripts/upload-knowledge.ts
```

脚本逻辑：
1. 从 `fliggy.ts` 提取文字知识 → 上传为 `app-knowledge/fliggy/knowledge.txt`
2. 扫描 `screenshots/fliggy/` 目录 → 上传所有图片到对应 OSS 路径
3. 从本地目录结构生成 `manifest.json` 并上传
4. 复用 `@midscene/shared/oss` 的 `getOSSConfigFromEnv()` 获取 STS 凭证

## 数据流

```
AndroidAgent.detectAndLoadAppKnowledge()
    |
    v
loadAppKnowledge(packageName) [async]
    |
    +---> fetchTextKnowledge(ossDirName) ---HTTP GET---> OSS: app-knowledge/fliggy/knowledge.txt
    |         |
    |         v
    |     setAIActContext(text)
    |
    +---> fetchAppManifest(ossDirName) ---HTTP GET---> OSS: app-knowledge/fliggy/manifest.json
              |
              v
          set availablePageIds, referenceScreenshotProvider
              |
              v  (每轮 planning 时动态调用)
          referenceScreenshotProvider(pageId)
              |
              v
          fetchScreenshotAsBase64(ossDirName, pageId, fileName)
              |  ---HTTP GET---> OSS: app-knowledge/fliggy/screenshots/{pageId}/{file}
              v
          { name, url: "data:image/jpeg;base64,..." }
```

## 影响范围

| 包 | 文件 | 变更类型 |
|---|---|---|
| android | `app-knowledge/oss-reader.ts` | 新建 |
| android | `app-knowledge/index.ts` | 重写（sync→async, FS→OSS） |
| android | `agent.ts` | 改造（loadAppKnowledge async, 移除 resolveReferenceScreenshots） |
| android | `scripts/upload-knowledge.ts` | 新建 |
| shared | `oss/index.ts` | 新增 `createOSSClient()` 导出 |

## 环境变量

复用现有 OSS 环境变量，无需新增：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `MIDSCENE_OSS_DOMAIN` | 自定义域名（优先） | - |
| `MIDSCENE_OSS_BUCKET` | Bucket 名称 | `xrayandroid` |
| `MIDSCENE_OSS_REGION` | Region | `oss-cn-beijing` |

## 扩展新 App

1. 在 `screenshots/<app-name>/` 下按 pageId 创建目录并放入标注截图
2. 创建 `<app-name>.ts` 导出文字知识常量
3. 在 `index.ts` 的 `packageOssDirMap` 添加包名映射
4. 在 `upload-knowledge.ts` 的 `APP_ENTRIES` 添加配置
5. 执行上传脚本
