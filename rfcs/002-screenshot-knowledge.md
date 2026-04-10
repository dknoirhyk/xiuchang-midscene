# RFC: Screenshot Knowledge — 让 Midscene 在 AI Planning 中注入页面标注截图

## 背景

RFC 001 实现了文字知识库注入（`setAIActContext`），解决了 AI 不理解业务术语的问题。
但仅靠文字难以描述页面布局和元素位置关系，AI 在复杂页面仍容易产生幻觉。

本 RFC 在 RFC 001 基础上，新增**标注截图知识库**支持：
- 在每轮 AI planning 时，额外注入当前页面对应的标注截图
- 标注图帮助 AI「认识」页面结构，当前截图帮助 AI「看到」实际状态，两者互补
- 采用「预测优先 + 冷启动默认页」策略：模型预测下一页面以提前加载标注图；第一轮使用知识库配置的默认起始页标注图

---

## 现有流程 vs 改造后流程

**现有：**
```
截图 → AI planning（文字知识 + 当前截图）→ 执行操作 → 循环
```

**改造后：**
```
截图 → 选标注图 → AI planning（文字知识 + 标注图 + 当前截图）→ 执行操作 → 循环
```

「选标注图」是新增步骤，发生在每轮 planning 之前：
- **第一轮**：使用知识库配置的默认起始页（如 `home`）加载标注图
- **后续轮次**：根据上一轮 planning 预测的 `next_page` 字段决定加载哪张标注图

---

## 知识库目录结构

```
packages/android/src/app-knowledge/
├── index.ts                        # 知识库管理器（扩展，原有文件）
├── fliggy.ts                       # 飞猪文字知识（.ts 导出字符串，原有文件）
└── screenshots/
    └── fliggy/                     # 按 App 包名映射的目录名
        ├── home/                   # 首页
        │   └── home-page-annotated.jpg
        ├── search-default/         # 猪搜默认页
        │   └── search-default-annotated.jpg
        ├── search-sug/             # SUG联想词页
        │   └── search-sug-annotated.jpg
        ├── search-result/          # 搜索结果页（同一页面多种形态，最多保留 2 张）
        │   ├── search-result-annotated.jpg
        │   └── search-result-quickfilter-annotated.jpg
        └── .../                    # 后续按需补充
```

**目录规则：**
- 每个页面一个文件夹，文件夹名 = 页面标识符
- 同一页面的不同形态（如结果页的品专版、快筛版）放在同一文件夹下
- **每个文件夹最多保留 2 张图片**，超过时保留最具代表性的形态
- 文件夹内图片命名不限，查找时读取文件夹内所有 `.jpg` / `.jpeg` / `.png` 文件

页面标识符命名规范：与 `fliggy-app-guide` skill 中「页面命名规范」章节保持一致，不单独维护。

> **与 RFC 001 实现的差异说明**：RFC 001 方案描述用 `.md` 文件存储文字知识，实际实现采用了 `.ts` 文件导出字符串（`fliggy.ts`）。截图管理因为是图片文件，需使用文件系统读取，与文字知识的加载方式不同，这是设计如此。

截图文件需在 `package.json` 的 `files` 字段中包含，确保打包进 npm：
```json
{
  "files": ["dist", "src/app-knowledge/screenshots"]
}
```

---

## 改动一：`app-knowledge/index.ts` — 新增截图管理 + 页面配置

### 1.1 新增 App 配置类型

每个 App 的知识库除了文字知识外，新增截图相关配置：

```typescript
interface AppKnowledgeConfig {
  /** 文字知识内容 */
  knowledge: string;
  /** 截图目录名（对应 screenshots/ 下的子目录） */
  screenshotDirName: string;
  /** 默认起始页标识符，用于第一轮 planning 的冷启动 */
  defaultPage: string;
  /** 可用的页面标识符列表，动态传给模型而非硬编码在 system prompt 中 */
  pageIds: string[];
}
```

更新映射表结构：

```typescript
const packageConfigMap: Record<string, AppKnowledgeConfig> = {
  'com.taobao.trip': {
    knowledge: fliggyKnowledge,
    screenshotDirName: 'fliggy',
    defaultPage: 'home',
    pageIds: [
      'home', 'search-default', 'search-sug', 'search-result',
      'fliggy-qwen', 'ticket-detail', 'hotel-list', 'hotel-detail',
      'flight-list', 'flight-detail', 'ticket-order', 'hotel-order', 'flight-order',
    ],
  },
};
```

### 1.2 新增截图查询方法

```typescript
/**
 * 获取指定包名和页面的标注截图路径
 * 同一页面可能有多张图（不同形态），最多返回 MAX_SCREENSHOTS_PER_PAGE 张
 * @returns 截图路径数组，页面文件夹不存在或无图片则返回空数组
 */
const MAX_SCREENSHOTS_PER_PAGE = 2;

function getScreenshotsForPage(
  packageName: string,
  pageId: string,
): string[]
```

实现逻辑：
1. 根据包名查 `packageConfigMap`，获取 `screenshotDirName`
2. 拼接页面文件夹路径：`{__dirname}/screenshots/{screenshotDirName}/{pageId}/`
3. 检查文件夹是否存在，**不存在则返回空数组，不报错**
4. 读取文件夹内所有 `.jpg` / `.jpeg` / `.png` 文件，**无图片则返回空数组**
5. 返回前 `MAX_SCREENSHOTS_PER_PAGE` 张图片的完整路径数组

### 1.3 新增配置查询方法

```typescript
/** 获取 App 的默认起始页标识符，无配置返回 null */
function getDefaultPageForPackage(packageName: string): string | null

/** 获取 App 的可用页面标识符列表，无配置返回空数组 */
function getPageIdsForPackage(packageName: string): string[]
```

### 1.4 保持向后兼容

原有的 `getKnowledgeForPackage(packageName)` 保持不变，内部改为从 `packageConfigMap` 读取 `knowledge` 字段。

---

## 改动二：`ConversationHistory` — 维护 `nextPagePrediction` 状态

### 设计理由

`nextPagePrediction` 本质上是对话上下文的一部分（上一轮 AI 输出 → 下一轮输入），放在 `ConversationHistory` 中比放在 `PageAgent` 上更自然：
- 与 `subGoals`、`memories`、`historicalLogs` 同层管理
- 随 `reset()` 自动清零，无需额外重置逻辑
- planning 循环中直接通过 `conversationHistory` 访问，无需跨层传递

### 新增字段和方法

在 `packages/core/src/ai-model/conversation-history.ts` 中：

```typescript
export class ConversationHistory {
  // ... 现有字段
  private _nextPagePrediction: string | null = null;  // 新增

  /** 获取上一轮预测的下一页面 */
  get nextPagePrediction(): string | null {
    return this._nextPagePrediction;
  }

  /** 更新页面预测（planning 返回后调用） */
  setNextPagePrediction(pageId: string | null): void {
    this._nextPagePrediction = pageId;
  }

  reset() {
    // ... 现有重置逻辑
    this._nextPagePrediction = null;  // 新增
  }
}
```

---

## 改动三：`llm-planning.ts` — planning 输出增加 `next_page`，输入增加标注图

### 3.1 修改 `plan()` 函数参数

新增两个可选参数：

```typescript
export async function plan(
  userInstruction: string,
  opts: {
    // ... 现有参数
    referenceScreenshots?: Array<{ name: string; url: string }>;  // 标注图
    availablePageIds?: string[];  // 可用页面标识符列表
  }
): Promise<PlanningAIResponse>
```

### 3.2 标注图注入位置：紧贴当前截图之前

**设计理由**：当前消息结构是 `system → instruction（首轮）→ historyLog`。instruction 只在首轮出现，如果标注图固定跟在 instruction 后面，第二轮起标注图会远离当前截图。标注图应紧贴当前截图之前，让模型看到的顺序是「参考标注图 → 当前实际截图」，符合认知习惯。

在构建 `latestFeedbackMessage` 之前，如果有 `referenceScreenshots`，先插入标注图消息：

```typescript
// 在 latestFeedbackMessage 构建之前
if (opts.referenceScreenshots?.length) {
  const refMessage: ChatCompletionMessageParam = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `The following ${opts.referenceScreenshots.length > 1 ? `${opts.referenceScreenshots.length} images are` : 'image is'} annotated reference screenshot(s) for the expected current page. They show the page layout and element positions for reference only — they do NOT represent the current screen state. If multiple images are provided, they represent different states/variants of the same page.`,
      },
      ...opts.referenceScreenshots.map(img => ({
        type: 'image_url' as const,
        image_url: { url: img.url, detail: 'low' as const },  // 使用 low detail 控制 token 成本
      })),
    ],
  };
  conversationHistory.append(refMessage);
}

// 紧接着是 latestFeedbackMessage（包含当前截图，保持 detail: 'high'）
```

这样每轮消息序列末尾是：`... → 标注图(low) → 当前截图(high)`，模型先看参考再看实际。

### 3.3 `next_page` 指令通过 actionContext 动态注入

**设计理由**：页面标识符列表是 App 特有的，不应硬编码在 core 包的通用 system prompt 中。否则新增 App 时需要改 core 包。

不修改 `systemPromptToTaskPlanning`，改为在 `plan()` 中将 `next_page` 指令拼入 actionContext：

```typescript
// 构建 next_page 指令（仅当提供了 availablePageIds 时）
let enhancedActionContext = opts.actionContext || '';
if (opts.availablePageIds?.length) {
  const pageIdList = opts.availablePageIds.join(', ');
  enhancedActionContext += `\n<next_page_instruction>
After determining the next action, predict which page will be shown after this action completes.
Output the predicted page identifier in the <next_page> tag.
Available page identifiers: ${pageIdList}.
If you cannot predict, output <next_page>null</next_page>.

If a reference annotated screenshot is provided, it shows the expected layout of the current page.
If the current screenshot differs significantly from the reference (e.g., unexpected popup, wrong page, loading error), ignore the reference screenshot and judge based on the current screenshot and text knowledge. Correct your next_page prediction accordingly.
</next_page_instruction>`;
}
```

这样 `next_page` 指令随 `<high_priority_knowledge>` 一起注入，仅在有截图知识库配置的 App 上生效。

### 3.4 修改返回值解析

在 `parseXMLPlanningResponse` 中新增解析 `<next_page>` tag：

```typescript
// 现有返回类型 RawResponsePlanningAIResponse 新增字段
interface RawResponsePlanningAIResponse {
  // ... 现有字段
  nextPage?: string | null;  // 新增
}

// PlanningAIResponse 同步新增
interface PlanningAIResponse {
  // ... 现有字段
  nextPage?: string | null;  // 新增
}

// parseXMLPlanningResponse 中新增
const nextPage = extractXMLTag(xmlString, 'next_page');
return {
  // ... 现有字段
  nextPage: nextPage === 'null' ? null : (nextPage ?? null),
}
```

### 3.5 `plan()` 返回后更新 ConversationHistory

在 `plan()` 函数末尾（构建 `returnValue` 之后）：

```typescript
// 更新页面预测状态，供下一轮使用
conversationHistory.setNextPagePrediction(planFromAI.nextPage ?? null);
```

---

## 改动四：`packages/android/src/agent.ts` — 截图解析 + 知识库自动注入

### 设计理由

截图文件在 android 包中，解析逻辑应留在 android 层，不应让 core 包依赖 android 的文件系统。android agent 负责准备好 `referenceScreenshots` 数据，通过参数传给 core 的 `taskExecutor.action()`。

同时，知识库注入（文字 + 截图）应当**对所有调用路径自动生效**，不需要使用者手动调用。

### 4.1 知识库自动注入（`agentFromAdbDevice` + `detectAndLoadAppKnowledge`）

**问题背景**：知识库注入原来仅在 MCP/CLI tools 层（`AndroidMidsceneTools.ensureAgent`）中自动触发，通过 YAML 脚本（`midscene run script.yaml`）或直接脚本使用 `AndroidAgent` 时不会自动注入。

**解决方案**：将自动检测逻辑下沉到 `AndroidAgent` 本体和 `agentFromAdbDevice` 工厂函数中：

1. **`AndroidAgent.detectAndLoadAppKnowledge()`** — 新增公共方法：
   - 通过 ADB `dumpsys activity activities` 检测当前前台 App 包名
   - 调用 `loadAppKnowledge(packageName)` 注入文字知识和截图 provider
   - 内部有幂等保护（`lastKnowledgePackageName`），重复调用不会重复加载
   - `parseForegroundPackageName()` 从 `mcp-tools.ts` 移入 `agent.ts` 作为模块内函数

2. **`agentFromAdbDevice()`** — 工厂函数末尾自动调用：
   ```typescript
   const agent = new AndroidAgent(device, opts);
   await agent.detectAndLoadAppKnowledge();  // 自动注入
   return agent;
   ```

3. **`AndroidMidsceneTools.ensureAgent()`** — 简化：
   - 新建 agent 时不再手动调用检测（`agentFromAdbDevice` 已自动处理）
   - agent 已存在时仍调用 `agent.detectAndLoadAppKnowledge()` 刷新前台 App

**覆盖的调用路径**：

| 使用方式 | 入口 | 是否自动注入 |
|---|---|---|
| `npx midscene-android act "..."` | `cli.ts` → `ensureAgent()` → `agentFromAdbDevice()` | 自动注入 |
| `npx midscene run script.yaml`（YAML 中配置 android） | `create-yaml-player.ts` → `agentFromAdbDevice()` | 自动注入 |
| 脚本直接使用 `agentFromAdbDevice()` | `agentFromAdbDevice()` | 自动注入 |
| 脚本直接 `new AndroidAgent(device)` | 构造函数 | 需手动调用 `agent.detectAndLoadAppKnowledge()` 或 `agent.loadAppKnowledge(packageName)` |

> **设计决策**：不在构造函数中自动检测，因为构造函数是同步的，且构造时设备可能尚未连接。推荐统一使用 `agentFromAdbDevice()` 工厂函数。

### 4.2 截图解析方法

在 `AndroidAgent` 中：

```typescript
/**
 * 根据页面标识符解析标注截图为 base64 数据
 * @param pageId - 页面标识符
 * @param packageName - App 包名
 * @returns 标注图数组（最多 MAX_SCREENSHOTS_PER_PAGE 张），无匹配返回空数组
 */
private async resolveReferenceScreenshots(
  pageId: string | null,
  packageName: string,
): Promise<Array<{ name: string; url: string }>> {
  if (!pageId) return [];

  const screenshotPaths = getScreenshotsForPage(packageName, pageId);
  if (!screenshotPaths.length) return [];

  return Promise.all(
    screenshotPaths.map(async (p, i) => {
      const base64 = await fs.readFile(p, { encoding: 'base64' });
      const ext = path.extname(p).slice(1) || 'jpeg';
      return {
        name: `${pageId}-${i + 1}`,
        url: `data:image/${ext};base64,${base64}`,
      };
    })
  );
}
```

### 4.3 在 aiAct 调用前准备截图数据

override `PageAgent` 的 `aiAct` 方法（或在调用 `taskExecutor.action` 前的钩子中），准备好截图数据并传入：

```typescript
// 获取当前前台 App 包名（已有能力）
const packageName = this.lastKnowledgePackageName;

// 获取默认页或预测页的标注图
const pageId = conversationHistory.nextPagePrediction
  ?? getDefaultPageForPackage(packageName);
const referenceScreenshots = await this.resolveReferenceScreenshots(pageId, packageName);
const availablePageIds = getPageIdsForPackage(packageName);
```

---

## 改动五：`packages/core/src/agent/tasks.ts` — 透传截图参数

### 5.1 `action()` 和 `runAction()` 新增参数

```typescript
async action(
  // ... 现有参数
  referenceScreenshotProvider?: () => Promise<Array<{ name: string; url: string }>>,
  availablePageIds?: string[],
): Promise<...>
```

**设计说明**：使用 `referenceScreenshotProvider` 回调而非直接传数组，原因：
- planning 循环中每轮都需要重新解析标注图（因为 `nextPagePrediction` 每轮更新）
- 回调由 android agent 提供，内部可访问 `conversationHistory.nextPagePrediction` 和文件系统
- core 包不需要知道截图从哪来，只负责调用回调获取数据

### 5.2 planning 循环中调用

在 `runAction` 的 planning executor 中：

```typescript
// 每轮 planning 前，通过 provider 获取最新的标注图
const referenceScreenshots = referenceScreenshotProvider
  ? await referenceScreenshotProvider()
  : undefined;

planResult = await planImpl(param.userInstruction, {
  // ... 现有参数
  referenceScreenshots,      // 新增
  availablePageIds,          // 新增
});
```

### 5.3 持久化 `referenceScreenshots` 到 execution dump

**问题背景**：三条知识注入路径（文字知识 `aiActContext`、`next_page` 指令、标注截图 `referenceScreenshots`）中，只有文字知识通过 `param.aiActContext` 保存在 dump 中、在报告中可见。标注截图通过 `conversationHistory.append()` 注入到对话上下文，不会写入 execution dump，导致报告中无法确认标注图是否正确注入。

**解决方案**：在 planning 解析标注图后，将 `referenceScreenshots` 持久化到 `executorContext.task.param`：

```typescript
// tasks.ts — planning executor 中，获取标注图后
if (referenceScreenshots?.length) {
  (executorContext.task.param as any).referenceScreenshots = referenceScreenshots;
}
```

同步更新 `types.ts` 中的 `ExecutionTaskPlanningApply` 类型定义：

```typescript
export type ExecutionTaskPlanningApply = ExecutionTaskApply<
  'Planning',
  {
    userInstruction: string;
    aiActContext?: string;
    referenceScreenshots?: Array<{ name: string; url: string }>;  // 新增
  },
  PlanningAIResponse
>;
```

> **注意**：referenceScreenshots 中的 `url` 字段为完整的 base64 data URL（如 `data:image/jpg;base64,...`），单张图约 300~500KB。这会显著增大 dump JSON 和报告文件体积（每轮 planning 都会存储一份），后续可考虑引用化存储优化。

---

## Fallback 策略

| 场景 | 处理方式 |
|---|---|
| **第一轮，无预测** | 使用知识库配置的 `defaultPage`（如 `home`）加载标注图，而非裸判 |
| **第一轮，App 无知识库配置** | 不注入标注图，不注入 next_page 指令，纯文字模式 |
| 预测的页面文件夹不存在 | 返回空数组，只注入文字知识，静默跳过 |
| 页面文件夹存在但无图片 | 返回空数组，只注入文字知识，静默跳过 |
| 截图与标注图差异明显 | AI 在 thought 中自行识别并修正，`next_page` 输出修正值 |
| 模型不支持多模态 | planning 本身就需要截图，此场景不存在；若未来有纯文本模式，`referenceScreenshots` 传空即可 |
| 包名未在知识库映射表中 | 不注入标注图，不注入 next_page 指令 |
| 标注图超过 2 张 | `getScreenshotsForPage` 内部截断，最多返回 `MAX_SCREENSHOTS_PER_PAGE` 张 |

---

## Token 成本控制

| 措施 | 说明 |
|---|---|
| 标注图使用 `detail: 'low'` | 标注图是参考而非需要精确识别的当前状态，low detail 约 85 tokens/张 |
| 当前截图保持 `detail: 'high'` | 当前状态需要精确识别，不降级 |
| 每页最多 2 张标注图 | `MAX_SCREENSHOTS_PER_PAGE = 2`，控制在 `getScreenshotsForPage` 层 |
| 标注图预压缩 | 700×1544，每张约 300~400KB |
| `compressHistory` 已有机制 | 超过 50 条消息时自动压缩，标注图在压缩时会被替换为文本占位符 |

---

## 不需要改的

- `service-caller/index.ts` — 底层已支持 `image_url` 类型 content，不动
- `inspect.ts` — insight 类方法（aiQuery/aiAssert 等）本期不注入标注图，只改 planning
- `packages/ios/`、`packages/harmony/` — 本期只改 android
- `packages/core/src/ai-model/prompt/llm-planning.ts` — system prompt 不改，next_page 指令通过 actionContext 动态注入
- CLI 参数 — 不新增命令行参数，知识库路径硬编码在包内；知识库注入通过 `agentFromAdbDevice` 自动触发，所有使用此工厂函数的路径（CLI、YAML 脚本、直接脚本）均自动生效

---

## 改动六：`apps/report/` — 报告中展示知识库上下文和标注截图

### 设计理由

调试标注截图注入效果时，需要能在 HTML 报告中直接确认：
- 注入了哪些文字知识（`aiActContext`）
- 注入了哪些标注截图（`referenceScreenshots`）

actContext 原本就保存在 dump 的 `param.aiActContext` 中，但报告组件未展示。标注截图在改动 5.3 中新增了持久化。

### 6.1 报告组件变更

修改 `apps/report/src/components/detail-side/index.tsx`，在 Planning 类型任务的 MetaKV 面板中新增两个字段：

```typescript
// 提取数据
const aiActContextValue = (task as ExecutionTaskPlanningApply)?.param?.aiActContext;
const referenceScreenshotsValue = (task as ExecutionTaskPlanningApply)?.param
  ?.referenceScreenshots;
```

MetaKV `data` 数组中追加：

```typescript
// actContext 展示（文字知识原文）
...(aiActContextValue
  ? [{ key: 'act context', content: aiActContextValue }]
  : []),

// referenceScreenshots 展示（缩略图 + 名称标签）
...(referenceScreenshotsValue?.length
  ? [{
      key: 'reference screenshots',
      content: (
        <div>
          {referenceScreenshotsValue.map((img, idx) => (
            <div key={idx} style={{ marginBottom: '8px' }}>
              <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>
                {img.name}
              </div>
              <img
                src={img.url}
                alt={img.name}
                style={{ maxWidth: '200px', border: '1px solid #e8e8e8', borderRadius: '4px' }}
              />
            </div>
          ))}
        </div>
      ),
    }]
  : []),
```

### 6.2 展示效果

在报告的「Detail」侧边栏，展开 Planning 类型的 task 可以看到：

| 字段 | 内容 |
|---|---|
| `act context` | 文字知识原文（如飞猪 App 页面结构与术语） |
| `reference screenshots` | 每张标注图的缩略图（200px 宽），附名称标签（如 `home-1`、`search-result-1`） |

> **注意**：标注截图以 base64 data URL 内联在报告 HTML 中，会增大报告文件体积。这与改动 5.3 的体积增大问题一致，后续可统一优化为引用化存储。

---

## 构建注意事项

### 报告模板注入的构建链

报告模板（React 应用）构建后需注入 `packages/core/dist/` 中，涉及两个构建插件的协作：

```
apps/report 构建 → dist/index.html (完整 React 应用)
                  ↓
          copyReportTemplate 插件 → 注入到 packages/core/dist/{es,lib}/*.{mjs,js}
                                    (替换 REPLACE_ME_WITH_REPORT_HTML 占位符)

packages/core 构建 → injectReportTemplate 插件 → 读取 apps/report/dist/index.html
                                                   注入到自身 dist/ (备用路径)
```

**正确的构建命令**：
```bash
npx nx build report --skip-nx-cache
```

这会自动先构建 core 依赖，再构建 report，最后 report 的 `copyReportTemplate` 将最新模板注入 core dist（覆盖 core 自身 `injectReportTemplate` 注入的旧版本）。

**⚠️ 常见陷阱**：如果单独运行 `npx nx build core`，core 的 `injectReportTemplate` 会读取 `apps/report/dist/index.html`（可能是旧版本），注入旧模板。之后即使 report 构建更新了 `apps/report/dist/index.html`，core dist 中的模板仍然是旧的。必须重新运行 `npx nx build report` 让 `copyReportTemplate` 覆盖。

---

## 实施顺序

### Phase 1（验证，不改源码）
在测试脚本里手动构造多模态 context，把标注图 base64 手动传入，跑一个真实 task，验证标注图确实能提升页面理解准确率，再改源码。

重点验证：
- `detail: 'low'` 的标注图是否足够清晰让模型理解布局
- 多张标注图（同页不同形态）vs 单张标注图的效果差异
- 第一轮注入默认页标注图 vs 不注入的准确率对比

### Phase 2（核心改造）
按改动一至六实施，顺序：
1. `app-knowledge/index.ts` — 新增 `AppKnowledgeConfig`、截图查询、页面配置查询（无依赖，先改）
2. `conversation-history.ts` — 新增 `nextPagePrediction` 状态管理
3. `types.ts` — 新增 `nextPage` 字段到 `RawResponsePlanningAIResponse` 和 `PlanningAIResponse`；新增 `referenceScreenshots` 到 `ExecutionTaskPlanningApply`
4. `llm-planning.ts` — 新增 `next_page` 解析 + `referenceScreenshots` 注入 + `availablePageIds` 动态指令
5. `tasks.ts` — 新增 `referenceScreenshotProvider` 和 `availablePageIds` 参数透传 + `referenceScreenshots` 持久化到 dump
6. `packages/android/src/agent.ts` — 新增 `resolveReferenceScreenshots`、`detectAndLoadAppKnowledge`，接入 `taskExecutor.action`
7. `apps/report/src/components/detail-side/index.tsx` — 新增 `actContext` 和 `referenceScreenshots` 展示

### Phase 3（完善）
- 补全各页面标注图，复制进 `app-knowledge/screenshots/fliggy/` 对应子目录
- 截图打包进 npm（检查 `package.json` files 字段）
- 根据实际效果调整 `detail` 级别和 `MAX_SCREENSHOTS_PER_PAGE` 参数
- 补充 `aiAssert`/`aiQuery` 的标注图注入（如有需要）

---

## 补充说明

- 标注图来源：使用 `fliggy-screenshot-annotate` skill 生成的 `annotated/` 目录下的图，按页面标识符建子目录后复制进来
- 标注图尺寸：700×1544（预压缩尺寸），每张约 300~400KB，控制总体积在 3MB 以内
- `next_page` 字段对现有 planning 结构是向后兼容的追加，不影响已有逻辑
- `availablePageIds` 和 `referenceScreenshots` 均为可选参数，非 android 平台或无知识库配置时不传，零侵入
