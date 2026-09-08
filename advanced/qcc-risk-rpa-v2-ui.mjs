import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createV2RiskBatch,
  fetchPendingCompanyNames,
  normalizeBackendUrl,
  pushV2RiskBatch,
} from "./risk-integration.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(SCRIPT_DIR, "ui");
const LOGO_DIR = join(SCRIPT_DIR, "logo");
const CLI_SCRIPT = join(SCRIPT_DIR, "qcc-risk-rpa-v2.mjs");
const EXCEL_HELPER = join(SCRIPT_DIR, "extract-excel-companies.py");
const DATA_DIR = join(SCRIPT_DIR, "data");
const COMPANY_LISTS_DIR = join(DATA_DIR, "company-lists");
const COMPANY_UPLOADS_DIR = join(COMPANY_LISTS_DIR, "uploads");
const RESULTS_DIR = join(DATA_DIR, "results");
const UI_SERVER_PID_FILE = join(SCRIPT_DIR, "runtime", "ui-server.pid");
const COMPANIES_FILE = join(COMPANY_LISTS_DIR, "companies.csv");
const RULES_FILE = join(SCRIPT_DIR, "risk-rules-v2.json");
const BACKEND_CONFIG_EXAMPLE_FILE = join(SCRIPT_DIR, "backend-environments.example.json");
const BACKEND_CONFIG_LOCAL_FILE = join(SCRIPT_DIR, "backend-environments.local.json");
const BACKEND_ENVIRONMENTS_FILE = resolveBackendConfigFile();
const DEFAULT_FETCH_ENDPOINT = {
  enabled: true,
  method: "GET",
  path: "/api/risk-scan/companies",
  monthQueryParam: "month",
};
const DEFAULT_PUSH_ENDPOINT = {
  enabled: true,
  method: "POST",
  path: "/api/risk-scan/records",
};
const BACKEND_CONFIG = loadBackendConfig();

for (const directory of [COMPANY_LISTS_DIR, COMPANY_UPLOADS_DIR, RESULTS_DIR]) {
  mkdirSync(directory, { recursive: true });
}

const args = parseServerArgs(process.argv.slice(2));
const clients = new Set();
const logs = [];
const maxLogs = 500;

let activeSession = null;

function parseServerArgs(argv) {
  const parsed = {
    host: "127.0.0.1",
    port: 18081,
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

    if (key === "--host") {
      parsed.host = next();
    } else if (key === "--port") {
      parsed.port = Number(next());
    } else if (key === "--help" || key === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`未知参数: ${key}`);
    }
  }

  return parsed;
}

function usage() {
  console.log(`
企查查风险扫描可视化控制台

用法:
  node qcc-risk-rpa-v2-ui.mjs
  node qcc-risk-rpa-v2-ui.mjs --port 18081
`);
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

function resolveBackendConfigFile() {
  const configuredPath = String(process.env.QCC_RISK_BACKEND_CONFIG || "").trim();
  if (configuredPath) {
    return resolve(SCRIPT_DIR, configuredPath);
  }
  return existsSync(BACKEND_CONFIG_LOCAL_FILE)
    ? BACKEND_CONFIG_LOCAL_FILE
    : BACKEND_CONFIG_EXAMPLE_FILE;
}

function loadBackendConfig() {
  const parsed = JSON.parse(readFileSync(BACKEND_ENVIRONMENTS_FILE, "utf8"));
  const environments = Array.isArray(parsed.environments)
    ? parsed.environments.map((item) => normalizeBackendEnvironment(item))
    : [];
  if (!environments.length) {
    throw new Error("后端环境配置不能为空");
  }

  const keys = new Set();
  for (const environment of environments) {
    if (keys.has(environment.key)) {
      throw new Error(`后端环境配置存在重复标识: ${environment.key}`);
    }
    keys.add(environment.key);
  }

  const defaultEnvironment = String(parsed.defaultEnvironment || "").trim();
  if (!keys.has(defaultEnvironment)) {
    throw new Error("默认后端环境不存在");
  }

  return { defaultEnvironment, environments };
}

function normalizeBackendEnvironment(value) {
  const key = String(value?.key || "").trim();
  const name = String(value?.name || "").trim();
  const rawUrl = String(value?.baseUrl || value?.url || "").trim();
  if (!/^[a-z][a-z0-9_-]*$/i.test(key) || !name) {
    throw new Error("后端环境标识或名称配置错误");
  }
  if (!rawUrl) {
    throw new Error(`后端环境 ${name} 缺少服务地址`);
  }
  const url = normalizeBackendUrl(rawUrl);

  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error(`后端环境 ${name} 只允许使用 HTTP 或 HTTPS`);
  }

  return {
    key,
    name,
    url,
    production: Boolean(value?.production),
    endpoints: {
      fetchCompanies: normalizeEndpoint(
        value?.endpoints?.fetchCompanies,
        DEFAULT_FETCH_ENDPOINT,
        `${name} / fetchCompanies`,
      ),
      pushResults: normalizeEndpoint(
        value?.endpoints?.pushResults,
        DEFAULT_PUSH_ENDPOINT,
        `${name} / pushResults`,
      ),
    },
  };
}

function normalizeEndpoint(value, defaults, label) {
  const endpoint = value && typeof value === "object" ? value : {};
  const enabled = endpoint.enabled !== false;
  const path = String(endpoint.path || defaults.path).trim();
  if (enabled && !path) {
    throw new Error(`${label} 缺少接口路径`);
  }

  const rawHeaders = endpoint.headers && typeof endpoint.headers === "object"
    ? endpoint.headers
    : {};
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).map(([header, headerValue]) => [
      String(header).trim(),
      expandEnvironmentVariables(headerValue, `${label} 请求头 ${header}`),
    ]).filter(([header]) => header),
  );
  const rawTimeout = Number(endpoint.timeoutMs);

  return {
    enabled,
    method: String(endpoint.method || defaults.method).trim().toUpperCase(),
    path,
    monthQueryParam: String(endpoint.monthQueryParam ?? defaults.monthQueryParam ?? "").trim(),
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : 10000,
    headers,
  };
}

function expandEnvironmentVariables(value, label) {
  return String(value ?? "").replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, variableName) => {
    const replacement = process.env[variableName];
    if (replacement == null) {
      throw new Error(`${label} 引用了未设置的环境变量 ${variableName}`);
    }
    return replacement;
  });
}

function getBackendEnvironment(key) {
  const normalizedKey = String(key || BACKEND_CONFIG.defaultEnvironment).trim();
  const environment = BACKEND_CONFIG.environments.find((item) => item.key === normalizedKey);
  if (!environment) {
    throw new Error("所选后端环境不存在");
  }
  return environment;
}

function publicBackendConfig() {
  return {
    defaultEnvironment: BACKEND_CONFIG.defaultEnvironment,
    environments: BACKEND_CONFIG.environments.map(publicBackendEnvironment),
  };
}

function publicBackendEnvironment(environment) {
  return {
    key: environment.key,
    name: environment.name,
    url: environment.url,
    production: environment.production,
    endpoints: {
      fetchCompanies: publicEndpoint(environment.endpoints.fetchCompanies),
      pushResults: publicEndpoint(environment.endpoints.pushResults),
    },
  };
}

function publicEndpoint(endpoint) {
  return {
    enabled: endpoint.enabled,
    method: endpoint.method,
    path: endpoint.path,
    monthQueryParam: endpoint.monthQueryParam,
    timeoutMs: endpoint.timeoutMs,
    hasCustomHeaders: Object.keys(endpoint.headers).length > 0,
  };
}

function addLog(kind, message) {
  const entry = {
    id: randomUUID(),
    time: nowText(),
    kind,
    message: String(message || ""),
  };
  logs.push(entry);
  while (logs.length > maxLogs) {
    logs.shift();
  }
  broadcast("log", entry);
}

function broadcast(event, payload) {
  const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of clients) {
    response.write(body);
  }
}

function sessionSummary() {
  if (!activeSession) {
    return { running: false };
  }

  return {
    id: activeSession.id,
    kind: activeSession.kind,
    running: activeSession.running,
    status: activeSession.status,
    startedAt: activeSession.startedAt,
    endedAt: activeSession.endedAt || "",
    exitCode: activeSession.exitCode,
    outputFile: activeSession.outputFile ? basename(activeSession.outputFile) : "",
    bizMonth: activeSession.bizMonth || "",
    backendEnvironment: activeSession.backendEnvironment
      ? publicBackendEnvironment(activeSession.backendEnvironment)
      : null,
    progressCurrent: activeSession.progressCurrent || 0,
    progressTotal: activeSession.progressTotal || 0,
    progressPercent: activeSession.progressPercent || 0,
    riskPushStatus: activeSession.riskPushStatus || "",
    riskPushCount: activeSession.riskPushCount || 0,
    riskPushError: activeSession.riskPushError || "",
    riskPushFullSnapshot: Boolean(activeSession.riskPushPayload?.fullSnapshot),
    scannedCompanyCount: activeSession.riskPushPayload?.scannedCompanyCount || 0,
    failedCompanyCount: activeSession.riskPushPayload?.failedCompanyCount || 0,
    successfulCompanyCount: activeSession.riskPushPayload?.successfulCompanyCount || 0,
    partialCompanyCount: activeSession.riskPushPayload?.partialCompanyCount || 0,
    publishableCompanyCount: activeSession.riskPushPayload?.publishableCompanyCount || 0,
    awaitingContinue: Boolean(activeSession.awaitingContinue),
  };
}

function isRunning() {
  return Boolean(activeSession?.running && activeSession?.child);
}

function spawnCli(kind, cliArgs, options = {}) {
  if (isRunning()) {
    throw new Error("当前已有任务在运行，请先停止或等待完成。");
  }

  const child = spawn(process.execPath, [CLI_SCRIPT, ...cliArgs], {
    cwd: SCRIPT_DIR,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const session = {
    id: randomUUID(),
    kind,
    child,
    running: true,
    status: "running",
    startedAt: nowText(),
    endedAt: "",
    exitCode: null,
    outputFile: options.outputFile || "",
    bizMonth: options.bizMonth || "",
    backendEnvironment: options.backendEnvironment || null,
    expectedCompanyCount: options.expectedCompanyCount || 0,
    usedLimit: Boolean(options.usedLimit),
    progressCurrent: 0,
    progressTotal: options.progressTotal || 0,
    progressPercent: 0,
    progressBuffer: "",
    continuePromptBuffer: "",
    awaitingContinue: false,
    riskPushStatus: kind === "scan" ? "pending" : "",
    riskPushCount: 0,
    riskPushError: "",
    riskPushPayload: null,
  };
  activeSession = session;

  addLog("system", `${kind === "login" ? "登录流程" : "扫描任务"}已启动。`);
  addLog("system", `命令参数: ${cliArgs.join(" ")}`);
  broadcast("state", sessionSummary());

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    addLog("stdout", chunk);
    updateScanProgress(session, chunk);
    session.continuePromptBuffer = `${session.continuePromptBuffer}${chunk}`.slice(-300);
    if (session.continuePromptBuffer.includes("按 Enter 继续...")) {
      session.awaitingContinue = true;
      session.continuePromptBuffer = "";
      if (activeSession === session) {
        broadcast("state", sessionSummary());
      }
    }
  });
  child.stderr.on("data", (chunk) => addLog("stderr", chunk));

  child.on("exit", (code, signal) => {
    void finishSession(session, code, signal);
  });

  child.on("error", (error) => {
    session.running = false;
    session.status = "failed";
    session.endedAt = nowText();
    session.child = null;
    addLog("stderr", error.message);
    if (activeSession === session) {
      broadcast("state", sessionSummary());
    }
  });

  return sessionSummary();
}

async function finishSession(session, code, signal) {
  session.running = false;
  session.awaitingContinue = false;
  session.status = code === 0 ? "done" : "failed";
  session.exitCode = code;
  session.signal = signal || "";
  session.endedAt = nowText();
  session.child = null;
  if (session.kind === "scan" && code === 0) {
    session.progressCurrent = session.progressTotal;
    session.progressPercent = 100;
  }

  if (code === 0) {
    addLog("system", "任务已完成。");
  } else {
    addLog("system", `任务结束，退出码 ${code ?? "null"}${signal ? `，信号 ${signal}` : ""}。`);
  }

  if (session.kind === "scan" && code === 0) {
    try {
      prepareMajorRiskReviewForSession(session);
    } catch (error) {
      session.riskPushStatus = "failed";
      session.riskPushError = error.message || String(error);
      trySaveRiskPushState(session, 0);
      addLog("stderr", `风险结果审核数据准备失败：${session.riskPushError}`);
    }
  }

  if (activeSession === session) {
    broadcast("results", readLatestResults());
    broadcast("state", sessionSummary());
  }
}

function updateScanProgress(session, chunk) {
  if (session.kind !== "scan") return;

  const combined = `${session.progressBuffer || ""}${String(chunk || "")}`;
  const matches = [...combined.matchAll(/\[(\d+)\/(\d+)\]/g)];
  const latest = matches[matches.length - 1];
  const lastLineBreak = Math.max(combined.lastIndexOf("\n"), combined.lastIndexOf("\r"));
  session.progressBuffer = (lastLineBreak >= 0 ? combined.slice(lastLineBreak + 1) : combined).slice(-256);

  if (!latest) return;
  const current = Number(latest[1]);
  const total = Number(latest[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return;
  if (session.progressCurrent === current && session.progressTotal === total) return;

  session.progressCurrent = Math.min(current, total);
  session.progressTotal = total;
  session.progressPercent = Math.min(96, Math.round((session.progressCurrent / total) * 100));
  if (activeSession === session) {
    broadcast("state", sessionSummary());
  }
}

function prepareMajorRiskReviewForSession(session) {
  const results = readLatestResults(basename(session.outputFile || ""));
  const payload = createV2RiskBatch({
    rows: results.rows,
    scanBatchId: session.id,
    bizMonth: session.bizMonth,
    sourceFile: results.selectedFile,
    expectedCompanyCount: session.expectedCompanyCount,
    usedLimit: session.usedLimit,
  });
  session.riskPushPayload = payload;
  session.riskPushCount = payload.records.filter((record) => record.riskLevel !== "正常").length;
  const pushEnabled = session.backendEnvironment?.endpoints?.pushResults?.enabled !== false;
  session.riskPushStatus = pushEnabled ? "awaiting_confirmation" : "local_only";
  session.riskPushError = "";
  trySaveRiskPushState(session, 0);
  if (!pushEnabled) {
    addLog("system", "扫描结果已保存到本地；当前环境未启用结果回传接口。");
    return;
  }
  addLog(
    "system",
    payload.records.length
      ? `V2 扫描结果待确认，共 ${payload.records.length} 家结果可回传，其中 ${session.riskPushCount} 家存在当前风险，${payload.failedCompanyCount} 家未完整核验。`
      : payload.failedCompanyCount
        ? `V2 扫描结束，但 ${payload.failedCompanyCount} 家公司均未完整核验，不能判定为无风险。`
        : "V2 扫描结果待确认，本次没有成功扫描公司。",
  );
}

async function confirmRiskPush(sessionId) {
  const session = activeSession;
  if (!session || session.kind !== "scan" || session.id !== String(sessionId || "").trim()) {
    throw new Error("待回传扫描会话不存在或已失效");
  }
  if (session.running || session.status !== "done") {
    throw new Error("扫描任务尚未完成，不能回传风险");
  }
  if (session.backendEnvironment?.endpoints?.pushResults?.enabled === false) {
    throw new Error("当前环境未启用结果回传接口");
  }
  if (session.riskPushStatus === "pushing") {
    throw new Error("风险结果正在回传，请勿重复提交");
  }
  if (session.riskPushStatus === "success") {
    throw new Error("该扫描结果已经回传成功，请勿重复提交");
  }
  if (!session.riskPushPayload) {
    throw new Error("待回传数据不存在，请重新执行扫描");
  }
  if (!['awaiting_confirmation', 'failed'].includes(session.riskPushStatus)) {
    throw new Error("当前扫描结果不处于可回传状态");
  }

  await pushMajorRisksForSession(session);
  return sessionSummary();
}

async function pushMajorRisksForSession(session) {
  const payload = session.riskPushPayload;
  if (!payload) {
    throw new Error("待回传数据不存在");
  }

  session.riskPushStatus = "pushing";
  session.riskPushError = "";
  trySaveRiskPushState(session, 0);
  if (activeSession === session) {
    broadcast("state", sessionSummary());
  }
  if (payload.records.length) {
    addLog("system", `正在向${session.backendEnvironment.name}回传 ${payload.records.length} 家公司风险结果。`);
  } else {
    addLog("system", `正在向${session.backendEnvironment.name}回传扫描快照，本次没有成功扫描公司。`);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await pushV2RiskBatch({
        backendUrl: session.backendEnvironment.url,
        endpoint: session.backendEnvironment.endpoints.pushResults,
        payload,
      });
      session.riskPushStatus = "success";
      session.riskPushError = "";
      trySaveRiskPushState(session, attempt);
      addLog(
        "system",
        payload.records.length
          ? `风险结果回传成功，共 ${payload.records.length} 家公司。`
          : "扫描快照回传成功，本次没有成功扫描公司。",
      );
      if (activeSession === session) {
        broadcast("state", sessionSummary());
      }
      return;
    } catch (error) {
      lastError = error;
      addLog("stderr", `风险结果回传第 ${attempt} 次失败：${error.message || error}`);
      if (attempt < 3) {
        await wait(attempt * 1000);
      }
    }
  }

  session.riskPushStatus = "failed";
  session.riskPushError = lastError?.message || String(lastError || "未知错误");
  trySaveRiskPushState(session, 3);
  addLog("stderr", "扫描结果已保留，但风险结果回传失败，请根据推送状态文件排查后端连接。");
  if (activeSession === session) {
    broadcast("state", sessionSummary());
  }
}

function saveRiskPushState(session, attempts) {
  if (!session.outputFile) return;
  const state = {
    scanBatchId: session.id,
    bizMonth: session.bizMonth || "",
    sourceFile: basename(session.outputFile),
    backendEnvironment: session.backendEnvironment?.key || "",
    backendEnvironmentName: session.backendEnvironment?.name || "",
    backendUrl: session.backendEnvironment?.url || "",
    status: session.riskPushStatus,
    majorRiskCount: session.riskPushCount || 0,
    fullSnapshot: Boolean(session.riskPushPayload?.fullSnapshot),
    scannedCompanyCount: session.riskPushPayload?.scannedCompanyCount || 0,
    failedCompanyCount: session.riskPushPayload?.failedCompanyCount || 0,
    successfulCompanyCount: session.riskPushPayload?.successfulCompanyCount || 0,
    partialCompanyCount: session.riskPushPayload?.partialCompanyCount || 0,
    publishableCompanyCount: session.riskPushPayload?.publishableCompanyCount || 0,
    attempts,
    error: session.riskPushError || "",
    updatedAt: nowText(),
  };
  writeFileSync(`${session.outputFile}.push.json`, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function trySaveRiskPushState(session, attempts) {
  try {
    saveRiskPushState(session, attempts);
  } catch (error) {
    addLog("stderr", `推送状态文件保存失败：${error.message || error}`);
  }
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function startLogin() {
  return spawnCli("login", ["--login", "--auto-confirm-login"]);
}

function startScan(payload) {
  const companyNames = extractCompanyNames(payload.companiesText || "");
  if (!companyNames.length) {
    throw new Error("公司名单为空，请至少填写一家公司。");
  }
  saveCompanies(companyNames);

  if (payload.rulesText != null) {
    saveRules(payload.rulesText);
  }

  const outputFile = join(RESULTS_DIR, `risk-results-ui-${timestampForFile()}.csv`);
  const bizMonth = normalizeOptionalMonth(payload.bizMonth);
  if (!bizMonth) {
    throw new Error("请选择业务月份");
  }
  const backendEnvironment = getBackendEnvironment(payload.backendEnvironment);
  const minDelaySeconds = toPositiveNumber(payload.delayMinSeconds, 5);
  const maxDelaySeconds = toPositiveNumber(payload.delayMaxSeconds, 15);
  if (minDelaySeconds > maxDelaySeconds) {
    throw new Error("最小间隔不能大于最大间隔");
  }
  const cliArgs = [
    "--input",
    COMPANIES_FILE,
    "--output",
    outputFile,
    "--delay-min-ms",
    String(minDelaySeconds * 1000),
    "--delay-max-ms",
    String(maxDelaySeconds * 1000),
  ];

  const rawLimit = Number(payload.limit || 0);
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 0;
  const usedLimit = limit > 0;
  if (usedLimit) {
    cliArgs.push("--limit", String(limit));
  }

  if (payload.assumeLoggedIn) {
    cliArgs.push("--assume-logged-in");
  } else {
    cliArgs.push("--auto-confirm-login");
  }

  return spawnCli("scan", cliArgs, {
    outputFile,
    bizMonth,
    backendEnvironment,
    expectedCompanyCount: companyNames.length,
    usedLimit,
    progressTotal: usedLimit ? Math.min(limit, companyNames.length) : companyNames.length,
  });
}

async function syncPendingCompanies(payload) {
  const month = normalizeOptionalMonth(payload.month);
  if (!month) {
    throw new Error("请选择排线月份");
  }
  const backendEnvironment = getBackendEnvironment(payload.backendEnvironment);
  if (backendEnvironment.endpoints.fetchCompanies.enabled === false) {
    throw new Error("当前环境未启用公司名单获取接口");
  }
  addLog("system", `正在从${backendEnvironment.name}同步 ${month} 待扫描公司。`);
  const companyNames = await fetchPendingCompanyNames({
    backendUrl: backendEnvironment.url,
    endpoint: backendEnvironment.endpoints.fetchCompanies,
    month,
  });
  addLog("system", `已从${backendEnvironment.name}同步 ${companyNames.length} 家待扫描公司。`);
  return { companyNames, backendEnvironment: publicBackendEnvironment(backendEnvironment) };
}

function normalizeOptionalMonth(value) {
  const month = String(value || "").trim();
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("月份格式应为 YYYY-MM");
  }
  return month;
}

function toPositiveNumber(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
}

function continueTask() {
  if (!isRunning()) {
    throw new Error("当前没有正在运行的任务。");
  }
  if (!activeSession.awaitingContinue) {
    throw new Error("当前任务没有等待人工确认，请勿重复发送继续信号。");
  }
  activeSession.awaitingContinue = false;
  activeSession.child.stdin.write("\n");
  addLog("system", "已发送继续信号。");
  broadcast("state", sessionSummary());
  return sessionSummary();
}

function stopTask() {
  if (!isRunning()) {
    throw new Error("当前没有正在运行的任务。");
  }
  activeSession.child.kill();
  addLog("system", "已请求停止当前任务。");
  return sessionSummary();
}

function importCompaniesFile(payload) {
  const fileName = basename(payload.fileName || "");
  const ext = extname(fileName).toLowerCase();

  if (ext === ".xlsx" || ext === ".xlsm") {
    return parseExcelCompaniesFromBase64(payload.base64 || "", fileName, ext);
  }

  if (ext === ".csv" || ext === ".txt") {
    archiveTextCompanyList(fileName, payload.text || "");
    const companyNames = extractCompanyNames(payload.text || "");
    return {
      companyNames,
      rawCount: companyNames.length,
      uniqueCount: companyNames.length,
      duplicateCount: 0,
      duplicates: [],
    };
  }

  throw new Error("暂只支持 .xlsx、.xlsm、.csv、.txt 文件。");
}

function archiveName(fileName, ext) {
  const stem = basename(fileName || "company-list", ext)
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "company-list";
  return `${timestampForFile()}-${stem}-${randomUUID()}${ext}`;
}

function archiveTextCompanyList(fileName, text) {
  const ext = extname(fileName).toLowerCase();
  const uploadPath = join(COMPANY_UPLOADS_DIR, archiveName(fileName, ext));
  writeFileSync(uploadPath, String(text || ""), "utf8");
}

function parseExcelCompaniesFromBase64(base64, fileName, ext) {
  if (!base64) {
    throw new Error("Excel 文件内容为空。");
  }

  if (!existsSync(EXCEL_HELPER)) {
    throw new Error(`Excel 解析脚本不存在: ${EXCEL_HELPER}`);
  }

  const uploadPath = join(COMPANY_UPLOADS_DIR, archiveName(fileName, ext));
  writeFileSync(uploadPath, Buffer.from(base64, "base64"));

  const pythonPath = findPythonPath();
  const result = spawnSync(pythonPath, [EXCEL_HELPER, uploadPath], {
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

  const parsed = JSON.parse(result.stdout || "{}");
  const companyNames = Array.isArray(parsed.companies) ? parsed.companies : [];
  return {
    companyNames,
    rawCount: Number(parsed.rawCount || companyNames.length),
    uniqueCount: Number(parsed.uniqueCount || companyNames.length),
    duplicateCount: Number(parsed.duplicateCount || 0),
    duplicates: Array.isArray(parsed.duplicates) ? parsed.duplicates : [],
  };
}

function findPythonPath() {
  const bundled = "C:\\Users\\32719\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";
  return existsSync(bundled) ? bundled : "python";
}

function extractCompanyNames(text) {
  const trimmed = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    return [];
  }

  const rows = parseCsv(trimmed);
  const firstRow = rows[0] || [];
  const hasComma = trimmed.includes(",");
  const headerIndex = firstRow.findIndex((cell) =>
    ["公司名称", "企业名称", "company", "company_name", "compan_name", "name"].includes(cell.trim())
  );

  if (hasComma || headerIndex >= 0) {
    const companyIndex = headerIndex >= 0 ? headerIndex : 0;
    const dataRows = headerIndex >= 0 ? rows.slice(1) : rows;
    return uniqueNonEmpty(dataRows.map((row) => row[companyIndex]));
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim());
  const first = lines[0] || "";
  const dataLines = /^(公司名称|企业名称|company|company_name|compan_name|name)$/i.test(first) ? lines.slice(1) : lines;
  return uniqueNonEmpty(dataLines);
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    output.push(text);
  }
  return output;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function saveCompanies(companyNames) {
  const lines = ["公司名称", ...companyNames.map(csvEscape)];
  writeFileSync(COMPANIES_FILE, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

function readCompaniesText() {
  if (!existsSync(COMPANIES_FILE)) {
    return "";
  }
  const raw = readFileSync(COMPANIES_FILE, "utf8").replace(/^\uFEFF/, "");
  return extractCompanyNames(raw).join("\n");
}

function readRulesText() {
  if (!existsSync(RULES_FILE)) {
    return "{}";
  }
  return readFileSync(RULES_FILE, "utf8").replace(/^\uFEFF/, "");
}

function saveRules(rulesText) {
  const parsed = JSON.parse(String(rulesText || "{}").replace(/^\uFEFF/, ""));
  writeFileSync(RULES_FILE, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
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

function listResultFiles() {
  if (!existsSync(RESULTS_DIR)) {
    return [];
  }

  return readdirSync(RESULTS_DIR)
    .filter((name) => /^risk-results.*\.csv$/i.test(name))
    .map((name) => {
      const filePath = join(RESULTS_DIR, name);
      const stats = statSync(filePath);
      return {
        name,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        updatedAt: stats.mtime.toLocaleString(),
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readLatestResults(fileName = "") {
  const files = listResultFiles();
  const selectedName = fileName || activeSession?.outputFile && basename(activeSession.outputFile) || files[0]?.name || "";
  if (!selectedName) {
    return { files, selectedFile: "", columns: [], rows: [] };
  }

  const safeName = basename(selectedName);
  const filePath = join(RESULTS_DIR, safeName);
  if (!existsSync(filePath) || !/^risk-results.*\.csv$/i.test(safeName)) {
    return { files, selectedFile: "", columns: [], rows: [] };
  }

  const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const parsed = parseCsv(raw).filter((row) => row.some((cell) => String(cell || "").trim()));
  const columns = parsed[0] || [];
  const rows = parsed.slice(1).map((row) => {
    const record = {};
    columns.forEach((column, index) => {
      record[column] = row[index] || "";
    });
    return record;
  });

  return { files, selectedFile: safeName, columns, rows };
}

function contentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  }[ext] || "application/octet-stream";
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function sendJson(response, data, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function sendError(response, error, status = 400) {
  sendJson(response, { ok: false, error: error.message || String(error) }, status);
}

function serveStatic(response, requestPath) {
  const servesLogo = requestPath.startsWith("/logo/");
  const baseDir = servesLogo ? LOGO_DIR : UI_DIR;
  const relativePath = servesLogo
    ? requestPath.replace(/^\/logo\/?/, "")
    : requestPath === "/"
      ? "index.html"
      : requestPath.replace(/^\/ui\/?/, "");
  let filePath = join(baseDir, relativePath);
  filePath = resolve(filePath);

  if (!filePath.startsWith(resolve(baseDir))) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": contentType(filePath),
    "cache-control": "no-store",
  });
  response.end(readFileSync(filePath));
}

function downloadResult(response, fileName) {
  const safeName = basename(fileName || "");
  if (!safeName || !/^risk-results.*\.csv$/i.test(safeName)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const filePath = join(RESULTS_DIR, safeName);
  if (!existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${safeName}"`,
    "cache-control": "no-store",
  });
  response.end(readFileSync(filePath));
}

function handleEvents(request, response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.write(`event: state\ndata: ${JSON.stringify(sessionSummary())}\n\n`);
  clients.add(response);
  request.on("close", () => clients.delete(response));
}

async function handleApi(request, response, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, {
        ok: true,
        instance: {
          pid: process.pid,
          projectDir: SCRIPT_DIR,
          port: args.port,
        },
        backendConfig: publicBackendConfig(),
        companiesText: readCompaniesText(),
        rulesText: readRulesText(),
        session: sessionSummary(),
        logs,
        results: readLatestResults(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      handleEvents(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/results") {
      sendJson(response, { ok: true, results: readLatestResults(url.searchParams.get("file") || "") });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/download") {
      downloadResult(response, url.searchParams.get("file"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/import-companies-file") {
      const body = await readJsonBody(request);
      const summary = importCompaniesFile(body);
      sendJson(response, {
        ok: true,
        companiesText: summary.companyNames.join("\n"),
        count: summary.uniqueCount,
        rawCount: summary.rawCount,
        duplicateCount: summary.duplicateCount,
        duplicates: summary.duplicates,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/companies") {
      const body = await readJsonBody(request);
      const companyNames = extractCompanyNames(body.companiesText || "");
      saveCompanies(companyNames);
      sendJson(response, { ok: true, companiesText: companyNames.join("\n") });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/sync-companies") {
      const body = await readJsonBody(request);
      const result = await syncPendingCompanies(body);
      sendJson(response, {
        ok: true,
        companyNames: result.companyNames,
        count: result.companyNames.length,
        backendEnvironment: result.backendEnvironment,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/rules") {
      const body = await readJsonBody(request);
      saveRules(body.rulesText || "{}");
      sendJson(response, { ok: true, rulesText: readRulesText() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/start-login") {
      sendJson(response, { ok: true, session: startLogin() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/start-scan") {
      const body = await readJsonBody(request);
      sendJson(response, { ok: true, session: startScan(body) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/confirm-risk-push") {
      const body = await readJsonBody(request);
      sendJson(response, { ok: true, session: await confirmRiskPush(body.sessionId) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/continue") {
      sendJson(response, { ok: true, session: continueTask() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/stop") {
      sendJson(response, { ok: true, session: stopTask() });
      return;
    }

    response.writeHead(404);
    response.end("Not found");
  } catch (error) {
    sendError(response, error);
  }
}

function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || `${args.host}:${args.port}`}`);

  if (url.pathname.startsWith("/api/")) {
    handleApi(request, response, url);
    return;
  }

  if (url.pathname === "/" || url.pathname.startsWith("/ui/") || url.pathname.startsWith("/logo/")) {
    serveStatic(response, url.pathname);
    return;
  }

  response.writeHead(404);
  response.end("Not found");
}

if (args.help) {
  usage();
} else {
  mkdirSync(join(SCRIPT_DIR, "runtime"), { recursive: true });

  const server = createServer(handleRequest);
  server.listen(args.port, args.host, () => {
    writeFileSync(UI_SERVER_PID_FILE, `${process.pid}\n`, "utf8");
    const url = `http://${args.host}:${args.port}/`;
    console.log(`企查查风险扫描可视化控制台已启动: ${url}`);
    console.log(`外部接口环境: ${BACKEND_CONFIG.environments.map((item) => `${item.name}=${item.url}`).join("，")}`);
    console.log("按 Ctrl+C 停止服务。");
  });

  const cleanupPidFile = () => {
    try {
      if (existsSync(UI_SERVER_PID_FILE) && readFileSync(UI_SERVER_PID_FILE, "utf8").trim() === String(process.pid)) {
        rmSync(UI_SERVER_PID_FILE, { force: true });
      }
    } catch {
      // PID 文件只用于启动器识别实例，清理失败不影响服务退出。
    }
  };

  process.once("exit", cleanupPidFile);
  process.once("SIGINT", () => server.close(() => process.exit(0)));
  process.once("SIGTERM", () => server.close(() => process.exit(0)));
}
