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
const QCC_HOME = "https://www.qcc.com/";
const QCC_SEARCH = "https://www.qcc.com/web/search?key=";

const RISK_LABELS = [
  "自身风险",
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
    rules: join(SCRIPT_DIR, "risk-rules.json"),
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
  constructor(client, sessionId) {
    this.client = client;
    this.sessionId = sessionId;
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
}

async function createPage(client) {
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });

  const page = new BrowserPage(client, sessionId);
  await page.init();
  return page;
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
  return String(process.env.QCC_RISK_PYTHON || "python").trim() || "python";
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
    .replace(/[()（）]/g, "")
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

async function openCompanyDetail(page, company, args) {
  const searchUrl = `${QCC_SEARCH}${encodeURIComponent(company)}`;
  await page.navigate(searchUrl);
  await maybeManualIntervention(page, args, `${company} 搜索页`);

  const current = await page.currentUrl();
  if (/\/firm\//i.test(current)) {
    return { url: current, matchedCompany: company };
  }

  const found = await page.evaluate((companyName) => {
    const normalize = (value) => String(value || "")
      .replace(/\s+/g, "")
      .replace(/[()（）]/g, "")
      .trim();
    const target = normalize(companyName);
    const anchors = Array.from(document.querySelectorAll("a[href]"));

    const candidates = anchors
      .map((anchor, index) => {
        const href = new URL(anchor.getAttribute("href"), location.href).href;
        const text = normalize(anchor.innerText || anchor.textContent || anchor.title || "");
        let score = 0;
        if (/\/firm\//i.test(href)) score += 30;
        if (text === target) score += 100;
        else if (text.includes(target)) score += 80;
        else if (target.includes(text) && text.length >= 4) score += 40;
        return {
          index,
          href,
          text: anchor.innerText || anchor.textContent || anchor.title || "",
          score,
        };
      })
      .filter((item) => item.score >= 50)
      .sort((a, b) => b.score - a.score || a.index - b.index);

    return candidates[0] || null;
  }, company);

  if (found?.href) {
    await page.navigate(found.href);
    await maybeManualIntervention(page, args, `${company} 详情页`);
    return {
      url: await page.currentUrl(),
      matchedCompany: found.text.trim() || company,
    };
  }

  if (args.manual) {
    await askEnter(`${company}: 没有自动找到企业详情链接。请在浏览器里手动点进正确企业详情页。`);
    await sleep(1500);
    return {
      url: await page.currentUrl(),
      matchedCompany: company,
    };
  }

  throw new Error("搜索页没有找到匹配的企业详情链接");
}

async function extractRiskSnapshot(page) {
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
    if (hits < Math.min(4, riskLabels.length)) {
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

function applyRules(snapshot, rules) {
  const metrics = { ...(snapshot.data || {}) };
  metrics["自身风险重要"] = metrics["自身风险_重要"] ?? 0;

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
  return {
    "公司名称": company,
    "状态": error ? "失败" : "成功",
    "预警等级": decision?.level || "",
    "预警摘要": decision?.warningSummary || "",
    "匹配公司": snapshot?.companyFromTitle || detail?.matchedCompany || "",
    "企查查链接": snapshot?.url || detail?.url || "",
    "企查分": snapshot?.qccScore ?? "",
    "自身风险": data["自身风险"] ?? "",
    "自身风险_重要": data["自身风险_重要"] ?? "",
    "错误信息": error,
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

    try {
      console.log("  正在查询并打开企业详情页...");
      const detail = await openCompanyDetail(page, company, args);
      console.log("  企业详情页已打开，正在读取风险概览...");
      const snapshot = await extractRiskSnapshot(page);
      console.log("  风险概览读取完成，正在应用预警规则...");
      const decision = applyRules(snapshot, rules);
      rows.push(rowFromResult(company, detail, snapshot, decision));
      console.log(`  ${decision.level}: ${decision.warningSummary}`);
    } catch (error) {
      rows.push(rowFromResult(company, null, null, null, error.message || String(error)));
      console.log(`  失败: ${error.message || error}`);
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
