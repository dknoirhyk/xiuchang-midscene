# RFC: App Knowledge — 让 Midscene 在操作特定 App 时自动注入业务知识

## 背景

Midscene 通过截图 + AI 来决策 UI 操作，但 AI 模型对具体 App 的页面结构、术语、导航路径缺乏了解。比如操作飞猪 App 时，AI 不知道"底纹词"、"金刚词"、"猪搜"、"品专"这些业务概念，也不知道首页顶部导航栏各 Tab 的功能。

我们希望 Midscene 能在操作特定 App 时，自动将该 App 的业务知识注入给 AI，提升决策准确性。

## 核心思路

**扩展现有的 `aiActContext` 机制，使其覆盖所有 AI 方法**。目前 `Agent` 通过 `setAIActContext(text)` 注入上下文知识，最终被包裹在 `<high_priority_knowledge>` 标签中传给 AI，但该机制仅在 `aiAct` 中生效。`aiAssert`、`aiQuery`、`aiBoolean` 等 insight 类方法不会传递 `aiActContext`，这意味着脚本中调用 `aiAssert("搜索框显示了底纹词")` 时 AI 不认识"底纹词"这个术语。

因此需要两步：
1. **改 core 包**：让 insight 类方法也支持 `actionContext` 注入
2. **改 android 包**：加一层自动检测前台 App 并加载业务知识的逻辑

## 工作流程

```
任意 AI 方法（aiAct / aiAssert / aiQuery / aiBoolean 等）被调用
  → ADB 检测当前前台 App 包名（adb shell dumpsys activity activities | grep mResumedActivity）
  → 用包名查知识库映射
  → 命中则读取对应 .md 文件内容
  → 调用 agent.setAIActContext(知识文本)
  → 正常执行 AI 方法，AI 在决策时会看到这份业务知识
```

## 需要的改动

### 1. 新建 `packages/android/src/app-knowledge/` 目录

**`index.ts`** — 知识库管理器：
- 维护一个包名→知识文件的映射表
- 提供 `getKnowledgeForPackage(packageName: string): string | null` 方法
- 读取同目录下的 .md 文件并返回内容
- 初始映射：`com.taobao.trip` → `fliggy.md`

**`fliggy.md`** — 飞猪 App 业务知识，内容如下（直接用这份）：

```markdown
# 飞猪 App 页面结构与术语

## App 版本区分
- 手机上可能有两个"飞猪旅行" App：测试包和正式包
- 区分方式：测试包图标右上角有"测试版"标记，正式包没有

## 首页（即"推荐"页）
- 首页是所有操作的默认起点

### 顶部导航栏（从左到右）
- 飞猪千问：AI 助手对话页面（也叫"问一问"）
- 推荐：首页（默认停留页）
- [城市名]：基于定位显示的城市

### 搜索区域
- 搜索框：内有滚动词（称为"底纹词"），点击进入搜索默认页。这个搜索叫"飞猪搜索"（简称"猪搜"）
- 搜索按钮：搜索框右侧，点击用当前"底纹词"直接搜索
- 热词：搜索框下方的推荐关键词

### 类目入口（热词下方）
- 酒店、机票、火车票、汽车票、景点门票、旅游、用车、签证、邮轮、特价机票等

### 底部 Tab 导航栏
- 首页 | 消息 | 行程 | 我的

### 首页弹窗处理
冷启动时可能出现：
1. 全屏广告 — 点击右上角"跳过"或等待自动消失
2. 领券弹窗 — 点击 X 关闭

## 搜索默认页（从首页点击搜索框进入）
1. 搜索框：内有灰色"底纹词"，输入内容后消失
2. 金刚词：搜索框下方的推荐词，点击直接搜索
3. 搜索历史：之前搜索过的词
4. 榜单：搜索历史下方，可左右滑动

## SUG（联想词）
- 在搜索框输入过程中，下方动态显示的联想补全词
- 出现场景：默认页输入时、搜索结果页重新输入时

## 搜索结果页（结果页）
1. 顶部搜索框（左侧返回按钮，右侧"我的收藏"）
2. 品专（广告位，不一定每次出现）
3. 筛选条件
4. 商品卡片（商卡）：左上角标注类型（景点、酒店等），景点也叫 POI

## 飞猪千问（问一问）
- 入口：首页顶部导航栏最左侧
- 注意：飞猪千问 ≠ 飞猪搜索（猪搜）
- 千问是 AI 对话页面，猪搜是商品搜索结果页
- 页面布局：顶部（历史会话 / 新建会话），中间对话区域，底部输入框
```

### 2. 修改 `packages/core/src/agent/tasks.ts` — 让 insight 类方法支持 actionContext

**问题**：当前 `createTypeQueryExecution` 方法签名中没有 `actionContext` 参数，导致 `aiAssert`、`aiQuery`、`aiBoolean` 等方法调用时业务知识不会传递给 AI。

**改动**：
- `createTypeQueryExecution` 增加可选参数 `actionContext?: string`
- 内部将 `actionContext` 透传给 `createTypeQueryTask`
- `createTypeQueryTask` 将 `actionContext` 拼入 prompt（与 planning 中相同的 `<high_priority_knowledge>` 方式）

### 3. 修改 `packages/core/src/agent/agent.ts` — insight 方法传递 aiActContext

在以下方法调用 `createTypeQueryExecution` 时，追加传递 `this.aiActContext`：
- `aiQuery` — 用于提取页面信息，需要理解业务术语（如"金刚词"、"商卡"）
- `aiBoolean` — 用于判断页面状态，需要理解业务概念
- `aiAssert` — 用于断言验证，需要理解业务术语（如"底纹词"）
- `aiString` / `aiNumber` — 同理

### 4. 修改 `packages/android/src/mcp-tools.ts`

在 `act` handler 中，执行 act 逻辑之前：
1. 通过 ADB 获取当前前台 App 包名
2. 调用知识库管理器查询是否有匹配的知识
3. 如有，调用 `agent.setAIActContext(知识内容)` 注入

注意：如果前台 App 没变（和上次相同），不需要重复设置。

### 5. 修改 `packages/android/src/agent.ts`

暴露一个便捷方法 `loadAppKnowledge(packageName: string)`，内部：
1. 调用知识库管理器获取知识文本
2. 如有，调用 `this.setAIActContext(知识文本)`

这样 mcp-tools 和脚本都可以直接调 `agent.loadAppKnowledge(packageName)`。

## 不需要改的

- `packages/core/src/ai-model/` — 不动，`<high_priority_knowledge>` 的包裹逻辑已存在于 planning 层
- `packages/ios/`、`packages/harmony/` — 本次不涉及
- CLI 参数 — 不加自定义知识路径

## 补充说明

- `.md` 文件需要在构建时被包含到 npm 包中（检查 `package.json` 的 `files` 字段或 tsconfig）
- 获取前台 App 的 ADB 命令：`adb shell dumpsys activity activities | grep mResumedActivity`，从输出中解析包名
- `AndroidDevice` 已经有执行 ADB 命令的能力（见 `device.ts` 中的 shell 方法），直接复用
