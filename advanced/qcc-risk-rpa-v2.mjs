import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXCEL_HELPER = join(SCRIPT_DIR, "extract-excel-companies.py");
const DATA_DIR = join(SCRIPT_DIR, "data");
const DEFAULT_COMPANIES_FILE = join(DATA_DIR, "company-lists", "companies.csv");
const DEFAULT_RESULTS_DIR = join(DATA_DIR, "results");
const DEFAULT_RULES_FILE = join(SCRIPT_DIR, "risk-rules-v2.json");
const QCC_HOME = "https://www.qcc.com/";
const QCC_SEARCH = "https://www.qcc.com/web/search?key=";
const RECENT_DAYS = 30;
const THREE_MONTH_DAYS = 90;

const RISK_LABELS = [
  "自身风险",
  "关联风险",
  "历史信息",
  "提示信息",
  "深度风险分析",
  "债务/债权",
  "风险关系",
  "合同违约",
  "竞争风险",
  "合作风险",
];

const DEFAULT_COLUMNS = [
  "公司名称",
  "状态",
  "预警等级",
  "预警摘要",
  "匹配公司",
  "企查查链接",
  "企查分",
  "自身风险",
  "自身风险_重要",
  "被执行人总数",
  "近30天被执行人数",
  "近90天被执行人数",
  "被执行金额总额(元)",
  "近30天被执行金额(元)",
  "商业合作纠纷（被告）总数",
  "近30天商业合作纠纷（被告）数",
  "近30天最新风险日期",
  "被执行人明细JSON",
  "商业合作纠纷（被告）明细JSON",
  "关联风险",
  "历史信息",
  "提示信息",
  "深度风险分析",
  "债务/债权",
  "风险关系",
  "合同违约",
  "竞争风险",
  "合作风险",
  "错误信息",
  "检查时间",
];

function usage() {
  console.log(`
企查查风险扫描 RPA

用法:
  node qcc-risk-rpa.mjs --login
  node qcc-risk-rpa.mjs --input data/company-lists/companies.csv --output data/results/risk-results.csv

常用参数:
  --input <file>          公司名单，支持 csv/txt/xlsx/xlsm。默认: data/company-lists/companies.csv
  --output <file>         输出 csv。默认: data/results/risk-results-时间戳.csv
  --rules <file>          预警规则 JSON。默认: risk-rules.json
  --profile-dir <dir>     浏览器登录态目录。默认: runtime/browser-profile
  --browser <file>        Chrome/Edge 路径，不填则自动查找
  --port <number>         Chrome 调试端口。默认: 9222
  --delay-ms <number>     每家公司之间固定等待毫秒数（兼容旧参数）。默认: 5000
  --delay-min-ms <number> 每家公司之间随机等待下限（毫秒）
  --delay-max-ms <number> 每家公司之间随机等待上限（毫秒）
  --limit <number>        只处理前 N 家，调试用
  --assume-logged-in      启动后不暂停等待确认登录
  --auto-confirm-login    自动检测企查查登录成功，不等待命令行回车
  --no-manual             遇到登录/验证码/找不到公司时不暂停
  --headless              无头运行；企查查页面更建议可见浏览器
  --help                  显示帮助
`);
}

function parseArgs(argv) {
  const args = {
    input: DEFAULT_COMPANIES_FILE,
    output: join(DEFAULT_RESULTS_DIR, `risk-results-${timestampForFile()}.csv`),
    rules: DEFAULT_RULES_FILE,
    profileDir: join(SCRIPT_DIR, "runtime", "browser-profile"),
    port: 9222,
    delayMs: 5000,
    delayMinMs: null,
    delayMaxMs: null,
    limit: 0,
    manual: true,
    headless: false,
    login: false,
    assumeLoggedIn: false,
    autoConfirmLogin: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`${key} 缺少参数值`);
      }
      return argv[i];
    };

    switch (key) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--login":
        args.login = true;
        break;
      case "--input":
      case "-i":
        args.input = resolvePath(next());
        break;
      case "--output":
      case "-o":
        args.output = resolvePath(next());
        break;
      case "--rules":
        args.rules = resolvePath(next());
        break;
      case "--profile-dir":
        args.profileDir = resolvePath(next());
        break;
      case "--browser":
        args.browser = resolvePath(next());
        break;
      case "--port":
        args.port = Number(next());
        break;
      case "--delay-ms":
        args.delayMs = Number(next());
        break;
      case "--delay-min-ms":
        args.delayMinMs = Number(next());
        break;
      case "--delay-max-ms":
        args.delayMaxMs = Number(next());
        break;
      case "--limit":
        args.limit = Number(next());
        break;
      case "--assume-logged-in":
        args.assumeLoggedIn = true;
        break;
      case "--auto-confirm-login":
        args.autoConfirmLogin = true;
        break;
      case "--no-manual":
        args.manual = false;
        break;
      case "--headless":
        args.headless = true;
        break;
      default:
        throw new Error(`未知参数: ${key}`);
    }
  }

  const fallbackDelay = normalizeDelayMs(args.delayMs, 5000);
  const minDelay = args.delayMinMs == null ? fallbackDelay : normalizeDelayMs(args.delayMinMs);
  const maxDelay = args.delayMaxMs == null
    ? (args.delayMinMs == null ? fallbackDelay : minDelay)
    : normalizeDelayMs(args.delayMaxMs);
  if (minDelay > maxDelay) {
    throw new Error("扫描间隔范围无效：最小间隔不能大于最大间隔");
  }
  args.delayMinMs = minDelay;
  args.delayMaxMs = maxDelay;
  return args;
}

function normalizeDelayMs(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    if (fallback != null) return fallback;
    throw new Error("扫描间隔必须是大于或等于 0 的数字");
  }
  return Math.floor(number);
}

function randomDelayMs(minMs, maxMs) {
  if (minMs === maxMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function resolvePath(value) {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function timestampForFile(date = new Date()) {
  const pad = (number) => String(number).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function nowText() {
  const date = new Date();
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForPageValue(page, evaluator, args = [], timeoutMs = 12000, intervalMs = 350) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await page.evaluate(evaluator, ...args);
    if (lastValue) {
      return lastValue;
    }
    await sleep(intervalMs);
  }
  return lastValue;
}

function ensureDirForFile(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function findBrowserPath(customPath) {
  if (customPath) {
    if (!existsSync(customPath)) {
      throw new Error(`找不到浏览器: ${customPath}`);
    }
    return customPath;
  }

  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("没有找到 Chrome 或 Edge。请用 --browser 指定浏览器 exe 路径。");
  }

  return found;
}

async function fetchJson(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForChrome(port, timeoutMs = 12000) {
  const started = Date.now();
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`, 1000);
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }

  throw new Error(`Chrome 调试端口未就绪: ${lastError?.message || "timeout"}`);
}

async function startOrConnectBrowser(args) {
  try {
    const version = await fetchJson(`http://127.0.0.1:${args.port}/json/version`, 1000);
    console.log(`已连接现有浏览器调试端口: ${args.port}`);
    return version.webSocketDebuggerUrl;
  } catch {
    // Start a dedicated browser below.
  }

  const browserPath = findBrowserPath(args.browser);
  mkdirSync(args.profileDir, { recursive: true });

  const chromeArgs = [
    `--remote-debugging-port=${args.port}`,
    `--user-data-dir=${args.profileDir}`,
    "--no-first-run",
    "--new-window",
    "--disable-background-networking",
    "--disable-features=ChromeWhatsNewUI",
    "about:blank",
  ];

  if (args.headless) {
    chromeArgs.splice(0, 0, "--headless=new");
  }

  const child = spawn(browserPath, chromeArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  console.log(`已启动浏览器: ${browserPath}`);
  console.log(`登录态目录: ${args.profileDir}`);

  const version = await waitForChrome(args.port);
  return version.webSocketDebuggerUrl;
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);

    await new Promise((resolveConnect, rejectConnect) => {
      const cleanup = () => {
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolveConnect();
      };
      const onError = (event) => {
        cleanup();
        rejectConnect(new Error(`WebSocket 连接失败: ${event.message || "unknown"}`));
      };
      this.socket.addEventListener("open", onOpen, { once: true });
      this.socket.addEventListener("error", onError, { once: true });
    });

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message || "CDP error"} ${JSON.stringify(message.error.data || "")}`));
      } else {
        pending.resolve(message.result || {});
      }
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId;
    this.nextId += 1;

    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify(payload));
    });
  }

  async close() {
    if (this.socket) {
      this.socket.close();
    }
  }
}

class BrowserPage {
  constructor(client, sessionId, targetId) {
    this.client = client;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method, params = {}) {
    return this.client.send(method, params, this.sessionId);
  }

  async init() {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
  }

  async navigate(url, settleMs = 2500) {
    await this.send("Page.navigate", { url });
    await this.waitForReady(45000);
    await sleep(settleMs);
  }

  async waitForReady(timeoutMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const state = await this.evaluate(() => document.readyState);
        if (state === "interactive" || state === "complete") {
          return;
        }
      } catch {
        // The frame can be temporarily unavailable while navigating.
      }
      await sleep(500);
    }
  }

  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 60000,
    });

    if (result.exceptionDetails) {
      const text = result.exceptionDetails.text || "Runtime.evaluate failed";
      throw new Error(text);
    }

    return result.result?.value;
  }

  async currentUrl() {
    return await this.evaluate(() => location.href);
  }

  async activate() {
    if (this.targetId) {
      await this.client.send("Target.activateTarget", { targetId: this.targetId });
    }
  }

  async clickAt(x, y) {
    await this.activate();
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }
}

async function attachPage(client, targetId) {
  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });

  const page = new BrowserPage(client, sessionId, targetId);
  await page.init();
  return page;
}

async function createPage(client) {
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  return await attachPage(client, targetId);
}

async function listPageTargets(client) {
  const { targetInfos = [] } = await client.send("Target.getTargets");
  return targetInfos.filter((target) => target.type === "page");
}

function parseCompanies(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`公司名单文件不存在: ${filePath}`);
  }

  const ext = filePath.toLowerCase().split(".").pop();
  if (ext === "xlsx" || ext === "xlsm") {
    return parseExcelCompanies(filePath);
  }

  const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");

  if (ext === "txt") {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const rows = parseCsv(raw).filter((row) => row.some((cell) => cell.trim()));
  if (!rows.length) {
    return [];
  }

  const header = rows[0].map(normalizeHeader);
  const possibleNames = ["公司名称", "企业名称", "company_name", "compan_name", "company", "name"].map(normalizeHeader);
  const companyIndex = header.findIndex((cell) => possibleNames.includes(cell));
  const startIndex = companyIndex >= 0 ? 1 : 0;
  const index = companyIndex >= 0 ? companyIndex : 0;

  return rows
    .slice(startIndex)
    .map((row) => (row[index] || "").trim())
    .filter(Boolean);
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-\u3000]+/g, "");
}

function parseExcelCompanies(filePath) {
  const pythonPath = findPythonPath();
  if (!existsSync(EXCEL_HELPER)) {
    throw new Error(`Excel 解析脚本不存在: ${EXCEL_HELPER}`);
  }

  const result = spawnSync(pythonPath, [EXCEL_HELPER, filePath], {
    cwd: SCRIPT_DIR,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Excel 解析失败: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }

  const payload = JSON.parse(result.stdout || "{}");
  return Array.isArray(payload.companies) ? payload.companies : [];
}

function findPythonPath() {
  const bundled = "C:\\Users\\32719\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";
  return existsSync(bundled) ? bundled : "python";
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.replace(/\r$/, ""));
  rows.push(row);
  return rows;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(filePath, rows) {
  ensureDirForFile(filePath);
  const content = [
    DEFAULT_COLUMNS.map(csvEscape).join(","),
    ...rows.map((row) => DEFAULT_COLUMNS.map((column) => csvEscape(row[column])).join(",")),
  ].join("\r\n");
  writeFileSync(filePath, `\uFEFF${content}\r\n`, "utf8");
}

function loadRules(filePath) {
  const rules = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  rules.severityOrder ||= ["正常", "提示", "关注", "高危", "重大"];
  rules.normalLevel ||= "正常";
  rules.thresholds ||= [];
  return rules;
}

function normalizeCompanyName(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .trim();
}

async function askEnter(message) {
  const rl = createInterface({ input, output });
  try {
    await rl.question(`${message}\n按 Enter 继续...`);
  } finally {
    rl.close();
  }
}

async function readLoginState(page) {
  return await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const accountLink = document.querySelector('a[href*="/web/user/account-info"]');
    const hasAccountEntry = Boolean(accountLink) || /进入个人中心|个人中心/.test(text);
    const hasLoginPanel = /扫码登录|密码登录|短信登录|手机号登录|请登录|登录后查看更多|登录\/注册/.test(text)
      || /login|user_login/i.test(location.href);
    return {
      loggedIn: hasAccountEntry && !hasLoginPanel,
      hasAccountEntry,
      hasLoginPanel,
      url: location.href,
    };
  });
}

async function waitForLoginCompletion(page, context) {
  console.log(`${context}：等待企查查登录完成，成功后将自动继续。`);
  let lastMessageAt = 0;

  while (true) {
    const state = await readLoginState(page);
    if (state.loggedIn) {
      console.log("已检测到企查查会员登录状态，自动继续。");
      return state;
    }

    const now = Date.now();
    if (now - lastMessageAt >= 15000) {
      console.log("尚未检测到登录成功，请在企查查浏览器中完成登录。");
      lastMessageAt = now;
    }
    await sleep(1200);
  }
}

async function maybeManualIntervention(page, args, context) {
  const state = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const url = location.href;
    const hasCaptcha = /验证码|安全验证|滑块|拖动滑块|人机验证|访问异常|环境异常/.test(text);
    const hasLoginPanel = /扫码登录|密码登录|短信登录|手机号登录|请登录|登录后查看更多/.test(text) || /login|user_login/i.test(url);
    return {
      url,
      hasCaptcha,
      hasLoginPanel,
      sample: text.replace(/\s+/g, " ").slice(0, 180),
    };
  });

  if (!args.manual) {
    return state;
  }

  if (state.hasCaptcha) {
    await askEnter(`${context}: 页面出现验证/风控。请在浏览器里手动完成处理。`);
    await sleep(1500);
  } else if (state.hasLoginPanel) {
    if (args.autoConfirmLogin) {
      await waitForLoginCompletion(page, context);
    } else {
      await askEnter(`${context}: 页面需要登录。请在浏览器里手动完成处理。`);
      await sleep(1500);
    }
  }

  return state;
}

async function waitForCompanyDetail(page, company, { requireExact = true } = {}) {
  const state = await waitForPageValue(page, (companyName) => {
    const compact = (value) => String(value || "")
      .replace(/\s+/g, "")
      .replace(/（/g, "(")
      .replace(/）/g, ")")
      .trim();
    const expected = compact(companyName);
    const headingText = String(document.querySelector("h1")?.innerText || "").trim();
    const heading = compact(headingText);
    const firmPage = /\/firm\//i.test(location.href);
    const hasCompanyContent = Boolean(document.querySelector(".company-detail, .company-header, .app-risk-bar-company"));
    if (!firmPage || !hasCompanyContent || !heading) return null;
    return {
      url: location.href,
      heading,
      headingText,
      companyMatches: heading === expected,
    };
  }, [company], 15000);

  if (!state) {
    throw new Error("企业详情页未完成加载");
  }
  if (requireExact && !state.companyMatches) {
    throw new Error(`企业名称不完全匹配：名单为“${company}”，详情页为“${state.headingText || state.heading || "未读取到企业名称"}”`);
  }
  return state;
}

async function waitForManualCompanyDetailPage(page, company, beforeTargets, timeoutMs = 25000) {
  const beforeIds = new Set((beforeTargets || []).map((target) => target.targetId));
  const started = Date.now();
  let selectedTarget = null;

  while (Date.now() - started < timeoutMs) {
    const targets = await listPageTargets(page.client);
    const newFirmTargets = targets.filter((target) =>
      !beforeIds.has(target.targetId) && /\/firm\//i.test(target.url || ""));

    selectedTarget = newFirmTargets.find((target) => target.openerId === page.targetId)
      || newFirmTargets[0]
      || null;
    if (selectedTarget) {
      break;
    }

    try {
      const currentUrl = await page.currentUrl();
      if (/\/firm\//i.test(currentUrl)) {
        const verified = await waitForCompanyDetail(page, company, { requireExact: false });
        return {
          page,
          verified,
          targetId: page.targetId,
          openedNew: false,
        };
      }
    } catch {
      // The original tab can be between navigation states while the user opens a company page.
    }

    await sleep(300);
  }

  if (!selectedTarget) {
    throw new Error("未检测到人工选择的企业详情页；请确认详情页已经打开后再点击继续");
  }

  try {
    const detailPage = await attachPage(page.client, selectedTarget.targetId);
    await detailPage.activate();
    await detailPage.waitForReady(30000);
    const verified = await waitForCompanyDetail(detailPage, company, { requireExact: false });
    return {
      page: detailPage,
      verified,
      targetId: selectedTarget.targetId,
      openedNew: true,
    };
  } catch (error) {
    try {
      await page.client.send("Target.closeTarget", { targetId: selectedTarget.targetId });
    } catch {
      // Keep the original loading error when cleanup also fails.
    }
    throw error;
  }
}

async function openCompanyDetail(page, company, args) {
  const searchUrl = `${QCC_SEARCH}${encodeURIComponent(company)}`;
  await page.navigate(searchUrl);
  await maybeManualIntervention(page, args, `${company} 搜索页`);

  const current = await page.currentUrl();
  if (/\/firm\//i.test(current)) {
    const currentDetail = await waitForCompanyDetail(page, company, { requireExact: false });
    if (currentDetail.companyMatches) {
      return { url: currentDetail.url, matchedCompany: currentDetail.headingText || company };
    }
    if (!args.manual) {
      throw new Error(`企业名称不完全匹配：名单为“${company}”，企查查为“${currentDetail.headingText}”`);
    }
    const beforeTargets = await listPageTargets(page.client);
    await askEnter(
      `${company}: 企查查打开了名称不一致的企业“${currentDetail.headingText}”。请核对该企业是否就是业务名单中的公司；确认无误后按“继续”，否则返回搜索页选择正确企业后再继续。`,
    );
    const manualDetail = await waitForManualCompanyDetailPage(page, company, beforeTargets);
    const confirmed = manualDetail.verified;
    console.log(`  已人工确认公司名称映射：${company} -> ${confirmed.headingText}`);
    return {
      url: confirmed.url,
      matchedCompany: confirmed.headingText,
      nameMismatchConfirmed: true,
      page: manualDetail.page,
      targetId: manualDetail.targetId,
      openedNew: manualDetail.openedNew,
    };
  }

  const searchMatches = await page.evaluate((companyName) => {
    const normalize = (value) => String(value || "")
      .replace(/\s+/g, "")
      .replace(/（/g, "(")
      .replace(/）/g, ")")
      .trim();
    const target = normalize(companyName);
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const editDistance = (left, right) => {
      const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
      for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
          current[rightIndex] = Math.min(
            current[rightIndex - 1] + 1,
            previous[rightIndex] + 1,
            previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
          );
        }
        previous.splice(0, previous.length, ...current);
      }
      return previous[right.length];
    };

    const candidates = anchors
      .map((anchor, index) => {
        const href = new URL(anchor.getAttribute("href"), location.href).href;
        const rawText = String(anchor.innerText || anchor.textContent || anchor.title || "").replace(/\s+/g, " ").trim();
        const text = normalize(rawText);
        const distance = editDistance(target, text);
        const similarity = 1 - distance / Math.max(target.length, text.length, 1);
        return {
          index,
          href,
          text: rawText,
          normalizedText: text,
          similarity,
        };
      })
      .filter((item) => /\/firm\//i.test(item.href) && item.normalizedText)
      .sort((a, b) => b.similarity - a.similarity || a.index - b.index);
    const uniqueCandidates = [...new Map(candidates.map((item) => [item.href, item])).values()];
    return {
      exact: uniqueCandidates.find((item) => item.normalizedText === target) || null,
      candidates: uniqueCandidates.slice(0, 5).map((item) => ({ text: item.text, href: item.href })),
    };
  }, company);

  if (searchMatches?.exact?.href) {
    await page.navigate(searchMatches.exact.href);
    await maybeManualIntervention(page, args, `${company} 详情页`);
    const verified = await waitForCompanyDetail(page, company);
    return {
      url: verified.url,
      matchedCompany: verified.headingText || searchMatches.exact.text.trim() || company,
    };
  }

  if (args.manual) {
    const candidateText = (searchMatches?.candidates || []).map((item) => item.text).filter(Boolean).join("、");
    const beforeTargets = await listPageTargets(page.client);
    await askEnter(
      `${company}: 没有找到名称完全一致的企业${candidateText ? `，搜索候选包括：${candidateText}` : ""}。请在浏览器中点击业务上对应的正确企业详情页，核对后按“继续”；本次选择会作为人工确认的名称映射。`,
    );
    const manualDetail = await waitForManualCompanyDetailPage(page, company, beforeTargets);
    const verified = manualDetail.verified;
    console.log(`  已人工确认公司名称映射：${company} -> ${verified.headingText}`);
    return {
      url: verified.url,
      matchedCompany: verified.headingText || company,
      nameMismatchConfirmed: !verified.companyMatches,
      page: manualDetail.page,
      targetId: manualDetail.targetId,
      openedNew: manualDetail.openedNew,
    };
  }

  const candidateText = (searchMatches?.candidates || []).map((item) => item.text).filter(Boolean).join("、");
  throw new Error(
    `搜索页没有找到与“${company}”名称完全一致的企业${candidateText ? `；候选：${candidateText}` : ""}。无人值守模式不能自动确认相似公司`,
  );
}

async function extractRiskSnapshot(page) {
  const riskBarReady = await waitForPageValue(page, () => {
    const bar = document.querySelector(".app-risk-bar-company, .company-centbar");
    const text = String(bar?.innerText || bar?.textContent || "").replace(/\s+/g, " ");
    return text.includes("自身风险") ? true : null;
  }, [], 15000);
  if (!riskBarReady) {
    throw new Error("企业详情页风险扫描区域未加载");
  }
  return await page.evaluate((riskLabels) => {
    const compactText = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const bodyText = compactText(document.body?.innerText || "");

    const nodes = Array.from(document.querySelectorAll("section, div, nav, ul, li, table"))
      .map((element) => ({
        text: compactText(element.innerText || element.textContent || ""),
      }))
      .filter((item) => item.text.includes("风险扫描") && item.text.includes("自身风险"))
      .sort((a, b) => a.text.length - b.text.length);

    let riskText = nodes[0]?.text || bodyText;
    const hits = riskLabels.filter((label) => riskText.includes(label)).length;
    if (hits < 4) {
      riskText = bodyText;
    }

    const data = {};
    for (const label of riskLabels) {
      const index = riskText.indexOf(label);
      if (index < 0) {
        data[label] = null;
        continue;
      }

      const near = riskText.slice(index + label.length, index + label.length + 48);
      const numberMatch = near.match(/\d+/);
      data[label] = numberMatch ? Number(numberMatch[0]) : null;

      if (label === "自身风险") {
        const importantMatch = near.match(/重要\s*(\d+)/);
        data["自身风险_重要"] = importantMatch ? Number(importantMatch[1]) : 0;
      }
    }

    const scoreMatch = bodyText.match(/企查分[:：]?\s*(\d+)\s*分?/);
    const companyFromTitle = compactText(document.querySelector("h1")?.innerText || document.title || "");

    return {
      companyFromTitle,
      url: location.href,
      qccScore: scoreMatch ? Number(scoreMatch[1]) : null,
      riskText,
      data,
    };
  }, RISK_LABELS);
}

function companyKeyFromFirmUrl(value) {
  const match = String(value || "").match(/\/firm\/([^/?#]+?)\.html/i);
  return match?.[1] || "";
}

function isMatchingRiskTarget(target, companyKey) {
  try {
    const url = new URL(target.url || "about:blank");
    if (!url.pathname.includes("/web/project/risk-scan-v2")) return false;
    return !companyKey || url.searchParams.get("unique") === companyKey;
  } catch {
    return false;
  }
}

async function openOwnRiskPage(client, companyPage, firmUrl, timeoutMs = 20000) {
  const beforeTargets = await listPageTargets(client);
  const beforeIds = new Set(beforeTargets.map((target) => target.targetId));
  const companyKey = companyKeyFromFirmUrl(firmUrl);
  const clickPoint = await waitForPageValue(companyPage, () => {
    const element = document.querySelector(".app-risk-bar-company .self-risk-filter");
    if (!element || !element.getClientRects().length) return null;
    element.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = element.getBoundingClientRect();
    const countText = element.querySelector(".count")?.childNodes?.[0]?.textContent
      || element.querySelector(".count")?.textContent
      || "";
    const countMatch = String(countText).match(/\d+/);
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      count: countMatch ? Number(countMatch[0]) : null,
    };
  }, [], 10000);

  if (!clickPoint) {
    throw new Error("企业详情页未找到“自身风险”入口");
  }

  await companyPage.clickAt(clickPoint.x, clickPoint.y);

  const started = Date.now();
  let selectedTarget = null;
  while (Date.now() - started < timeoutMs) {
    const targets = await listPageTargets(client);
    const matches = targets.filter((target) => isMatchingRiskTarget(target, companyKey));
    selectedTarget = matches.find((target) => !beforeIds.has(target.targetId)) || null;
    if (!selectedTarget && Date.now() - started >= 6000) {
      selectedTarget = matches.find((target) => target.openerId === companyPage.targetId)
        || matches[0]
        || null;
    }
    if (selectedTarget) break;
    await sleep(300);
  }

  if (!selectedTarget) {
    throw new Error("点击“自身风险”后未打开风险扫描页，可能当前账号无访问权限或页面入口未响应");
  }

  const openedNew = !beforeIds.has(selectedTarget.targetId);
  try {
    const riskPage = await attachPage(client, selectedTarget.targetId);
    await riskPage.activate();
    await riskPage.waitForReady(30000);
    const ready = await waitForPageValue(riskPage, () => {
      const bodyText = String(document.body?.innerText || "");
      const hasRiskCards = Boolean(document.querySelector(".block-panel-title"));
      return location.pathname.includes("/web/project/risk-scan-v2")
        && (hasRiskCards || bodyText.includes("扫描明细"));
    }, [], 15000);
    if (!ready) {
      throw new Error("风险扫描页未完成加载");
    }

    return { page: riskPage, targetId: selectedTarget.targetId, openedNew };
  } catch (error) {
    if (openedNew) {
      try {
        await client.send("Target.closeTarget", { targetId: selectedTarget.targetId });
      } catch {
        // Ignore cleanup failures and surface the original loading error.
      }
    }
    throw error;
  }
}

async function clickRiskCategory(page, label, timeoutMs = 10000) {
  const result = await waitForPageValue(page, (targetLabel) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const title = Array.from(document.querySelectorAll(".block-panel-title"))
      .find((element) => normalize(element.textContent) === normalize(targetLabel));
    if (!title) {
      const bodyText = String(document.body?.innerText || "");
      const scanReady = Boolean(document.querySelector(".b-section-wrap"))
        || (bodyText.includes("扫描明细") && bodyText.includes("自身风险"));
      return scanReady ? { count: 0, absent: true, text: targetLabel } : null;
    }
    const element = title?.closest(".block-panel-item-content, .block-panel-item");
    if (!element || !element.getClientRects().length) return null;
    element.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = element.getBoundingClientRect();
    const countText = element.querySelector(".block-panel-count")?.textContent || "";
    const countMatch = String(countText).replace(/,/g, "").match(/\d+/);
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: normalize(element.innerText || element.textContent || ""),
      count: countMatch ? Number(countMatch[0]) : null,
    };
  }, [label], timeoutMs);
  if (!result) throw new Error(`未找到风险分类：${label}`);
  if (result.count !== 0) {
    await page.clickAt(result.x, result.y);
    await sleep(700);
  }
  return result;
}

async function readRiskAccessState(page) {
  return await page.evaluate(() => {
    const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ");
    const visible = (element) => Boolean(element && element.getClientRects().length);
    const accessText = Array.from(document.querySelectorAll(
      "[role='dialog'],.qccd-modal-wrap,.qccd-modal,.login-modal,.vip-modal,.pay-modal",
    ))
      .filter(visible)
      .map((element) => String(element.innerText || element.textContent || ""))
      .join(" ")
      .replace(/\s+/g, " ");
    const riskComponent = document.querySelector(".app-risk-bar-company")?.__vue__;
    const user = riskComponent?.user || document.querySelector("#__layout")?.__vue__?.$store?.state?.user || {};
    const hasVip = Boolean(user.isVip || user.isSvip || user.isEntVip || user.isEntSvip);
    return {
      loggedIn: Boolean(user.isLogin) || !/请登录|登录后查看更多|登录\/注册/.test(bodyText),
      hasVip,
      hasVipGate: /成为VIP|开通VIP|会员解锁|升级会员|购买套餐|暂无权限/.test(accessText),
    };
  });
}

async function waitForRiskModal(page, label, timeoutMs = 10000) {
  return await waitForPageValue(page, (targetLabel) => {
    const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => Boolean(element && element.getClientRects().length);
    const modals = Array.from(document.querySelectorAll("[role='dialog'],.qccd-modal-wrap,.qccd-modal"))
      .filter(visible)
      .filter((element, index, items) => !items.some((other, otherIndex) => otherIndex !== index && other.contains(element)));
    const modal = modals.find((element) => {
      const title = compact(element.querySelector(".qccd-modal-title,.modal-title")?.innerText || "");
      const text = compact(element.innerText || element.textContent || "");
      return title.includes(targetLabel)
        || text.includes(targetLabel)
        || /成为VIP|开通VIP|会员解锁|升级会员|购买套餐|暂无权限/.test(text);
    });
    if (!modal) return null;
    const text = compact(modal.innerText || modal.textContent || "");
    const title = compact(modal.querySelector(".qccd-modal-title,.modal-title")?.innerText || "");
    const gated = /成为VIP|开通VIP|会员解锁|升级会员|购买套餐|暂无权限/.test(text);
    const hasTable = Boolean(modal.querySelector("table"));
    if (gated || hasTable) return { opened: true, title, text, gated, hasTable };
    return null;
  }, [label], timeoutMs);
}

async function extractRiskTable(page, kind) {
  const allRows = [];
  const seenPages = new Set();
  let tableFound = false;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const pageResult = await page.evaluate((tableKind) => {
    const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => Boolean(element && element.offsetParent !== null);
    const modal = Array.from(document.querySelectorAll("[role='dialog'], .modal, .qccd-modal, .ant-modal, .el-dialog"))
      .filter(visible)
      .sort((a, b) => (b.innerText || "").length - (a.innerText || "").length)[0];
    const root = modal || document;
    const tables = Array.from(root.querySelectorAll("table")).filter(visible);
    const keywords = tableKind === "enforcement"
      ? ["被执行人", "执行标的", "立案日期"]
      : ["案件名称", "案件身份", "最新案件进程"];
    const table = tables
      .map((candidate) => ({ candidate, text: compact(candidate.innerText || candidate.textContent || "") }))
      .filter((item) => keywords.filter((keyword) => item.text.includes(keyword)).length >= 2)
      .sort((a, b) => b.text.length - a.text.length)[0]?.candidate;
    if (!table) return { rows: [], next: false, tableFound: false };
    const tableRows = Array.from(table.querySelectorAll("tr")).filter(visible);
    const explicitHeaders = Array.from(table.querySelectorAll("thead th, thead td"))
      .map((cell) => compact(cell.innerText || cell.textContent || ""));
    const firstRowCells = Array.from(tableRows[0]?.querySelectorAll("th,td") || [])
      .map((cell) => compact(cell.innerText || cell.textContent || ""));
    const firstRowIsHeader = Boolean(tableRows[0]?.querySelector("th"));
    const headers = explicitHeaders.length ? explicitHeaders : firstRowCells;
    const dataRows = explicitHeaders.length
      ? tableRows.filter((row) => !row.closest("thead"))
      : tableRows.slice(firstRowIsHeader ? 1 : 0);
    const rows = dataRows.map((row) => {
      const cells = Array.from(row.querySelectorAll("td,th"))
        .map((cell) => compact(cell.innerText || cell.textContent || ""));
      const record = {};
      cells.forEach((value, index) => { record[headers[index] || `列${index + 1}`] = value; });
      return record;
    }).filter((record) => Object.values(record).some(Boolean));
    const signature = rows.map((record) => Object.values(record).join("|")).join("\n");
    const nextButton = Array.from(root.querySelectorAll("button,a,[role='button'],li"))
      .filter(visible)
      .find((element) => /下一页|下页|next|›|»/i.test(String(
        element.innerText
        || element.getAttribute("aria-label")
        || element.getAttribute("title")
        || element.className
        || "",
      ))
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true"
        && !element.classList.contains("disabled"));
    if (!nextButton) return { rows, next: false, signature, tableFound: true };
    const nextRect = nextButton.getBoundingClientRect();
    return {
      rows,
      next: true,
      nextPoint: { x: nextRect.left + nextRect.width / 2, y: nextRect.top + nextRect.height / 2 },
      signature,
      tableFound: true,
    };
  }, kind);
    if (!pageResult || !Array.isArray(pageResult.rows)) break;
    tableFound ||= Boolean(pageResult.tableFound);
    if (pageResult.signature && seenPages.has(pageResult.signature)) break;
    if (pageResult.signature) seenPages.add(pageResult.signature);
    allRows.push(...pageResult.rows);
    if (!pageResult.next) break;
    if (pageResult.nextPoint) {
      await page.clickAt(pageResult.nextPoint.x, pageResult.nextPoint.y);
    }
    await sleep(700);
  }
  return { records: allRows, tableFound };
}

async function closeRiskModal(page) {
  const closedModal = await page.evaluate(() => {
    const visible = (element) => Boolean(element && element.offsetParent !== null);
    const buttons = Array.from(document.querySelectorAll("button,[role='button'],[aria-label='Close'],.close,.qccd-modal-close,.ant-modal-close"))
      .filter(visible)
      .filter((element) => /关闭|返回|取消|close|×|✕/i.test(String(element.innerText || element.getAttribute("aria-label") || element.className || "")));
    const button = buttons[buttons.length - 1];
    if (!button) return false;
    button.click();
    return true;
  });
  await waitForPageValue(page, () => {
    const visible = (element) => Boolean(element && element.getClientRects().length);
    return Array.from(document.querySelectorAll("[role='dialog'],.qccd-modal-wrap,.qccd-modal"))
      .every((element) => !visible(element));
  }, [], 3000, 100);
  await sleep(closedModal ? 1800 : 150);
}

function parseDateValue(value) {
  const match = String(value || "").match(/(20\d{2})[-./年](\d{1,2})[-./月](\d{1,2})/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function recentDate(date, scannedAt, windowDays = RECENT_DAYS) {
  if (!date) return false;
  const dayNumber = (value) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / (24 * 60 * 60 * 1000);
  const ageInCalendarDays = dayNumber(scannedAt) - dayNumber(date);
  return ageInCalendarDays >= 0 && ageInCalendarDays < windowDays;
}

function numberFromText(value) {
  const match = String(value || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function amountToYuan(value) {
  const text = String(value || "");
  const amount = numberFromText(text);
  if (/亿/.test(text)) return Math.round(amount * 100000000);
  if (/万/.test(text)) return Math.round(amount * 10000);
  if (/千/.test(text)) return Math.round(amount * 1000);
  return Math.round(amount);
}

function normalizeEnforcementRecords(records) {
  return records.map((record) => {
    const entries = Object.entries(record);
    const get = (...names) => entries.find(([key]) => names.some((name) => key.includes(name)))?.[1] || "";
    const filingDate = get("立案日期", "立案");
    return {
      caseNumber: get("案号"), person: get("被执行人"), amountYuan: amountToYuan(get("执行标的")),
      amountText: get("执行标的"), court: get("执行法院", "法院"), filingDate, eventDate: filingDate,
    };
  });
}

function normalizeCommercialRecords(records) {
  return records.map((record) => {
    const entries = Object.entries(record);
    const get = (...names) => entries.find(([key]) => names.some((name) => key.includes(name)))?.[1] || "";
    const latestProgress = get("最新案件进程", "案件进程");
    const eventDate = (latestProgress.match(/20\d{2}[-./年]\d{1,2}[-./月]\d{1,2}/) || [""])[0];
    return {
      caseName: get("案件名称"), identity: get("案件身份"), caseNumber: get("案号"),
      caseAmount: get("案件金额"), latestProgress, court: get("法院"), eventDate, eventDateSource: "最新案件进程",
    };
  });
}

function createDetailRiskResult() {
  return {
    scannedAt: nowText(),
    recentWindowDays: RECENT_DAYS,
    threeMonthWindowDays: THREE_MONTH_DAYS,
    enforcement: {
      available: false,
      totalCount: 0,
      recentCount: 0,
      threeMonthCount: 0,
      totalAmountYuan: 0,
      recentAmountYuan: 0,
      records: [],
    },
    commercialDefendant: { available: false, totalCount: 0, recentCount: 0, records: [] },
    errors: [],
  };
}

function finalizeDetailRiskResult(result) {
  result.recentEnforcementCount = result.enforcement.available ? result.enforcement.recentCount : null;
  result.threeMonthEnforcementCount = result.enforcement.available ? result.enforcement.threeMonthCount : null;
  result.recentCommercialDefendantCount = result.commercialDefendant.available
    ? result.commercialDefendant.recentCount
    : null;
  return result;
}

function createEmptyDetailRisks() {
  const result = createDetailRiskResult();
  result.enforcement.available = true;
  result.commercialDefendant.available = true;
  result.skippedBecauseOwnRiskIsZero = true;
  return finalizeDetailRiskResult(result);
}

async function detailRiskError(page, label, error) {
  const access = await readRiskAccessState(page);
  if (access.hasVipGate) {
    return `当前企查查账号无权查看“${label}”明细`;
  }
  return error.message || String(error);
}

async function extractRecentDetailRisks(page) {
  const scannedAt = new Date();
  const result = createDetailRiskResult();

  await closeRiskModal(page);
  try {
    const category = await clickRiskCategory(page, "被执行人", 10000);
    if (category.count === 0) {
      result.enforcement.available = true;
    } else {
      const modalState = await waitForRiskModal(page, "被执行人", 10000);
      if (!modalState) throw new Error("点击“被执行人”后未打开明细窗口");
      if (modalState.gated) throw new Error("被执行人明细需要会员权限");
      const enforcementTable = await extractRiskTable(page, "enforcement");
      if (!enforcementTable.tableFound) {
        throw new Error("被执行人栏目存在记录，但未找到正式明细表格");
      }
      const enforcementRecords = normalizeEnforcementRecords(enforcementTable.records)
        .filter((record) => record.caseNumber || record.person || record.filingDate);
      result.enforcement.available = true;
      result.enforcement.records = enforcementRecords;
      result.enforcement.totalCount = Number.isFinite(category.count)
        ? category.count
        : enforcementRecords.length;
      if (result.enforcement.totalCount > enforcementRecords.length) {
        result.errors.push(`被执行人共有 ${result.enforcement.totalCount} 条，但只读取到 ${enforcementRecords.length} 条明细`);
      }
      for (const record of enforcementRecords) {
        const date = parseDateValue(record.eventDate);
        result.enforcement.totalAmountYuan += record.amountYuan;
        if (recentDate(date, scannedAt)) {
          result.enforcement.recentCount += 1;
          result.enforcement.recentAmountYuan += record.amountYuan;
        }
        if (recentDate(date, scannedAt, THREE_MONTH_DAYS)) {
          result.enforcement.threeMonthCount += 1;
        }
      }
    }
  } catch (error) {
    result.errors.push(await detailRiskError(page, "被执行人", error));
  } finally {
    await closeRiskModal(page);
  }

  try {
    const category = await clickRiskCategory(page, "商业合作纠纷（被告）", 10000);
    if (category.count === 0) {
      result.commercialDefendant.available = true;
    } else {
      const modalState = await waitForRiskModal(page, "商业合作纠纷（被告）", 10000);
      if (!modalState) throw new Error("点击“商业合作纠纷（被告）”后未打开明细窗口");
      if (modalState.gated) throw new Error("商业合作纠纷（被告）明细需要会员权限");
      const commercialTable = await extractRiskTable(page, "commercial");
      if (!commercialTable.tableFound) {
        throw new Error("商业合作纠纷（被告）栏目存在记录，但未找到明细表格");
      }
      const commercialRecords = normalizeCommercialRecords(commercialTable.records)
        .filter((record) => record.caseName || record.caseNumber || record.latestProgress);
      result.commercialDefendant.available = true;
      result.commercialDefendant.records = commercialRecords;
      result.commercialDefendant.totalCount = Number.isFinite(category.count)
        ? category.count
        : commercialRecords.length;
      if (result.commercialDefendant.totalCount > commercialRecords.length) {
        result.errors.push(`商业合作纠纷（被告）共有 ${result.commercialDefendant.totalCount} 条，但只读取到 ${commercialRecords.length} 条明细`);
      }
      result.commercialDefendant.recentCount = commercialRecords
        .filter((record) => recentDate(parseDateValue(record.eventDate), scannedAt)).length;
    }
  } catch (error) {
    result.errors.push(await detailRiskError(page, "商业合作纠纷（被告）", error));
  } finally {
    await closeRiskModal(page);
  }

  return finalizeDetailRiskResult(result);
}

function applyRules(snapshot, rules) {
  const metrics = { ...(snapshot.data || {}) };
  metrics["自身风险重要"] = metrics["自身风险_重要"] ?? 0;
  metrics["近30天被执行人数"] = snapshot.detailRisks?.recentEnforcementCount ?? null;
  metrics["近90天被执行人数"] = snapshot.detailRisks?.threeMonthEnforcementCount ?? null;
  metrics["近30天商业合作纠纷（被告）数"] = snapshot.detailRisks?.recentCommercialDefendantCount ?? null;

  const triggered = [];
  for (const rule of rules.thresholds) {
    const value = metrics[rule.field];
    if (value == null) {
      continue;
    }

    const gte = Number(rule.gte ?? 1);
    if (value >= gte) {
      triggered.push({
        field: rule.field,
        value,
        level: rule.level,
        message: formatRuleMessage(rule, value),
      });
    }
  }

  const order = new Map(rules.severityOrder.map((level, index) => [level, index]));
  const highest = triggered.reduce((best, item) => {
    const bestRank = order.get(best) ?? -1;
    const itemRank = order.get(item.level) ?? -1;
    return itemRank > bestRank ? item.level : best;
  }, rules.normalLevel);

  const warningSummary = [...new Set(triggered.map((item) => item.message))].join("；");
  return {
    level: highest,
    warningSummary: warningSummary || rules.normalMessage || "未触发预警规则",
    triggered,
  };
}

function formatRuleMessage(rule, value) {
  return String(rule.message || `${rule.field} 达到 ${value}`)
    .replaceAll("{field}", rule.field)
    .replaceAll("{value}", String(value))
    .replaceAll("{gte}", String(rule.gte ?? ""));
}

function rowFromResult(company, detail, snapshot, decision, error = "") {
  const data = snapshot?.data || {};
  const detailRisks = snapshot?.detailRisks || {};
  const enforcement = detailRisks.enforcement || {};
  const commercial = detailRisks.commercialDefendant || {};
  const partialError = Array.isArray(detailRisks.errors) ? detailRisks.errors.filter(Boolean).join("；") : "";
  const errorMessage = error || partialError;
  return {
    "公司名称": company,
    "状态": error ? "失败" : partialError ? "部分成功" : "成功",
    "预警等级": decision?.level || "",
    "预警摘要": decision?.warningSummary || "",
    "匹配公司": snapshot?.companyFromTitle || detail?.matchedCompany || "",
    "企查查链接": snapshot?.url || detail?.url || "",
    "企查分": snapshot?.qccScore ?? "",
    "自身风险": data["自身风险"] ?? "",
    "自身风险_重要": data["自身风险_重要"] ?? "",
    "被执行人总数": enforcement.available ? enforcement.totalCount ?? 0 : "",
    "近30天被执行人数": enforcement.available ? enforcement.recentCount ?? 0 : "",
    "近90天被执行人数": enforcement.available ? enforcement.threeMonthCount ?? 0 : "",
    "被执行金额总额(元)": enforcement.available ? enforcement.totalAmountYuan ?? 0 : "",
    "近30天被执行金额(元)": enforcement.available ? enforcement.recentAmountYuan ?? 0 : "",
    "商业合作纠纷（被告）总数": commercial.available ? commercial.totalCount ?? 0 : "",
    "近30天商业合作纠纷（被告）数": commercial.available ? commercial.recentCount ?? 0 : "",
    "近30天最新风险日期": [
      ...(enforcement.records || []).map((item) => item.eventDate),
      ...(commercial.records || []).map((item) => item.eventDate),
    ].filter(Boolean).sort().at(-1) || "",
    "被执行人明细JSON": JSON.stringify(enforcement.records || []),
    "商业合作纠纷（被告）明细JSON": JSON.stringify(commercial.records || []),
    "关联风险": data["关联风险"] ?? "",
    "历史信息": data["历史信息"] ?? "",
    "提示信息": data["提示信息"] ?? "",
    "深度风险分析": data["深度风险分析"] ?? "",
    "债务/债权": data["债务/债权"] ?? "",
    "风险关系": data["风险关系"] ?? "",
    "合同违约": data["合同违约"] ?? "",
    "竞争风险": data["竞争风险"] ?? "",
    "合作风险": data["合作风险"] ?? "",
    "错误信息": errorMessage,
    "检查时间": nowText(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (!Number.isFinite(args.port) || args.port <= 0) {
    throw new Error("--port 必须是有效端口号");
  }

  const browserWsUrl = await startOrConnectBrowser(args);
  const client = new CdpClient(browserWsUrl);
  await client.connect();
  const page = await createPage(client);

  if (args.login) {
    await page.navigate(QCC_HOME);
    if (args.autoConfirmLogin) {
      await waitForLoginCompletion(page, "登录流程");
    } else {
      await askEnter("请在打开的浏览器中完成企查查会员账号登录。登录成功后当前浏览器配置会保存在 profile-dir。");
    }
    await client.close();
    console.log("登录流程结束。后续批量采集会复用该登录态。");
    return;
  }

  if (!args.assumeLoggedIn && args.manual) {
    await page.navigate(QCC_HOME);
    if (args.autoConfirmLogin) {
      await waitForLoginCompletion(page, "扫描前登录检查");
    } else {
      await askEnter("请确认浏览器中企查查会员账号已经登录。");
    }
  }

  const companies = parseCompanies(args.input);
  if (!companies.length) {
    throw new Error(`公司名单为空: ${args.input}`);
  }

  const rules = loadRules(args.rules);
  const selectedCompanies = args.limit > 0 ? companies.slice(0, args.limit) : companies;
  const rows = [];

  console.log(`开始处理 ${selectedCompanies.length} 家公司。`);

  for (let i = 0; i < selectedCompanies.length; i += 1) {
    const company = selectedCompanies[i];
    console.log(`[${i + 1}/${selectedCompanies.length}] ${company}`);
    let detail = null;
    let snapshot = null;
    let decision = null;
    let riskContext = null;

    try {
      detail = await openCompanyDetail(page, company, args);
      const companyPage = detail.page || page;
      snapshot = await extractRiskSnapshot(companyPage);
      const ownRiskCount = snapshot.data?.["自身风险"];
      if (ownRiskCount === 0) {
        console.log("  自身风险为 0，跳过风险页和明细点击，直接按无近期风险处理");
        snapshot.detailRisks = createEmptyDetailRisks();
      } else if (Number.isFinite(ownRiskCount) && ownRiskCount > 0) {
        riskContext = await openOwnRiskPage(client, companyPage, detail.url || snapshot.url);
        snapshot.detailRisks = await extractRecentDetailRisks(riskContext.page);
      } else {
        throw new Error("未能读取“自身风险”数量，不能判定该公司无风险");
      }
      decision = applyRules(snapshot, rules);
      const detailErrors = snapshot.detailRisks.errors || [];
      if (detailErrors.length && !decision.triggered.length) {
        throw new Error(detailErrors.join("；"));
      }
      rows.push(rowFromResult(company, detail, snapshot, decision));
      console.log(`  ${decision.level}: ${decision.warningSummary}${detailErrors.length ? `（部分数据未核验：${detailErrors.join("；")}）` : ""}`);
    } catch (error) {
      const reliableDecision = decision?.triggered?.length ? decision : null;
      rows.push(rowFromResult(company, detail, snapshot, reliableDecision, error.message || String(error)));
      console.log(`  失败: ${error.message || error}`);
    } finally {
      if (riskContext?.openedNew && riskContext.targetId) {
        try {
          await client.send("Target.closeTarget", { targetId: riskContext.targetId });
        } catch {
          // The user may have already closed the temporary risk tab.
        }
      }
      if (detail?.openedNew && detail.targetId) {
        try {
          await client.send("Target.closeTarget", { targetId: detail.targetId });
          await page.activate();
        } catch {
          // The user may have already closed the manually selected company tab.
        }
      }
    }

    writeCsv(args.output, rows);
    if (i < selectedCompanies.length - 1) {
      const delayMs = randomDelayMs(args.delayMinMs, args.delayMaxMs);
      if (delayMs > 0) {
        console.log(`  随机等待 ${(delayMs / 1000).toFixed(3)} 秒后继续下一家公司...`);
      }
      await sleep(delayMs);
    }
  }

  await client.close();
  console.log(`完成，结果已写入: ${args.output}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
