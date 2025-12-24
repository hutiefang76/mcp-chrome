# MCP Tools 对比分析报告

## 概览

本文档对比分析 `mcp-tools.js`（Claude 官方实现）与当前项目的 MCP tools 实现。

### 工具数量统计

| 来源                | 工具数量 | 说明                          |
| ------------------- | -------- | ----------------------------- |
| mcp-tools.js        | 20       | Claude 官方浏览器扩展实现     |
| 项目 ListTools 暴露 | 27       | TOOL_SCHEMAS 中定义的工具     |
| 项目已实现未暴露    | 8        | 实现存在但未在 ListTools 返回 |
| **项目总计**        | **35**   | 实际可调用的工具              |

---

## 一、工具对照映射表

| mcp-tools.js                       | 项目工具                                                 | 功能匹配度     |
| ---------------------------------- | -------------------------------------------------------- | -------------- |
| `navigate`                         | `chrome_navigate` + `chrome_go_back_or_forward`          | 完全覆盖       |
| `computer`                         | `chrome_computer`                                        | 项目更强       |
| `read_page`                        | `chrome_read_page`                                       | 各有优势       |
| `form_input`                       | `chrome_fill_or_select`(未暴露) / `chrome_computer.fill` | 项目更强       |
| `get_page_text`                    | `chrome_get_web_content`                                 | 项目更强       |
| `read_console_messages`            | `chrome_console`                                         | 各有优势       |
| `read_network_requests`            | `chrome_network_capture_*` + `chrome_network_debugger_*` | 项目更强       |
| `computer.screenshot`              | `chrome_screenshot` + `chrome_computer.screenshot`       | 项目更强       |
| `javascript_tool`                  | `chrome_inject_script`                                   | mcp-tools 更强 |
| `resize_window`                    | `chrome_computer.resize_page`                            | 项目更强       |
| `tabs_context/tabs_create`         | `get_windows_and_tabs` + `chrome_switch_tab`             | 各有优势       |
| `find`                             | **无**                                                   | 项目缺失       |
| `upload_image`                     | `chrome_upload_file`(部分)                               | mcp-tools 更强 |
| `gif_creator`                      | **无**                                                   | 项目缺失       |
| `shortcuts_list/execute`           | **无**                                                   | 项目缺失       |
| `tabs_context_mcp/tabs_create_mcp` | **无**                                                   | 项目缺失       |
| `update_plan`                      | **无**                                                   | Claude 专用    |
| `turn_answer_start`                | **无**                                                   | Claude 专用    |

---

## 二、相同功能工具详细对比

### 1. Navigate（导航）

**工具对照**

- mcp-tools: `navigate` (`mcp-tools.js:1723`)
- 项目: `chrome_navigate` (`common.ts:23`) + `chrome_go_back_or_forward` (`common.ts:520`)

| 维度     | mcp-tools.js                                                        | 项目                            | 优胜                                                                           |
| -------- | ------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ | -------- |
| 功能覆盖 | 支持 `url="back                                                     | forward"`                       | 支持 `refresh/newWindow/width/height/background/tabId/windowId`，复用同URL tab | **项目** |
| 代码质量 | 单文件实现，可维护性差                                              | TS + 模块化，参数结构清晰       | **项目**                                                                       |
| 安全性   | `permissionManager` + `verifyUrlSecurity` + `DomainCategoryService` | 无权限校验                      | **mcp-tools**                                                                  |
| 易用性   | back/forward 写进 url 字符串                                        | back/forward 独立工具，布尔参数 | **项目**                                                                       |
| 性能     | 直接操作，开销小                                                    | `chrome.tabs.query` 可能较重    | mcp-tools                                                                      |

**结论**: 功能和易用性项目更好，但**安全性是 mcp-tools 的核心优势**。

---

### 2. Computer（鼠标键盘操作）

**工具对照**

- mcp-tools: `computer` (`mcp-tools.js:2854`)
- 项目: `chrome_computer` (`computer.ts:198`)

| 维度     | mcp-tools.js                                                   | 项目                                                         | 优胜          |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------ | ------------- |
| 功能覆盖 | `zoom`(区域截图)、`scroll_to`、click `modifiers`、key `repeat` | `fill_form` 批量填表、`wait` 等待文本、`selector/xpath` 支持 | **项目**      |
| 代码质量 | 单 switch 大块逻辑                                             | 复用 `clickTool/fillTool/keyboardTool`，CDPHelper 封装       | **项目**      |
| 安全性   | 按 action 映射权限 + 域名变更校验                              | 坐标防漂移检查（域名变化拒绝旧坐标）                         | **mcp-tools** |
| 易用性   | 坐标为数组，参数靠字符串约定                                   | `coordinates: {x,y}` + `ref` + `selector/xpath`              | **项目**      |
| 性能     | CDP-first，一致性强                                            | DOM/content-script 优先，失败 fallback CDP                   | **项目**      |

**mcp-tools 独有能力值得集成**:

- `zoom`: 区域截图（放大某区域）
- `scroll_to`: 按 ref 滚动到元素
- `modifiers`: 点击时支持修饰键
- key `repeat`: 按键重复

**结论**: 项目整体更好，但 mcp-tools 的 `zoom`、`scroll_to`、`modifiers` 功能值得集成。

---

### 3. Read Page（页面读取）

**工具对照**

- mcp-tools: `read_page` (`mcp-tools.js:3675`)
- 项目: `chrome_read_page` (`read-page.ts:14`)

| 维度     | mcp-tools.js                            | 项目                                                | 优胜          |
| -------- | --------------------------------------- | --------------------------------------------------- | ------------- |
| 功能覆盖 | 支持 `depth` 和 `ref_id` 聚焦           | 返回结构化 JSON + `markedElements`，稀疏时 fallback | **各有优势**  |
| 代码质量 | 输出为大文本块                          | 输出结构化 + tips + marker 融合                     | **项目**      |
| 安全性   | READ_PAGE_CONTENT 权限 + tab group 限定 | 注入 allFrames，无权限控制                          | **mcp-tools** |
| 易用性   | depth/ref_id 控制输出规模               | JSON + tips + markedElements 适合自动决策           | **项目**      |

**商业级水准审查结果**：

当前实现**未达到商业级水准**，主要问题：

1. **输出结构不一致**：
   - 正常路径返回 `{pageContent, ...}`
   - fallback 返回 `{elements: [...], ...}`
   - 商业级应保持输出 shape 稳定

2. **缺少可控性**：
   - 不支持 `depth` 控制树深度
   - 不支持 `ref_id` 聚焦到特定节点

3. **可观测性不足**：
   - `stats`（durationMs/processed/included）已生成但未透出

4. **代码质量问题**：
   - `accessibility-tree-helper.js` 是多职责脚本（~1600行），维护成本高
   - 存在潜在 O(n²) 行为（遍历 `__claudeElementMap` 找匹配 ref）

**mcp-tools 独有能力值得集成**:

- `depth`: 控制树的深度
- `ref_id`: 聚焦到特定节点子树

**结论**: 项目结构化输出更好，需要提升到商业级（支持 depth/ref_id、stats 透出、输出结构统一）。

---

### 4. Form Input（表单填写）

**工具对照**

- mcp-tools: `form_input` (`mcp-tools.js:3803`)
- 项目: `chrome_fill_or_select` (未暴露) + `chrome_computer.fill/fill_form`

| 维度     | mcp-tools.js                     | 项目                                               | 优胜          |
| -------- | -------------------------------- | -------------------------------------------------- | ------------- |
| 功能覆盖 | checkbox/radio/range/select/text | 相同 + `selectorType='xpath'` + `fill_form` 批处理 | **项目**      |
| 代码质量 | 单文件完整                       | 工具类 + helper 脚本分离                           | **项目**      |
| 安全性   | 权限检查(TYPE) + 域名变更校验    | 无权限控制                                         | **mcp-tools** |
| 易用性   | ref/value                        | selector/xpath + 批处理                            | **项目**      |

**注意**: `chrome_fill_or_select` 未暴露在 TOOL_SCHEMAS，建议考虑暴露。

---

### 5. Get Page Text（内容提取）

**工具对照**

- mcp-tools: `get_page_text` (`mcp-tools.js:4052`)
- 项目: `chrome_get_web_content` (`web-fetcher.ts:16`)

| 维度     | mcp-tools.js                  | 项目                                             | 优胜          |
| -------- | ----------------------------- | ------------------------------------------------ | ------------- |
| 功能覆盖 | 基于选择器 + textContent 清洗 | `textContent/htmlContent/selector` + Readability | **项目**      |
| 代码质量 | 简单实现                      | 含 Readability 级别抽取                          | **项目**      |
| 安全性   | READ_PAGE_CONTENT 权限检查    | 无权限控制                                       | **mcp-tools** |
| 易用性   | 返回拼接字符串                | 结构化 JSON                                      | **项目**      |

**结论**: 项目明显更好。

---

### 6. Console（控制台日志）

**工具对照**

- mcp-tools: `read_console_messages` (`mcp-tools.js:4839`)
- 项目: `chrome_console` (`console.ts:58`)

| 维度     | mcp-tools.js                                | 项目                   | 优胜          |
| -------- | ------------------------------------------- | ---------------------- | ------------- |
| 功能覆盖 | 持续缓冲 + `pattern/onlyErrors/clear/limit` | 一次性快照（~2s 窗口） | **mcp-tools** |
| 安全性   | READ_CONSOLE_MESSAGES 权限检查              | 无权限控制             | **mcp-tools** |
| 易用性   | 格式化文本 + pattern 过滤                   | 结构化 JSON            | **项目**      |
| 性能     | 缓存最多 1e4 条/Tab，内存占用高             | 快照式，更轻量         | **项目**      |

**mcp-tools 独有能力值得集成**:

- 持续缓冲模式（可选）
- `pattern` 正则过滤
- `clear` 清空缓冲

**结论**: 两者定位不同，建议项目增加可选的持续缓冲模式。

---

### 7. Network（网络请求）

**工具对照**

- mcp-tools: `read_network_requests` (`mcp-tools.js:4986`)
- 项目: `chrome_network_capture_start/stop` + `chrome_network_debugger_start/stop`

| 维度     | mcp-tools.js                   | 项目                                              | 优胜          |
| -------- | ------------------------------ | ------------------------------------------------- | ------------- |
| 功能覆盖 | 只记录 url/method/status       | start/stop 模式、过滤静态/广告、responseBody 支持 | **项目**      |
| 安全性   | READ_NETWORK_REQUESTS 权限检查 | 降噪过滤为主                                      | **mcp-tools** |
| 易用性   | 直接 read                      | 需要 start/stop 工作流                            | **mcp-tools** |

**当前项目两个版本对比**：

| 版本       | API                 | 优势                              | 劣势                      |
| ---------- | ------------------- | --------------------------------- | ------------------------- |
| webRequest | `chrome.webRequest` | 不占 debugger，不与 DevTools 冲突 | **无法获取 responseBody** |
| Debugger   | CDP `Network.*`     | 能获取 responseBody（1MB 上限）   | DevTools 冲突时失败       |

**代码质量问题**：

- 广告域名列表不一致（webRequest 用共享常量，Debugger 硬编码）
- 返回数据结构差异大
- 大量重复代码（stop 逻辑、common headers 提取）

**结论**: 建议整合为统一接口，通过参数控制是否需要 responseBody。

---

### 8. Screenshot（截图）

**工具对照**

- mcp-tools: `computer.screenshot/zoom` (`mcp-tools.js:3637`, `mcp-tools.js:3274`)
- 项目: `chrome_screenshot` + `chrome_computer.screenshot`

| 维度       | mcp-tools.js                                | 项目                                             | 优胜          |
| ---------- | ------------------------------------------- | ------------------------------------------------ | ------------- |
| 功能覆盖   | viewport 截图 + `zoom` 区域截图 + `imageId` | fullPage stitch、元素截图、base64 压缩、下载保存 | **项目**      |
| 安全性     | 特殊页面限制 + 域名校验                     | 禁止 `chrome://` 页截图                          | 相当          |
| 配套工作流 | `imageId` → `upload_image`/`gif_creator`    | 无 imageId 桥接                                  | **mcp-tools** |

**mcp-tools 独有能力值得集成**:

- `zoom`: 区域放大截图

**关于 imageId**：mcp-tools 的 imageId 是从会话消息历史中引用图片 base64，**决策不采用此机制**（增加复杂度但收益有限）。

---

### 9. JavaScript 执行

**工具对照**

- mcp-tools: `javascript_tool` (`mcp-tools.js:5624`)
- 项目: `chrome_inject_script` (`inject-script.ts:23`)

| 维度     | mcp-tools.js              | 项目                                               | 优胜          |
| -------- | ------------------------- | -------------------------------------------------- | ------------- |
| 功能覆盖 | 执行并返回结果 + 输出脱敏 | 注入脚本但只返回 `{injected:true}`，需配合事件通信 | **mcp-tools** |
| 安全性   | 权限检查 + 输出脱敏       | `new Function(code)()` 风险更高                    | **mcp-tools** |
| 易用性   | 直接执行取值              | 需要注入后再触发事件                               | **mcp-tools** |

**当前事件通信机制的问题**：

- 注入脚本只返回 `{injected: true}`，不返回执行结果
- 需要额外调用 `send_command` 触发事件
- ISOLATED → MAIN world 的 postMessage 桥接增加复杂度

**改造方案**：使用 CDP `Runtime.evaluate` 直接执行并返回值，更可靠。

**结论**: 需要改造为 `javascript_tool`，实现执行并返回值 + 输出脱敏。

---

### 10. Tabs（标签页管理）

**工具对照**

- mcp-tools: `tabs_context/tabs_create/tabs_context_mcp/tabs_create_mcp`
- 项目: `get_windows_and_tabs` + `chrome_switch_tab` + `chrome_close_tabs`

| 维度     | mcp-tools.js                          | 项目                  | 优胜          |
| -------- | ------------------------------------- | --------------------- | ------------- |
| 功能覆盖 | MCP 会话隔离 tab group + 创建空白 tab | 全局枚举所有窗口/标签 | **各有优势**  |
| 安全性   | tab group 隔离减少误操作              | 全局能力，风险面大    | **mcp-tools** |
| 易用性   | 需遵循"先 context 再操作"流程         | 一次拿全量信息        | **项目**      |

**mcp-tools 独有能力值得集成**:

- `tabs_create`: 创建空白 tab
- MCP tab group 隔离概念（降低误操作风险）

---

## 三、mcp-tools.js 独有工具分析

以下工具在项目中完全没有对应实现：

### 1. `find` - 自然语言找元素 ⭐⭐⭐

**实现位置**: `mcp-tools.js:4210`

**工作原理**:

1. 注入执行 `window.__generateAccessibilityTree("all")` 获取可访问性树
2. 通过 `context.createAnthropicMessage` 调用 LLM (`modelClass:"small_fast"`, `maxTokens:800`)
3. 将 `searchQuery + pageContent` 拼进 prompt
4. 解析返回格式（FOUND/SHOWING/ref|...），最多返回 20 条

**价值**:

- 大幅降低"写 selector/ref"的门槛
- 把"从 a11y tree 里挑元素"做成专用子任务
- 减少主模型上下文负担

**风险**:

- 额外一次模型调用成本
- prompt 注入风险来自页面内容
- 解析对格式敏感

**集成建议**: ⭐⭐⭐ **高优先级**，非常实用的能力

---

### 2. `gif_creator` - GIF 录制 ⭐⭐⭐

**实现位置**: `mcp-tools.js:5243`

**工作原理**:

1. `GifRecorder` 按 tab group 存 frames，最多 50 帧
2. 在 `computer/navigate` 执行成功后自动截图
3. 导出时通过 `chrome.offscreen.createDocument` 生成 GIF
4. 支持下载或拖拽上传到页面

**价值**:

- 可审计的自动化回放
- bug 复现素材
- 演示/可观测性

**GIF 编码库推荐**：

- `gif.js`：成熟、支持 worker（mcp-tools 大概率使用）
- `gifenc`：更轻量，适合简单场景

**项目已有基础**：

- offscreen 基建已存在（`offscreen-manager.ts`）
- 截图能力已完善

**集成建议**: ⭐⭐⭐ **高优先级**，完全集成

---

### 3. `shortcuts_list/shortcuts_execute` - 工作流体系 ⭐⭐

**实现位置**: `mcp-tools.js:5976`, `mcp-tools.js:6015`

**工作原理**:

1. 列表从 `PermissionManager.getAllPrompts()` 获取 prompt registry
2. 执行时构造 `[[shortcut:<id>:<taskName>]]`，通过 sidepanel popup 执行

**价值**:

- 把复杂任务封装成高层能力复用
- 适合产品化

**安全注意**:

- promptData 带 `skipPermissions`，必须纳入权限域

**集成建议**: ⭐⭐ **中优先级**，需要配套权限体系

---

### 4. `tabs_context_mcp/tabs_create_mcp` - MCP 会话隔离 ⭐⭐

**实现位置**: `mcp-tools.js:5874`, `mcp-tools.js:5922`

**价值**:

- MCP 会话级 tab group 隔离与管理
- 显著降低误操作用户真实标签页的风险

**集成建议**: ⭐⭐ **中优先级**，需要架构调整

---

### 5. `update_plan/turn_answer_start` - Claude 专用交互 ⭐

**实现位置**: `mcp-tools.js:4496`, `mcp-tools.js:5609`

**说明**: Claude 客户端专用的交互/权限流程工具，对通用 MCP server 不一定适配。

**集成建议**: ⭐ **低优先级**，除非需要类似的计划审批流程

---

## 四、mcp-tools.js 权限模型分析

> **决策**: 权限模型先不集成

### 核心组件（供参考）

#### 1. `verifyUrlSecurity` - 域漂移防护

**位置**: `mcp-tools.js:353`

**原理**:

- 对比 `originalUrl` 与当前 `chrome.tabs.get(tabId).url` 的 `hostname`
- 不同则返回错误

**覆盖的高风险动作**:

- click (CDP 点击前)
- type
- form_input
- javascript_tool
- upload_image
- gif_creator export

#### 2. `DomainCategoryService` - 域名风险分类

**位置**: `mcp-tools.js:371-421`

**注意**: 会把访问域名发给第三方服务，不适合开源项目直接使用

#### 3. `permissionManager` - 可交互授权层

**主要接口**（从调用点反推）:

- `checkPermission(url, toolUseId)` → `{ allowed, needsPrompt }`
- `checkDomainTransition(oldDomain, newDomain)`
- `setForcePrompt(boolean)`

---

## 五、项目未暴露工具分析

### 未暴露原因分析

| 工具                                    | 状态        | 原因分析                        |
| --------------------------------------- | ----------- | ------------------------------- |
| `record_replay_flow_run/list_published` | Schema 注释 | 产品功能/稳定性/权限边界未定    |
| `chrome_userscript`                     | Schema 注释 | 持久化+跨站，风险极高           |
| `search_tabs_content`                   | Schema 注释 | 性能/隐私/初始化成本尚未产品化  |
| `chrome_click_element`                  | 无 Schema   | 作为 `chrome_computer` 内部组件 |
| `chrome_fill_or_select`                 | 无 Schema   | 作为 `chrome_computer` 内部组件 |
| `chrome_keyboard`                       | 无 Schema   | 作为 `chrome_computer` 内部组件 |
| `chrome_get_interactive_elements`       | 无 Schema   | 实验/半退役状态                 |

### 暴露建议

| 工具                                           | 建议              | 理由                                    |
| ---------------------------------------------- | ----------------- | --------------------------------------- |
| `chrome_userscript`                            | 继续不暴露        | 必须先补齐权限体系                      |
| `record_replay_*`                              | 继续不暴露        | 需要权限模型配套                        |
| `search_tabs_content`                          | 可选/feature-flag | 高级用户显式开启                        |
| `chrome_click_element/fill_or_select/keyboard` | **考虑暴露**      | 减少 chrome_computer 巨型 schema 的误用 |

---

## 六、集成任务计划

> 根据用户决策调整后的任务列表

### 高优先级 (P0)

#### 任务 1: 整合 `chrome_navigate` 和 `chrome_go_back_or_forward`

**目标**: 简化工具数量，统一导航能力

**决策**: 采用 `url="back"|"forward"` 方案

**涉及文件**:

- `app/chrome-extension/entrypoints/background/tools/browser/common.ts`
- `packages/shared/src/tools.ts`

**实现步骤**:

1. 在 `chrome_navigate` 中判断 `url` 参数是否为 `"back"` 或 `"forward"`
2. 如果是，调用 `chrome.tabs.goBack/goForward`
3. 复用现有的 `tabId/windowId/background` 参数逻辑
4. 更新 Schema 描述，说明 `url` 支持特殊值
5. 废弃 `chrome_go_back_or_forward` 工具

**预计改动**: ~50 行

---

#### 任务 2: `chrome_computer` 增强 - 集成 mcp-tools 独有能力

**目标**: 增强交互能力

**涉及文件**:

- `app/chrome-extension/entrypoints/background/tools/browser/computer.ts`
- `packages/shared/src/tools.ts`

**实现步骤**:

**2.1 `scroll_to` (低复杂度)**

- 项目已有 `focusByRef` 实现（会 `scrollIntoView`）
- 只需新增 `action='scroll_to'` 并调用该消息

**2.2 `modifiers` (低复杂度)**

- 项目已有 `modifiers` 参数透传到 `click-helper.js`
- 只需暴露到 computer schema：`modifiers?: {altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean}`

**2.3 key `repeat` (低复杂度)**

- 在现有 key 实现外加循环：`repeat?: number` (1-100)

**2.4 `zoom` (中复杂度)**

- 使用 CDP `Page.captureScreenshot` + `clip` 参数做区域截图
- 新增参数：`region?: {x: number, y: number, width: number, height: number}`

**预计改动**: ~150 行

---

#### 任务 3: `chrome_read_page` 提升到商业级

**目标**: 支持 depth/ref_id、stats 透出、输出结构统一

**决策**: 先不支持 iframe

**涉及文件**:

- `app/chrome-extension/entrypoints/background/tools/browser/read-page.ts`
- `app/chrome-extension/inject-scripts/accessibility-tree-helper.js`
- `packages/shared/src/tools.ts`

**实现步骤**:

**3.1 新增参数**

```typescript
depth?: number;     // 控制树的最大深度
refId?: string;     // 聚焦到特定节点的子树
```

**3.2 透出 stats**

- helper 已生成 `stats: {processed, included, durationMs}`
- 在返回结果中包含 stats

**3.3 统一输出结构**

- 正常路径和 fallback 路径返回相同的 shape
- 建议统一为：

```typescript
{
  pageContent: string;      // 树文本
  elements?: Element[];     // fallback 时的元素列表
  stats: Stats;
  markedElements?: ...;
  tips?: string[];
}
```

**预计改动**: ~200 行

---

#### 任务 4: `chrome_console` 增强

**目标**: 支持持续缓冲、正则过滤、清空

**涉及文件**:

- `app/chrome-extension/entrypoints/background/tools/browser/console.ts`
- `packages/shared/src/tools.ts`

**实现步骤**:

1. 新增 `ConsoleBuffer` 单例按 tabId 缓存日志
2. 新增参数：
   ```typescript
   mode?: 'snapshot' | 'buffer';  // 默认 snapshot
   pattern?: string;               // 正则过滤
   clear?: boolean;                // 清空缓冲
   onlyErrors?: boolean;           // 只返回错误
   limit?: number;                 // 条数限制
   ```
3. buffer 模式下不再"等 2s"，直接读 Map
4. 处理 tab 关闭清理、域名变化清理

**注意**: debugger 冲突时返回明确错误提示

**预计改动**: ~200 行

---

#### 任务 5: 整合 Network Capture 工具

**目标**: 统一接口，通过参数控制是否需要 responseBody

**决策**: 整合进同一个方法，通过 `needResponseBody` 参数控制

**涉及文件**:

- `app/chrome-extension/entrypoints/background/tools/browser/network-capture-web-request.ts`
- `app/chrome-extension/entrypoints/background/tools/browser/network-capture-debugger.ts`
- 新建 `app/chrome-extension/entrypoints/background/tools/browser/network-capture.ts`
- `packages/shared/src/tools.ts`

**实现步骤**:

1. 创建统一的 `chrome_network_capture_start/stop` 接口
2. 新增参数：`needResponseBody?: boolean` (默认 false)
3. `needResponseBody=false` 时使用 webRequest API
4. `needResponseBody=true` 时使用 Debugger API
5. 统一过滤配置到 `common/constants.ts`
6. 抽象公共逻辑（生命周期管理、common headers 提取）
7. 统一返回数据结构

**预计改动**: ~300 行（含重构）

---

#### 任务 6: 改造 `chrome_inject_script` 为 `javascript_tool`

**目标**: 实现执行并返回值 + 输出脱敏

**涉及文件**:

- `app/chrome-extension/entrypoints/background/tools/browser/inject-script.ts`
- `packages/shared/src/tools.ts`
- 新建 `app/chrome-extension/utils/output-sanitizer.ts`

**实现步骤**:

1. 使用 CDP `Runtime.evaluate` 直接执行
2. 实现输出脱敏（过滤 cookie/token/password 等）
3. 实现输出限长（如 50KB）
4. 处理异常（语法错误/运行时错误/超时）
5. debugger 冲突时提供 fallback（`chrome.scripting.executeScript`）

**实现参考**：

```typescript
async function executeJavaScript(tabId: number, code: string) {
  const result = await cdpSessionManager.sendCommand(tabId, 'Runtime.evaluate', {
    expression: `(async () => { ${code} })()`,
    awaitPromise: true,
    returnByValue: false,
    objectGroup: 'js-tool',
  });

  if (result.exceptionDetails) {
    return { error: formatException(result.exceptionDetails) };
  }

  const serialized = await serializeWithLimit(result.result, { maxDepth: 5, maxLength: 50000 });
  return { result: sanitize(serialized) };
}
```

**预计改动**: ~250 行

---

### 中优先级 (P1)

#### 任务 7: 实现 `gif_creator` GIF 录制

**目标**: 可审计的自动化回放

**涉及文件**:

- 新建 `app/chrome-extension/entrypoints/background/tools/browser/gif-recorder.ts`
- 新建 `app/chrome-extension/entrypoints/offscreen/gif-encoder.ts`
- `packages/shared/src/tools.ts`

**实现步骤**:

1. 创建 `GifRecorder` 类管理录制状态
   - 按 tabId 存储 frames（最多 50 帧）
   - 自动截帧钩子（在工具调度器中）
2. 实现 offscreen GIF 编码
   - 使用 `gif.js` 或 `gifenc`
   - 处理 worker CSP
3. 实现工具接口
   - `action: 'start' | 'stop' | 'export' | 'clear'`
   - 导出支持下载或返回 base64

**预计改动**: ~400 行

---

#### 任务 8: 实现 `find` 自然语言找元素

**目标**: 降低选择器门槛，提升易用性

**涉及文件**:

- 新建 `app/chrome-extension/entrypoints/background/tools/browser/find-element.ts`
- `packages/shared/src/tools.ts`
- `app/native-server/` - 需要 LLM 调用能力

**实现步骤**:

1. 复用 `chrome_read_page` 获取可访问性树
2. 设计 prompt 模板
3. 集成 LLM 调用（需要考虑调用方式：native-server 侧 or 扩展侧）
4. 解析返回结果
5. 添加到 TOOL_SCHEMAS

**预计改动**: ~300 行

**依赖**: 需要确定 LLM 调用架构

---

### 低优先级 (P2)

#### 任务 9: 暴露细粒度交互工具

**目标**: 减少 `chrome_computer` 的复杂度

**涉及文件**:

- `packages/shared/src/tools.ts`

**实现步骤**:

1. 为 `chrome_click_element` 添加 Schema
2. 为 `chrome_fill_or_select` 添加 Schema
3. 为 `chrome_keyboard` 添加 Schema
4. 更新工具描述，引导优先使用这些细粒度工具

---

## 七、总结

### mcp-tools.js 的核心优势

1. **完善的权限模型**: 多层防护设计，适合不完全可信的场景
2. **`find` 自然语言找元素**: 大幅降低使用门槛
3. **`imageId` 截图上传闭环**: 无文件系统依赖的完整工作流
4. **`javascript_tool` 执行返回值**: 调试能力更强
5. **`gif_creator`**: 可审计的自动化回放

### 项目的核心优势

1. **更强的功能覆盖**: 网络抓包、性能分析、批量填表等
2. **更好的代码质量**: TS 模块化、清晰的参数结构
3. **更强的易用性**: 结构化输出、selector/xpath 支持
4. **更好的工程实践**: DOM 优先、fallback CDP

### 集成优先级总结

| 优先级 | 任务                                                   | 预计收益 | 预计改动 |
| ------ | ------------------------------------------------------ | -------- | -------- |
| P0     | 整合 navigate + go_back_or_forward                     | 简化工具 | ~50 行   |
| P0     | chrome_computer 增强 (scroll_to/modifiers/repeat/zoom) | 交互能力 | ~150 行  |
| P0     | chrome_read_page 商业级 (depth/ref_id/stats)           | 可控性   | ~200 行  |
| P0     | chrome_console 增强 (buffer/pattern/clear)             | 调试能力 | ~200 行  |
| P0     | 整合 network capture (needResponseBody)                | 统一接口 | ~300 行  |
| P0     | javascript_tool 改造                                   | 调试能力 | ~250 行  |
| P1     | gif_creator                                            | 可观测性 | ~400 行  |
| P1     | find 自然语言找元素                                    | 易用性   | ~300 行  |
| P2     | 暴露细粒度工具                                         | 易用性   | ~50 行   |

**已决策不采用**：

- imageId 机制（增加复杂度但收益有限）
- 权限模型（先不集成）
