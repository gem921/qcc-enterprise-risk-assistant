const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const elements = {
  pageTitle: $("#pageTitle"),
  pageSubtitle: $("#pageSubtitle"),
  backendSwitch: $("#backendSwitch"),
  backendSegments: $("#backendSegments"),
  backendEnvironmentUrl: $("#backendEnvironmentUrl"),
  statusDot: $("#statusDot"),
  runtimeStatus: $("#runtimeStatus"),
  runtimeMeta: $("#runtimeMeta"),
  sessionKind: $("#sessionKind"),
  sessionFile: $("#sessionFile"),
  scanProgress: $("#scanProgress"),
  scanProgressLabel: $("#scanProgressLabel"),
  scanProgressMeta: $("#scanProgressMeta"),
  scanProgressValue: $("#scanProgressValue"),
  scanProgressTrack: $("#scanProgressTrack"),
  scanProgressBar: $("#scanProgressBar"),
  companiesText: $("#companiesText"),
  companyMonth: $("#companyMonth"),
  companySyncStatus: $("#companySyncStatus"),
  companyCount: $("#companyCount"),
  companyCountMirror: $("#companyCountMirror"),
  importSummary: $("#importSummary"),
  resultCount: $("#resultCount"),
  selectedResultName: $("#selectedResultName"),
  rulesText: $("#rulesText"),
  ruleEditor: $("#ruleEditor"),
  ruleCount: $("#ruleCount"),
  delayMinSeconds: $("#delayMinSeconds"),
  delayMaxSeconds: $("#delayMaxSeconds"),
  limit: $("#limit"),
  assumeLoggedIn: $("#assumeLoggedIn"),
  logStream: $("#logStream"),
  resultHead: $("#resultHead"),
  resultBody: $("#resultBody"),
  emptyResults: $("#emptyResults"),
  resultFileSelect: $("#resultFileSelect"),
  warningLevelFilter: $("#warningLevelFilter"),
  riskReview: $("#riskReview"),
  riskReviewTitle: $("#riskReviewTitle"),
  riskReviewMessage: $("#riskReviewMessage"),
  riskReviewStats: $("#riskReviewStats"),
  reviewBizMonth: $("#reviewBizMonth"),
  reviewScannedCount: $("#reviewScannedCount"),
  reviewFailedCount: $("#reviewFailedCount"),
  reviewMajorCount: $("#reviewMajorCount"),
  reviewSnapshotType: $("#reviewSnapshotType"),
  reviewBackendEnvironment: $("#reviewBackendEnvironment"),
  downloadBtn: $("#downloadBtn"),
  toast: $("#toast"),
  fileInput: $("#fileInput"),
};

const buttons = {
  refresh: $("#refreshBtn"),
  login: $("#loginBtn"),
  scan: $("#scanBtn"),
  continue: $("#continueBtn"),
  stop: $("#stopBtn"),
  import: $("#importBtn"),
  syncCompanies: $("#syncCompaniesBtn"),
  saveCompanies: $("#saveCompaniesBtn"),
  saveRules: $("#saveRulesBtn"),
  addRule: $("#addRuleBtn"),
  clearLog: $("#clearLogBtn"),
  confirmRiskPush: $("#confirmRiskPushBtn"),
};

let currentSession = { running: false };
let currentResults = { files: [], selectedFile: "", columns: [], rows: [] };
let logEntries = [];
let rulesDocument = null;
let backendEnvironments = [];
let selectedBackendEnvironment = "local";
let reviewedSessionId = "";

const BACKEND_ENVIRONMENT_STORAGE_KEY = "qcc-risk-rpa.backend-environment";

const RISK_FIELDS = [
  "自身风险重要",
  "自身风险",
];

const WARNING_LEVELS = ["提示", "关注", "高危", "重大"];

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json; charset=utf-8" },
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `请求失败: ${response.status}`);
  }
  return data;
}

function post(path, body = {}) {
  return api(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function fetchPendingCompanies(month) {
  const data = await post("/api/sync-companies", {
    month,
    backendEnvironment: selectedBackendEnvironment,
  });
  return Array.isArray(data.companyNames) ? data.companyNames : [];
}

function backendEnvironmentByKey(key) {
  return backendEnvironments.find((item) => item.key === key) || null;
}

function renderBackendEnvironmentSwitch() {
  elements.backendSegments.replaceChildren();
  for (const environment of backendEnvironments) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `backend-segment${environment.production ? " production" : ""}`;
    button.dataset.backendEnvironment = environment.key;
    button.setAttribute("role", "radio");
    button.textContent = environment.name;
    button.addEventListener("click", () => setBackendEnvironment(environment.key));
    elements.backendSegments.append(button);
  }
  updateBackendEnvironmentSwitch();
}

function setBackendEnvironment(key, persist = true) {
  const environment = backendEnvironmentByKey(key);
  if (!environment) return;
  selectedBackendEnvironment = environment.key;
  if (persist) {
    localStorage.setItem(BACKEND_ENVIRONMENT_STORAGE_KEY, environment.key);
  }
  updateBackendEnvironmentSwitch();
}

function updateBackendEnvironmentSwitch() {
  const environment = backendEnvironmentByKey(selectedBackendEnvironment);
  elements.backendSwitch.classList.toggle("production", Boolean(environment?.production));
  const fetchEnabled = environment?.endpoints?.fetchCompanies?.enabled !== false;
  const pushEnabled = environment?.endpoints?.pushResults?.enabled !== false;
  elements.backendEnvironmentUrl.textContent = environment
    ? `${environment.url} · 获取${fetchEnabled ? "已启用" : "未启用"} · 回传${pushEnabled ? "已启用" : "未启用"}`
    : "环境未配置";
  elements.backendEnvironmentUrl.title = environment?.url || "";
  buttons.syncCompanies.disabled = Boolean(currentSession.running) || !fetchEnabled;
  $$(".backend-segment").forEach((button) => {
    const active = button.dataset.backendEnvironment === selectedBackendEnvironment;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function switchView(viewName) {
  const view = $(`#view-${viewName}`);
  if (!view) return;

  $$(".view").forEach((item) => item.classList.toggle("active", item === view));
  $$(".side-nav button").forEach((item) => item.classList.toggle("active", item.dataset.view === viewName));

  elements.pageTitle.textContent = view.dataset.title || "控制台";
  elements.pageSubtitle.textContent = view.dataset.subtitle || "";
  location.hash = viewName;
}

function countCompanies(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index) => !(index === 0 && /^(公司名称|企业名称|company|company_name|compan_name|name)$/i.test(line)))
    .length;
}

function defaultRuleMessage(field) {
  return `${field}达到 {value} 条`;
}

function createSelect(options, value, className, label) {
  const select = document.createElement("select");
  select.className = className;
  select.setAttribute("aria-label", label);
  for (const optionValue of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionValue;
    option.selected = optionValue === value;
    select.append(option);
  }
  return select;
}

function createRuleCell(label, control, className = "") {
  const cell = document.createElement("div");
  cell.className = `rule-cell ${className}`.trim();

  const mobileLabel = document.createElement("span");
  mobileLabel.className = "rule-mobile-label";
  mobileLabel.textContent = label;

  cell.append(mobileLabel, control);
  return cell;
}

function createRuleRow(rule = {}) {
  const row = document.createElement("div");
  row.className = "rule-row";

  const field = RISK_FIELDS.includes(rule.field) ? rule.field : RISK_FIELDS[0];
  const level = WARNING_LEVELS.includes(rule.level) ? rule.level : "关注";
  const fieldSelect = createSelect(RISK_FIELDS, field, "rule-field", "风险指标");
  const levelSelect = createSelect(WARNING_LEVELS, level, "rule-level", "预警等级");

  const condition = document.createElement("div");
  condition.className = "condition-control";
  const comparator = document.createElement("span");
  comparator.textContent = "≥";
  comparator.title = "大于等于";
  const threshold = document.createElement("input");
  threshold.className = "rule-threshold";
  threshold.type = "number";
  threshold.min = "0";
  threshold.step = "1";
  threshold.value = Number.isFinite(Number(rule.gte)) ? String(Number(rule.gte)) : "1";
  threshold.setAttribute("aria-label", "触发阈值");
  condition.append(comparator, threshold);

  const message = document.createElement("input");
  message.className = "rule-message";
  message.type = "text";
  message.value = String(rule.message || defaultRuleMessage(field));
  message.setAttribute("aria-label", "提示内容");

  const remove = document.createElement("button");
  remove.className = "icon-btn rule-remove";
  remove.type = "button";
  remove.title = "删除规则";
  remove.setAttribute("aria-label", "删除规则");
  remove.textContent = "×";

  let previousField = field;
  fieldSelect.addEventListener("change", () => {
    if (!message.value || message.value === defaultRuleMessage(previousField)) {
      message.value = defaultRuleMessage(fieldSelect.value);
    }
    previousField = fieldSelect.value;
    syncRulesTextFromEditor();
  });
  levelSelect.addEventListener("change", syncRulesTextFromEditor);
  threshold.addEventListener("input", syncRulesTextFromEditor);
  message.addEventListener("input", syncRulesTextFromEditor);
  remove.addEventListener("click", () => {
    row.remove();
    syncRulesTextFromEditor();
  });

  row.append(
    createRuleCell("风险指标", fieldSelect),
    createRuleCell("触发条件", condition),
    createRuleCell("预警等级", levelSelect),
    createRuleCell("提示内容", message),
    createRuleCell("操作", remove, "rule-action"),
  );
  return row;
}

function renderRuleEditor() {
  try {
    const parsed = JSON.parse(elements.rulesText.value || "{}");
    rulesDocument = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    rulesDocument = {};
    showToast("预警规则文件格式异常，已显示空规则");
  }

  elements.ruleEditor.innerHTML = "";
  for (const rule of Array.isArray(rulesDocument.thresholds) ? rulesDocument.thresholds : []) {
    elements.ruleEditor.append(createRuleRow(rule));
  }
  const scanInterval = rulesDocument.scanInterval || {};
  elements.delayMinSeconds.value = Number.isFinite(Number(scanInterval.minSeconds))
    ? Number(scanInterval.minSeconds)
    : 5;
  elements.delayMaxSeconds.value = Number.isFinite(Number(scanInterval.maxSeconds))
    ? Number(scanInterval.maxSeconds)
    : 15;
  syncRulesTextFromEditor();
}

function syncRulesTextFromEditor() {
  const thresholds = $$(".rule-row").map((row) => {
    const field = row.querySelector(".rule-field").value;
    const threshold = Number(row.querySelector(".rule-threshold").value);
    return {
      field,
      gte: Number.isFinite(threshold) ? Math.max(0, threshold) : 0,
      level: row.querySelector(".rule-level").value,
      message: row.querySelector(".rule-message").value.trim() || defaultRuleMessage(field),
    };
  });

  rulesDocument = {
    ...(rulesDocument || {}),
    severityOrder: rulesDocument?.severityOrder || ["正常", "提示", "关注", "高危", "重大"],
    normalLevel: rulesDocument?.normalLevel || "正常",
    normalMessage: rulesDocument?.normalMessage || "未触发预警规则",
    thresholds,
    scanInterval: {
      minSeconds: Math.max(0, Number(elements.delayMinSeconds.value) || 0),
      maxSeconds: Math.max(0, Number(elements.delayMaxSeconds.value) || 0),
    },
  };
  elements.rulesText.value = `${JSON.stringify(rulesDocument, null, 2)}\n`;
  elements.ruleCount.textContent = `${thresholds.length} 条规则`;
}

function updateCompanyCount(summaryText = "") {
  const count = countCompanies(elements.companiesText.value);
  elements.companyCount.textContent = count;
  elements.companyCountMirror.textContent = count;
  if (summaryText) {
    elements.importSummary.textContent = summaryText;
  } else if (!count) {
    elements.importSummary.textContent = "等待导入";
  } else {
    elements.importSummary.textContent = "已载入名单";
  }
}

function setSession(session) {
  currentSession = session || { running: false };
  const running = Boolean(currentSession.running);
  const status = currentSession.status || (running ? "running" : "idle");

  elements.statusDot.className = `status-dot ${status}`;
  elements.runtimeStatus.textContent = running ? "运行中" : sessionStatusLabel(currentSession, status);
  elements.runtimeMeta.textContent = sessionMetaText(currentSession);
  elements.sessionKind.textContent = currentSession.kind ? kindLabel(currentSession.kind) : "未运行";
  elements.sessionFile.textContent = currentSession.outputFile || "暂无结果文件";
  renderScanProgress(currentSession);
  renderRiskPushReview(currentSession);

  if (["awaiting_confirmation", "local_only"].includes(currentSession.riskPushStatus)
    && reviewedSessionId !== currentSession.id) {
    reviewedSessionId = currentSession.id;
    elements.warningLevelFilter.value = "重大";
    renderResults(currentResults);
    switchView("results");
  }

  buttons.login.disabled = running;
  buttons.scan.disabled = running;
  buttons.continue.disabled = !running;
  buttons.stop.disabled = !running;
  const fetchEnabled = backendEnvironmentByKey(selectedBackendEnvironment)
    ?.endpoints?.fetchCompanies?.enabled !== false;
  buttons.syncCompanies.disabled = running || !fetchEnabled;
  $$(".backend-segment").forEach((button) => {
    button.disabled = running;
  });
}

function renderRiskPushReview(session) {
  const isScanResult = session.kind === "scan" && session.status === "done";
  const pushStatus = session.riskPushStatus || "";
  let phase = "idle";
  let title = "暂无待回传结果";
  let message = "扫描完成后将在这里审核重大风险结果";
  let buttonText = "确认回传";
  let showButton = false;
  const targetEnvironment = session.backendEnvironment || backendEnvironmentByKey(selectedBackendEnvironment);
  const targetName = targetEnvironment?.name || "未指定环境";
  const targetUrl = targetEnvironment?.url || "";

  if (isScanResult && pushStatus === "awaiting_confirmation") {
    phase = "pending";
    title = `待确认回传 ${session.riskPushCount || 0} 家重大风险公司`;
    message = session.riskPushCount
      ? `请核对下方重大风险结果，确认后将写入${targetName}（${targetUrl}）。`
      : session.riskPushFullSnapshot
        ? `本次无重大风险；确认后将在${targetName}解除该月份未再次出现的原重大风险。`
        : `本次无重大风险，且不是完整快照；确认后只更新${targetName}中的本次结果。`;
    buttonText = targetEnvironment?.production ? "确认回传至线上环境" : "确认回传至本地环境";
    showButton = true;
  } else if (isScanResult && pushStatus === "local_only") {
    phase = "success";
    title = "扫描结果已保存在本地";
    message = "当前环境未启用结果回传接口，可直接下载 CSV 结果。";
  } else if (isScanResult && pushStatus === "pushing") {
    phase = "pushing";
    title = "正在回传重大风险结果";
    message = `正在回传至${targetName}（${targetUrl}），请等待处理完成。`;
  } else if (isScanResult && pushStatus === "success") {
    phase = "success";
    title = "重大风险结果已回传";
    message = `已成功回传 ${session.riskPushCount || 0} 家重大风险公司。`;
  } else if (isScanResult && pushStatus === "failed") {
    phase = "failed";
    title = "重大风险回传失败";
    message = session.riskPushError || "请检查后端服务后重新回传。";
    buttonText = targetEnvironment?.production ? "重新回传至线上环境" : "重新回传至本地环境";
    showButton = true;
  }

  elements.riskReview.className = `risk-review ${phase}`;
  elements.riskReviewTitle.textContent = title;
  elements.riskReviewMessage.textContent = message;
  elements.riskReviewStats.hidden = !isScanResult || !pushStatus;
  elements.reviewBizMonth.textContent = session.bizMonth || "-";
  elements.reviewScannedCount.textContent = session.scannedCompanyCount || 0;
  elements.reviewFailedCount.textContent = session.failedCompanyCount || 0;
  elements.reviewMajorCount.textContent = session.riskPushCount || 0;
  elements.reviewSnapshotType.textContent = session.riskPushFullSnapshot ? "完整快照" : "增量结果";
  elements.reviewBackendEnvironment.textContent = targetName;
  buttons.confirmRiskPush.hidden = !showButton;
  buttons.confirmRiskPush.disabled = pushStatus === "pushing";
  buttons.confirmRiskPush.textContent = buttonText;
}

function renderScanProgress(session) {
  const isScan = session.kind === "scan";
  const total = Math.max(0, Number(session.progressTotal) || 0);
  const current = Math.min(total, Math.max(0, Number(session.progressCurrent) || 0));
  let percent = Math.min(100, Math.max(0, Number(session.progressPercent) || 0));
  let phase = "idle";
  let label = "扫描尚未开始";
  let meta = "等待扫描任务";

  if (isScan && session.running) {
    phase = "running";
    label = current > 0 ? "正在扫描企业" : "正在准备扫描";
    meta = total > 0 ? `${current} / ${total} 家` : "正在读取任务信息";
  } else if (isScan && session.riskPushStatus === "pushing") {
    phase = "pushing";
    percent = 100;
    label = "扫描完成，正在回传风险";
    meta = `正在直连后端回传 ${session.riskPushCount || 0} 家重大风险公司`;
  } else if (isScan && session.riskPushStatus === "awaiting_confirmation") {
    phase = "complete";
    percent = 100;
    label = "扫描完成，等待确认回传";
    meta = `请审核 ${session.riskPushCount || 0} 家重大风险公司`;
  } else if (isScan && session.status === "done") {
    phase = session.riskPushStatus === "failed" ? "warning" : "complete";
    percent = 100;
    label = session.riskPushStatus === "failed" ? "扫描完成，风险回传失败" : "扫描任务已完成";
    meta = session.riskPushStatus === "success"
      ? `已回传 ${session.riskPushCount || 0} 家重大风险公司`
      : `${total || current} 家企业处理完成`;
  } else if (isScan && session.status === "failed") {
    phase = "failed";
    label = "扫描任务异常结束";
    meta = total > 0 ? `已处理至 ${current} / ${total} 家` : "请查看运行记录";
  }

  const displayPercent = Math.round(percent);
  elements.scanProgress.className = `scan-progress ${phase}`;
  elements.scanProgressLabel.textContent = label;
  elements.scanProgressMeta.textContent = meta;
  elements.scanProgressValue.textContent = `${displayPercent}%`;
  elements.scanProgressBar.style.width = `${displayPercent}%`;
  elements.scanProgressTrack.setAttribute("aria-valuenow", String(displayPercent));
}

function sessionStatusLabel(session, status) {
  if (status === "done" && session.riskPushStatus === "failed") {
    return "扫描完成，回传失败";
  }
  if (status === "done" && session.riskPushStatus === "pushing") {
    return "正在回传风险";
  }
  if (status === "done" && session.riskPushStatus === "awaiting_confirmation") {
    return "等待确认回传";
  }
  return statusLabel(status);
}

function sessionMetaText(session) {
  if (session.riskPushStatus === "success") {
    return `重大风险已回传 ${session.riskPushCount || 0} 家`;
  }
  if (session.riskPushStatus === "skipped") {
    return "本次扫描无重大风险";
  }
  if (session.riskPushStatus === "failed") {
    return session.riskPushError || "重大风险回传失败";
  }
  if (session.riskPushStatus === "pushing") {
    return `正在回传 ${session.riskPushCount || 0} 家重大风险公司`;
  }
  if (session.riskPushStatus === "awaiting_confirmation") {
    return `待确认 ${session.riskPushCount || 0} 家重大风险公司`;
  }
  if (session.kind === "scan" && session.running && session.progressTotal) {
    return `正在扫描 ${session.progressCurrent || 0} / ${session.progressTotal} 家`;
  }
  return session.startedAt || "等待任务";
}

function statusLabel(status) {
  return {
    idle: "空闲",
    running: "运行中",
    done: "已完成",
    failed: "异常结束",
  }[status] || "空闲";
}

function kindLabel(kind) {
  return {
    login: "登录流程",
    scan: "扫描任务",
  }[kind] || kind;
}

function addLocalLog(message) {
  appendLog({
    time: new Date().toLocaleString(),
    kind: "system",
    message,
  });
}

function createLogLine(entry) {
  const line = document.createElement("div");
  line.className = `log-line ${entry.kind || ""}`;

  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = entry.time || "";

  const kind = document.createElement("span");
  kind.className = "log-kind";
  kind.textContent = logKindLabel(entry.kind);

  const message = document.createElement("span");
  message.className = "log-message";
  message.textContent = entry.message || "";

  line.append(time, kind, message);
  return line;
}

function appendLog(entry) {
  logEntries.push(entry);
  if (logEntries.length > 500) logEntries = logEntries.slice(-500);
  while (elements.logStream.childElementCount >= 260) {
    elements.logStream.firstElementChild.remove();
  }
  elements.logStream.append(createLogLine(entry));
  elements.logStream.scrollTop = elements.logStream.scrollHeight;
}

function renderLogs(entries = logEntries) {
  elements.logStream.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const entry of entries.slice(-260)) fragment.append(createLogLine(entry));
  elements.logStream.append(fragment);
  elements.logStream.scrollTop = elements.logStream.scrollHeight;
}

function logKindLabel(kind) {
  return {
    system: "系统",
    stdout: "任务",
    stderr: "异常",
  }[kind] || "记录";
}

function renderResults(results = currentResults) {
  currentResults = results || { files: [], selectedFile: "", columns: [], rows: [] };
  const files = currentResults.files || [];
  const selected = currentResults.selectedFile || "";

  const allRows = currentResults.rows || [];
  const selectedLevel = elements.warningLevelFilter.value;
  const rows = selectedLevel ? allRows.filter((row) => row["预警等级"] === selectedLevel) : allRows;
  elements.resultCount.textContent = selectedLevel ? `${rows.length} / ${allRows.length} 条` : `${allRows.length} 条`;
  elements.selectedResultName.textContent = selected || "暂无结果";

  const levelCounts = new Map();
  for (const row of allRows) {
    const level = row["预警等级"] || "";
    levelCounts.set(level, (levelCounts.get(level) || 0) + 1);
  }
  for (const option of elements.warningLevelFilter.options) {
    const label = option.value || "全部等级";
    const count = option.value ? levelCounts.get(option.value) || 0 : allRows.length;
    option.textContent = `${label} (${count})`;
  }

  elements.resultFileSelect.innerHTML = "";
  if (!files.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无结果文件";
    elements.resultFileSelect.append(option);
  } else {
    for (const file of files) {
      const option = document.createElement("option");
      option.value = file.name;
      option.textContent = `${file.name} (${file.updatedAt})`;
      option.selected = file.name === selected;
      elements.resultFileSelect.append(option);
    }
  }

  if (selected) {
    elements.downloadBtn.href = `/api/download?file=${encodeURIComponent(selected)}`;
    elements.downloadBtn.setAttribute("aria-disabled", "false");
  } else {
    elements.downloadBtn.href = "#";
    elements.downloadBtn.setAttribute("aria-disabled", "true");
  }

  const preferredColumns = [
    "公司名称",
    "状态",
    "预警等级",
    "预警摘要",
    "匹配公司",
    "企查分",
    "自身风险",
    "自身风险_重要",
    "企查查链接",
    "错误信息",
    "检查时间",
  ];
  const columns = preferredColumns.filter((column) => (currentResults.columns || []).includes(column));

  elements.resultHead.innerHTML = "";
  elements.resultBody.innerHTML = "";
  elements.emptyResults.textContent = selectedLevel ? `暂无“${selectedLevel}”等级结果` : "暂无结果";
  elements.emptyResults.classList.toggle("hidden", rows.length > 0);
  if (!rows.length || !columns.length) return;

  const headRow = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    th.textContent = column;
    th.dataset.column = column;
    headRow.append(th);
  }
  elements.resultHead.append(headRow);

  const bodyFragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const column of columns) {
      const td = document.createElement("td");
      td.dataset.column = column;
      const value = row[column] || "";

      if (column === "预警等级" && value) {
        const badge = document.createElement("span");
        badge.className = `level-badge level-${value}`;
        badge.textContent = value;
        td.append(badge);
      } else if (column === "企查查链接" && value) {
        const link = document.createElement("a");
        link.href = value;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = "打开";
        td.append(link);
      } else {
        td.textContent = value;
      }

      tr.append(td);
    }
    bodyFragment.append(tr);
  }
  elements.resultBody.append(bodyFragment);
}

async function loadState() {
  const data = await api("/api/state");
  backendEnvironments = Array.isArray(data.backendConfig?.environments)
    ? data.backendConfig.environments
    : [];
  const storedEnvironment = localStorage.getItem(BACKEND_ENVIRONMENT_STORAGE_KEY);
  const initialEnvironment = backendEnvironmentByKey(storedEnvironment)
    ? storedEnvironment
    : data.backendConfig?.defaultEnvironment;
  selectedBackendEnvironment = initialEnvironment || backendEnvironments[0]?.key || "local";
  renderBackendEnvironmentSwitch();
  if (!elements.companyMonth.value) {
    elements.companyMonth.value = currentMonthValue();
  }
  elements.companiesText.value = data.companiesText || "";
  elements.rulesText.value = data.rulesText || "";
  renderRuleEditor();
  logEntries = data.logs || [];
  setSession(data.session);
  renderLogs();
  renderResults(data.results);
  updateCompanyCount();
}

function currentMonthValue() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function connectEvents() {
  const source = new EventSource("/api/events");

  source.addEventListener("log", (event) => {
    appendLog(JSON.parse(event.data));
  });

  source.addEventListener("state", (event) => {
    setSession(JSON.parse(event.data));
  });

  source.addEventListener("results", (event) => {
    renderResults(JSON.parse(event.data));
  });

  source.onerror = () => {
    showToast("日志连接已断开，刷新页面可重连");
  };
}

async function refreshResults(fileName = "") {
  const query = fileName ? `?file=${encodeURIComponent(fileName)}` : "";
  const data = await api(`/api/results${query}`);
  renderResults(data.results);
}

$$(".side-nav button").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

buttons.refresh.addEventListener("click", async () => {
  await loadState();
  showToast("已刷新");
});

buttons.login.addEventListener("click", async () => {
  await post("/api/start-login");
  switchView("dashboard");
  showToast("登录流程已启动");
});

buttons.scan.addEventListener("click", async () => {
  await post("/api/start-scan", {
    companiesText: elements.companiesText.value,
    rulesText: elements.rulesText.value,
    delayMinSeconds: elements.delayMinSeconds.value,
    delayMaxSeconds: elements.delayMaxSeconds.value,
    limit: elements.limit.value,
    assumeLoggedIn: elements.assumeLoggedIn.checked,
    bizMonth: elements.companyMonth.value,
    backendEnvironment: selectedBackendEnvironment,
  });
  switchView("dashboard");
  showToast("扫描任务已启动");
});

buttons.confirmRiskPush.addEventListener("click", async () => {
  if (!currentSession.id) {
    throw new Error("待回传扫描会话不存在");
  }
  buttons.confirmRiskPush.disabled = true;
  const data = await post("/api/confirm-risk-push", { sessionId: currentSession.id });
  setSession(data.session);
  if (data.session?.riskPushStatus === "success") {
    showToast("重大风险结果已回传");
  } else {
    throw new Error(data.session?.riskPushError || "重大风险回传失败");
  }
});

buttons.continue.addEventListener("click", async () => {
  await post("/api/continue");
  showToast("已继续");
});

buttons.stop.addEventListener("click", async () => {
  await post("/api/stop");
  showToast("已停止");
});

buttons.import.addEventListener("click", () => elements.fileInput.click());

buttons.syncCompanies.addEventListener("click", async () => {
  const month = elements.companyMonth.value;
  if (!month) {
    throw new Error("请选择排线月份");
  }

  buttons.syncCompanies.disabled = true;
  elements.companySyncStatus.textContent = "正在同步...";
  try {
    const environment = backendEnvironmentByKey(selectedBackendEnvironment);
    const companyNames = await fetchPendingCompanies(month);
    const saved = await post("/api/companies", {
      companiesText: companyNames.join("\n"),
    });
    elements.companiesText.value = saved.companiesText || "";
    elements.companySyncStatus.textContent = `${environment?.name || "系统"} · ${month} · 已同步 ${companyNames.length} 家`;
    updateCompanyCount(`系统同步 ${companyNames.length} 家`);
    showToast(`已同步 ${companyNames.length} 家待扫描公司`);
  } catch (error) {
    elements.companySyncStatus.textContent = `同步失败：${error.message || error}`;
    throw error;
  } finally {
    const fetchEnabled = backendEnvironmentByKey(selectedBackendEnvironment)
      ?.endpoints?.fetchCompanies?.enabled !== false;
    buttons.syncCompanies.disabled = Boolean(currentSession.running) || !fetchEnabled;
  }
});

buttons.saveCompanies.addEventListener("click", async () => {
  const data = await post("/api/companies", {
    companiesText: elements.companiesText.value,
  });
  elements.companiesText.value = data.companiesText || "";
  updateCompanyCount("名单已保存");
  showToast("公司名单已保存");
});

buttons.saveRules.addEventListener("click", async () => {
  syncRulesTextFromEditor();
  const data = await post("/api/rules", {
    rulesText: elements.rulesText.value,
  });
  elements.rulesText.value = data.rulesText || "";
  renderRuleEditor();
  showToast("预警规则已保存");
});

buttons.addRule.addEventListener("click", () => {
  const row = createRuleRow({
    field: "自身风险",
    gte: 1,
    level: "关注",
    message: defaultRuleMessage("自身风险"),
  });
  elements.ruleEditor.append(row);
  syncRulesTextFromEditor();
  row.querySelector(".rule-field").focus();
});

buttons.clearLog.addEventListener("click", () => {
  logEntries = [];
  renderLogs();
});

elements.fileInput.addEventListener("change", async () => {
  const file = elements.fileInput.files[0];
  if (!file) return;

  const fileName = file.name || "";
  const isExcel = /\.(xlsx|xlsm)$/i.test(fileName);
  const payload = isExcel
    ? { fileName, base64: arrayBufferToBase64(await file.arrayBuffer()) }
    : { fileName, text: await file.text() };
  const data = await post("/api/import-companies-file", payload);

  elements.companiesText.value = data.companiesText || "";
  elements.fileInput.value = "";

  const rawCount = data.rawCount || data.count || 0;
  const uniqueCount = data.count || 0;
  const duplicateCount = data.duplicateCount || 0;
  updateCompanyCount(`原始 ${rawCount} 条，去重 ${uniqueCount} 家`);

  if (duplicateCount > 0) {
    const names = (data.duplicates || [])
      .map((item) => `${item.name}×${item.count}`)
      .join("；");
    addLocalLog(`导入文件存在重复公司：${names}`);
  }

  showToast(`文件已载入：原始 ${rawCount} 条，去重后 ${uniqueCount} 家，重复 ${duplicateCount} 个`);
});

elements.companiesText.addEventListener("input", () => updateCompanyCount());

elements.resultFileSelect.addEventListener("change", () => {
  refreshResults(elements.resultFileSelect.value);
});

elements.warningLevelFilter.addEventListener("change", () => {
  renderResults(currentResults);
});

elements.downloadBtn.addEventListener("click", (event) => {
  if (elements.downloadBtn.getAttribute("aria-disabled") === "true") {
    event.preventDefault();
  }
});

window.addEventListener("hashchange", () => {
  const viewName = location.hash.replace("#", "");
  if (viewName) switchView(viewName);
});

window.addEventListener("unhandledrejection", (event) => {
  showToast(event.reason?.message || "操作失败");
});

window.addEventListener("error", (event) => {
  showToast(event.message || "页面异常");
});

const initialView = location.hash.replace("#", "") || "dashboard";
switchView(initialView);
loadState().then(connectEvents).catch((error) => showToast(error.message));
