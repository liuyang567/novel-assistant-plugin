# VSCode 小说辅助插件 - AI 编码指南

## 项目概述

Chinese VSCode 插件，提供对 `.txt` 和 `.md` 文件的支持，为小说/网文创作者提供五大功能：

1. **字数统计** - 状态栏显示有效字符数（排除空白字符），支持点击查看中/英文细分
2. **敏感词检测** - 读取 `敏感词.txt` 或 `敏感词.md`，用红色标注匹配词汇
3. **码字计时和速率** - 自动检测文本变化，记录净输入字符数和码字时间，计算每小时速率
4. **自动空行** - 检测到换行时自动插入重叠换行符，方便段落排版
5. **文件类型支持** - 完全支持 `.txt` 和 `.md` 两种文件格式

## 核心架构

### 全局状态管理

- **单一数据源原则**：`globalTypedCount`（净输入字符）和 `globalAccumulatedSeconds`（码字秒数）是全局共享状态
  - 所有打开的文件共用同一计时和速率计算
  - 文档级会话（`sessions` Map）仅用于敏感词高亮追踪，不参与计时
  - 见 [extension.js#L15-L26](extension.js#L15-L26)

### 三层事件驱动模型

1. **文本变化层**（`onDidChangeTextDocument`）
   - 第一部分：自动格式化（对 `.txt` 和 `.md` 文件：插入额外换行符，仅对活跃编辑器生效）
   - 第二部分：净输入统计（计算 delta = 插入 - 删除，累加到 `globalTypedCount`）
   - 第三部分：UI 更新（调用 `updateStatusBarForEditor(false)` 和 `updateSensitiveDecorations()`）
   - 有字符变动时触发 `onCharacterChange()` 启动计时

2. **计时层**（两个并行计时器）
   - `globalTimerId`：每秒递增 `globalAccumulatedSeconds`（主计时）
   - `globalRateUpdateTimer`：每 500ms 调用 `updateStatusBarForEditor(true)` 更新速率显示
   - 5 秒无字符变动时双双暂停（`globalStopTimeout`）

3. **编辑器切换层**（`onDidChangeActiveTextEditor`）
   - 针对当前活跃编辑器更新状态栏（完整更新，含速率）和敏感词高亮
   - 计时不中断，保持全局连续性

## 关键实现细节

### 敏感词检测机制

- **二伪三选加载**：优先当前文件目录 → 退回工作区根目录；优先 `.txt` → 再 `.md`
- **空白分隔格式**：`敏感词.txt` 或 `敏感词.md` 中词汇由任意空白字符分隔
- **RegExp 转义**：使用 `escapeRegExp()` 防止正则元字符注入
- **零长度匹配保护**：循环中手动递增 `re.lastIndex` 防止死循环
- 见 [extension.js#L158-L206](extension.js#L158-L206)

### 字符计数统计

- **有效字符**：使用 `getValidText()` 函数排除空白字符和控制字符
  - 排除规则：`/[\s\u0000-\u001f\u007f-\u009f]/g`
  - `\s`：所有空白字符（空格、制表符、换行、回车等）
  - `\u0000-\u001f` 和 `\u007f-\u009f`：控制字符
- **中文统计**：正则匹配 `/[\u4e00-\u9fff]/g`
- **英文统计**：正则匹配 `/[A-Za-z]/g`
- 见 [extension.js#L72-L76](extension.js#L72-L76) 中的 `getValidText()` 和 `showCountsCommand()`

### 速率计算

- **公式**：`rate = Math.round(globalTypedCount / (globalAccumulatedSeconds / 3600))`
- **为何使用净输入**：删除字符会减少 `globalTypedCount`，体现真实有效输入
- **时间颗粒度**：基于秒级累计，避免计时误差
- **节流优化**：`updateStatusBarForEditor()` 接收 `updateRate` 参数
  - 文本变化时：无条件更新时间和字符数，但仅部分更新速率（`updateRate=false`）
  - 500ms 定时器：完整更新所有项目包括速率（`updateRate=true`）
- 见 [extension.js#L268-L287](extension.js#L268-L287)

## 开发工作流

### 调试运行

```bash
# VS Code 中按 F5，启动 Extension Development Host
# - 测试文件自动刷新敏感词高亮
# - 所有状态栏功能可即时验证
# 停止按 Shift+F5
```

### 测试敏感词功能

1. 修改工作区根目录的 `敏感词.txt`（空白分隔词汇）
2. 在 Extension Development Host 中打开文本文件
3. 观察敏感词自动变红

### 扩展点参考

- 状态栏项创建：`vscode.window.createStatusBarItem()`（参数含对齐位置和优先级）
- 命令注册：`vscode.commands.registerCommand()`
- 事件监听：`vscode.workspace.onDidChangeTextDocument()`、`vscode.window.onDidChangeActiveTextEditor()`
- 文本装饰：`vscode.window.createTextEditorDecorationType()` 和 `editor.setDecorations()`
- 见 [extension.js#L274-L310](extension.js#L274-L310) 中的 `activate()`

## 常见修改模式

### 添加新状态栏项

遵循三步模式（见现有三个状态栏实现）：

1. 声明全局变量和初始化（`activate()` 中）
2. 在 `updateStatusBarForEditor()` 中更新文本
3. 在适当事件回调中调用更新函数

### 修改计时逻辑

- **改变暂停阈值**：修改 `globalStopTimeout` 的 `IDLE_STOP_TIMEOUT_MS = 5000` 常量值
- **改变 UI 刷新频率**：修改 `globalRateUpdateTimer` 的 `RATE_UPDATE_INTERVAL_MS = 500` 常量值
- **文本变化时速率更新**：在 `onDidChangeTextDocument` 中调用 `updateStatusBarForEditor(false)` 可禁止即时计算速率
- **注意**：修改后需充分测试跨文件编辑场景，特别是切换编辑器时的状态一致性

### 扩展敏感词过滤

- 当前采用简单空白分隔，若需复杂格式（如分类/替换规则），在 `loadSensitiveWords()` 中扩展解析逻辑
- 新增过滤规则后更新 `updateSensitiveDecorations()` 中的匹配逻辑

## 已知限制和改进空间

- 计时器在5秒无活动后暂停，不适合长时间思考场景（可添加配置选项）
- 净输入计数不区分撤销/重做，仅按增删 delta 计算（可通过事件历史改进）
- 敏感词单次加载后若文件修改需手动切换编辑器重新加载（可加文件监听）
- `.md` 文件中自动空行可能影响 Markdown 格式（建议用户谨慎使用）

## 文件结构

```
extension.js       # 主逻辑（全部功能）
package.json       # 插件元数据和命令定义
敏感词.txt        # 敏感词列表（空白分隔）
```
