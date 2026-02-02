// VSCode 小说插件主文件
// 功能：状态栏字数统计、点击显示细分、敏感词检测红色标注、码字计时与速率

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

// =========================
// 常量配置（保持原有功能不变）
// =========================
// 速率状态栏刷新频率：500ms
const RATE_UPDATE_INTERVAL_MS = 500;
// 5 秒无字符变动则暂停计时
const IDLE_STOP_TIMEOUT_MS = 5000;

// 状态栏项
let statusBarCount = null; // 显示总字符数（可点击）
let statusBarTime = null; // 显示计时
let statusBarRate = null; // 显示速率

// 全局计时与速率数据（所有文件共用）
let globalTypedCount = 0; // 全局净输入字符数
let globalAccumulatedSeconds = 0; // 全局累计码字秒数
let globalTimerId = null; // 全局计时器（每秒递增）
let globalRateUpdateTimer = null; // 速率更新计时器（每500ms更新一次）
let globalStopTimeout = null; // 全局停止超时（5秒无字符变动）
let lastCharChangeTime = 0; // 最后一次字符变动的时间戳
let isAutoFormatting = false; // 自动格式化回车的保护开关

// 文档会话数据（仅用于敏感词高亮）
// key: document.uri.toString()
const sessions = new Map();

// 敏感词高亮样式（红色）
const sensitiveDecorationType = vscode.window.createTextEditorDecorationType({
  color: "red",
});

/**
 * 工具：判断文档是否为本地支持的文件（.txt 或 .md）
 * 说明：只对本地文件系统（scheme === "file"）生效，避免对虚拟文档/输出面板等误处理。
 */
function isSupportedDocument(doc) {
  if (!doc || !doc.uri || doc.uri.scheme !== "file") return false;
  const fsPath = doc.uri.fsPath.toLowerCase();
  return fsPath.endsWith(".txt") || fsPath.endsWith(".md");
}

/**
 * 工具：获取文档当前使用的换行符
 * - CRLF：\r\n（Windows 常见）
 * - LF：\n（Unix/Mac 常见）
 */
function getDocumentEol(doc) {
  return doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}

/**
 * 工具：判断某个 editor 是否正在编辑指定 doc
 */
function isSameDocument(editor, doc) {
  return (
    !!editor &&
    !!editor.document &&
    editor.document.uri.toString() === doc.uri.toString()
  );
}

/**
 * 工具：获取有效字符（排除控制字符与空白字符）
 */
function getValidText(text) {
  // 排除空白字符（空格、制表符、换行、回车等）和控制字符
  return text.replace(/[\s\u0000-\u001f\u007f-\u009f]/g, "");
}

/**
 * 工具：格式化秒为 hh:mm:ss
 */
function formatSeconds(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/**
 * 获取或创建当前文档会话
 */
function getSession(doc) {
  const key = doc.uri.toString();
  let s = sessions.get(key);
  if (!s) {
    s = {
      docUri: key,
      // 文档级数据（仅用于记录，不参与全局计时）
    };
    sessions.set(key, s);
  }
  return s;
}

/**
 * 启动全局计时器（每秒累加）
 */
function startGlobalTimer() {
  if (globalTimerId) return;
  globalTimerId = setInterval(() => {
    globalAccumulatedSeconds++;
  }, 1000);
}

/**
 * 停止全局计时器
 */
function stopGlobalTimer() {
  if (globalTimerId) {
    clearInterval(globalTimerId);
    globalTimerId = null;
  }
}

/**
 * 启动速率更新计时器（每500ms更新一次状态栏）
 */
function startRateUpdateTimer() {
  if (globalRateUpdateTimer) return;
  globalRateUpdateTimer = setInterval(() => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      updateStatusBarForEditor(editor);
    }
  }, RATE_UPDATE_INTERVAL_MS);
}

/**
 * 停止速率更新计时器
 */
function stopRateUpdateTimer() {
  if (globalRateUpdateTimer) {
    clearInterval(globalRateUpdateTimer);
    globalRateUpdateTimer = null;
  }
}

/**
 * 页面字符变动时处理：启动计时并设置 5 秒无变动暂停
 */
function onCharacterChange() {
  lastCharChangeTime = Date.now();

  // 重置 5 秒无字符变动超时
  if (globalStopTimeout) clearTimeout(globalStopTimeout);
  globalStopTimeout = setTimeout(() => {
    stopGlobalTimer();
    stopRateUpdateTimer();
    globalStopTimeout = null;
  }, IDLE_STOP_TIMEOUT_MS);

  // 启动全局计时器与速率更新计时器
  startGlobalTimer();
  startRateUpdateTimer();
}

/**
 * 读取敏感词（查找敏感词.txt 或 敏感词.md）
 * 优先：当前文件目录；若不存在则使用工作区根目录
 * 查找顺序：敏感词.txt → 敏感词.md
 */
function loadSensitiveWords(editor) {
  if (!editor) return [];
  const doc = editor.document;

  // 小工具：读取并解析敏感词文件（空白分隔）
  const readWordsFromFile = (filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    return content
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  };

  // 小工具：尝试读取文件，返回找到则返回词汇数组，否则返回 null
  const tryReadFile = (filePath) => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        return readWordsFromFile(filePath);
      }
    } catch (err) {
      // 文件不存在，继续尝试下一个
    }
    return null;
  };

  const roots = vscode.workspace.workspaceFolders;
  const docDir =
    doc.uri.scheme === "file" ? path.dirname(doc.uri.fsPath) : null;

  // 优先尝试当前文件目录
  if (docDir) {
    // 先尝试 敏感词.txt
    let result = tryReadFile(path.join(docDir, "敏感词.txt"));
    if (result) return result;

    // 再尝试 敏感词.md
    result = tryReadFile(path.join(docDir, "敏感词.md"));
    if (result) return result;
  }

  // 再尝试工作区根目录
  if (roots && roots.length > 0) {
    const rootDir = roots[0].uri.fsPath;

    // 先尝试 敏感词.txt
    let result = tryReadFile(path.join(rootDir, "敏感词.txt"));
    if (result) return result;

    // 再尝试 敏感词.md
    result = tryReadFile(path.join(rootDir, "敏感词.md"));
    if (result) return result;
  }

  return [];
}

/**
 * 转义正则特殊字符
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 更新敏感词高亮
 */
function updateSensitiveDecorations(editor) {
  if (!editor) return;
  const doc = editor.document;
  const text = doc.getText();
  const words = loadSensitiveWords(editor);

  if (!words.length) {
    editor.setDecorations(sensitiveDecorationType, []);
    return;
  }

  const ranges = [];
  for (const word of words) {
    if (!word) continue;
    const re = new RegExp(escapeRegExp(word), "g");
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = doc.positionAt(m.index);
      const end = doc.positionAt(m.index + m[0].length);
      ranges.push(new vscode.Range(start, end));
      // 避免零长度匹配导致死循环
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  editor.setDecorations(sensitiveDecorationType, ranges);
}

/**
 * 状态栏更新（无编辑器时显示默认值）
 */
function updateStatusBar() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    statusBarCount.text = "字符: -";
    statusBarTime.text = "计时: 00:00:00";
    statusBarRate.text = "速率: -/h";
    return;
  }
  updateStatusBarForEditor(editor);
}

/**
 * 为指定编辑器更新状态栏（使用全局计时与速率）
 */
function updateStatusBarForEditor(editor, updateRate = true) {
  const doc = editor.document;
  const text = doc.getText();
  const total = getValidText(text).length;

  statusBarCount.text = `字符: ${total}`;
  statusBarTime.text = `计时: ${formatSeconds(globalAccumulatedSeconds)}`;

  // 速率只在需要时才计算/刷新（用于 500ms 定时器节流）
  if (updateRate) {
    let rate = 0;
    if (globalAccumulatedSeconds > 0) {
      rate = Math.round(
        globalTypedCount / (globalAccumulatedSeconds / 3600) || 0,
      );
    }
    statusBarRate.text = `速率: ${rate}/h`;
  }
}

/**
 * 命令：显示字数细分（总字符、中文、英文）
 */
function showCountsCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("未打开编辑器");
    return;
  }
  const text = editor.document.getText();
  const total = getValidText(text).length;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const english = (text.match(/[A-Za-z]/g) || []).length;
  vscode.window.showInformationMessage(
    `总字符: ${total}，中文: ${chinese}，英文: ${english}`,
  );
}

/**
 * 文本变化事件：监测字符变动，统计净输入并触发计时
 */
function onDidChangeTextDocument(e) {
  const doc = e.document;
  getSession(doc); // 确保会话存在（敏感词高亮用；不参与计时）

  // =========================
  // 第一部分：自动格式化（对本地 .txt 和 .md 文件：检测到换行则额外插入一个换行）
  // =========================
  // 说明：我们监听到用户输入换行后，会再插入一个换行符，从而形成"空白行"的效果。
  // 注意：本逻辑会再次触发 onDidChangeTextDocument，因此必须用 isAutoFormatting 防止递归。
  if (isSupportedDocument(doc) && !isAutoFormatting) {
    const editor = vscode.window.activeTextEditor;

    // 只对当前活跃编辑器生效，避免后台文档变化造成意外编辑
    if (isSameDocument(editor, doc)) {
      const eol = getDocumentEol(doc);
      // 当前保留的“缩进”变量：仅用于未来扩展/可读性（不改变现有行为）
      // eslint-disable-next-line no-unused-vars
      const indent = "    ";

      // 遍历本次所有变更：一次输入法提交/粘贴可能包含多个 change
      for (const change of e.contentChanges) {
        // 判断插入文本中是否包含换行符：
        // - 常规回车：change.text 通常为 "\n" 或 "\r\n"（API里一般归一为 \n）
        // - 粘贴多行：change.text 可能包含多个 \n
        if (!change.text || !change.text.includes("\n")) continue;

        // 进入自动格式化流程：本次只处理第一个包含换行的 change，避免重复插入
        isAutoFormatting = true;

        // change.range.end 表示此次变更插入完成后的位置
        // 在这个位置继续插入额外的换行符，通常可以形成一个空白行
        const insertPos = change.range.end;

        editor
          .edit((editBuilder) => {
            // 保持现有功能不变：额外插入一个换行符
            editBuilder.insert(insertPos, `${eol}`);
          })
          .then(
            () => {
              // 成功也要复位，允许后续用户继续触发
              isAutoFormatting = false;
            },
            () => {
              // 失败同样复位，避免功能被“锁死”
              isAutoFormatting = false;
            },
          );

        break;
      }
    }
  }

  // =========================
  // 第二部分：净输入统计（插入 - 删除）
  // =========================
  let hasCharChange = false;
  for (const change of e.contentChanges) {
    const inserted = change.text.length;
    const removed = change.rangeLength || 0;
    const delta = inserted - removed;

    // 累计到全局计数（字符实际变动数量）
    globalTypedCount = Math.max(0, globalTypedCount + delta);

    // 只要有插入或删除，就视为字符变动
    if (inserted !== 0 || removed !== 0) {
      hasCharChange = true;
    }
  }

  // 仅当页面内有字符变动时，才触发计时
  if (hasCharChange) {
    onCharacterChange();
  }

  // =========================
  // 第三部分：更新 UI（状态栏 + 敏感词高亮）
  // 只对支持的文件类型（.txt 或 .md）生效
  // =========================
  const active = vscode.window.activeTextEditor;
  if (isSameDocument(active, doc) && isSupportedDocument(doc)) {
    updateStatusBarForEditor(active, false); // 不更新速率
    updateSensitiveDecorations(active);
  }
}

/**
 * 插件激活
 */
function activate(context) {
  // 创建状态栏
  statusBarCount = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarCount.command = "novel-plugin.showCounts";
  statusBarCount.tooltip = "点击查看字符细分（总字符/中文/英文）";
  statusBarCount.show();

  statusBarTime = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99,
  );
  statusBarTime.tooltip = "累计码字时间（页面字符变动时计时，5秒无变动暂停）";
  statusBarTime.show();

  statusBarRate = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    98,
  );
  statusBarRate.tooltip = "码字每小时速率（净输入）";
  statusBarRate.show();

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novel-plugin.showCounts",
      showCountsCommand,
    ),
  );

  // 监听事件
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(onDidChangeTextDocument),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !isSupportedDocument(editor.document)) return;
      updateStatusBarForEditor(editor, false);
      updateSensitiveDecorations(editor);
    }),
  );

  // 初始化
  const active = vscode.window.activeTextEditor;
  if (active && isSupportedDocument(active.document)) {
    updateStatusBarForEditor(active, false);
    updateSensitiveDecorations(active);
  } else {
    updateStatusBar();
  }
}

/**
 * 插件注销
 */
function deactivate() {
  // 清理全局计时器与速率更新计时器
  if (globalTimerId) clearInterval(globalTimerId);
  if (globalRateUpdateTimer) clearInterval(globalRateUpdateTimer);
  if (globalStopTimeout) clearTimeout(globalStopTimeout);
}

module.exports = {
  activate,
  deactivate,
};
