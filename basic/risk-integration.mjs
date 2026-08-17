const DEFAULT_BACKEND_URL = "http://127.0.0.1:8080";
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_FETCH_ENDPOINT = {
  enabled: true,
  method: "GET",
  path: "/api/risk-scan/companies",
  monthQueryParam: "month",
  headers: {},
};
const DEFAULT_PUSH_ENDPOINT = {
  enabled: true,
  method: "POST",
  path: "/api/risk-scan/major-risks",
  headers: {},
};

export function normalizeBackendUrl(value) {
  const normalized = String(value || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, "");
  return normalized || DEFAULT_BACKEND_URL;
}

export function createMajorRiskBatch({
  rows,
  scanBatchId,
  bizMonth = "",
  sourceFile = "",
  expectedCompanyCount = 0,
  usedLimit = false,
}) {
  const batchId = String(scanBatchId || "").trim();
  if (!batchId) {
    throw new Error("扫描批次不能为空");
  }

  const resultRows = Array.isArray(rows) ? rows : [];
  const scannedCompanyCount = resultRows.length;
  const failedCompanyCount = resultRows.filter((row) => row?.["状态"] !== "成功").length;
  const scannedCompanyNames = [...new Set(
    resultRows
      .filter((row) => row?.["状态"] === "成功")
      .map((row) => textOrEmpty(row?.["公司名称"]))
      .filter(Boolean),
  )];
  const normalizedExpectedCount = toNonNegativeInteger(expectedCompanyCount);
  const fullSnapshot = !usedLimit
    && normalizedExpectedCount > 0
    && scannedCompanyCount === normalizedExpectedCount
    && failedCompanyCount === 0;

  const records = resultRows
    .filter((row) => row?.["状态"] === "成功" && row?.["预警等级"] === "重大")
    .map((row) => ({
      companyName: textOrEmpty(row["公司名称"]),
      scanStatus: textOrEmpty(row["状态"]),
      riskLevel: textOrEmpty(row["预警等级"]),
      riskSummary: textOrEmpty(row["预警摘要"]),
      matchedCompanyName: textOrEmpty(row["匹配公司"]),
      qccUrl: textOrEmpty(row["企查查链接"]),
      qccScore: textOrEmpty(row["企查分"]),
      ownRisk: toNullableInteger(row["自身风险"]),
      ownRiskImportant: toNullableInteger(row["自身风险_重要"]),
      errorMessage: textOrEmpty(row["错误信息"]),
      checkTime: textOrEmpty(row["检查时间"]),
    }))
    .filter((record) => record.companyName);

  return {
    scanBatchId: batchId,
    bizMonth: normalizeMonth(bizMonth),
    sourceFile: String(sourceFile || "").trim(),
    fullSnapshot,
    scannedCompanyCount,
    failedCompanyCount,
    scannedCompanyNames,
    records,
  };
}

export async function pushMajorRiskBatch({
  backendUrl = DEFAULT_BACKEND_URL,
  endpoint = DEFAULT_PUSH_ENDPOINT,
  payload,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!payload || !Array.isArray(payload.records)) {
    throw new Error("重大风险推送数据格式错误");
  }

  const resolved = resolveEndpoint(backendUrl, endpoint, DEFAULT_PUSH_ENDPOINT);
  const data = await requestBackendJson(
    resolved.url,
    {
      method: resolved.method,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...resolved.headers,
      },
      body: JSON.stringify(payload),
    },
    fetchImpl,
    resolved.timeoutMs || timeoutMs,
  );

  return {
    count: Number.isFinite(Number(data.data)) ? Number(data.data) : payload.records.length,
  };
}

export async function fetchPendingCompanyNames({
  backendUrl = DEFAULT_BACKEND_URL,
  endpoint = DEFAULT_FETCH_ENDPOINT,
  month,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const normalizedMonth = normalizeMonth(month);
  const resolved = resolveEndpoint(backendUrl, endpoint, DEFAULT_FETCH_ENDPOINT);
  const url = new URL(resolved.url);
  if (resolved.monthQueryParam) {
    url.searchParams.set(resolved.monthQueryParam, normalizedMonth);
  }
  const data = await requestBackendJson(
    url.toString(),
    {
      method: resolved.method,
      headers: { accept: "application/json", ...resolved.headers },
    },
    fetchImpl,
    resolved.timeoutMs || timeoutMs,
  );
  const values = Array.isArray(data)
    ? data
    : Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.companyNames)
        ? data.companyNames
        : Array.isArray(data.companies)
          ? data.companies
          : null;

  if (!values) {
    throw new Error("系统公司名单接口返回格式错误");
  }

  return [...new Set(values.map((value) => textOrEmpty(value)).filter(Boolean))];
}

function normalizeMonth(value) {
  const month = String(value || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("月份格式应为 YYYY-MM");
  }
  return month;
}

function textOrEmpty(value) {
  return value == null ? "" : String(value).trim();
}

function toNullableInteger(value) {
  const text = textOrEmpty(value).replace(/,/g, "");
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function toNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function resolveEndpoint(backendUrl, endpoint, defaults) {
  const config = endpoint && typeof endpoint === "object" ? endpoint : {};
  if (config.enabled === false) {
    throw new Error("当前环境未启用该接口");
  }

  const path = String(config.path || defaults.path).trim();
  if (!path) {
    throw new Error("接口路径不能为空");
  }

  const url = /^https?:\/\//i.test(path)
    ? path
    : new URL(path.replace(/^\/+/, ""), `${normalizeBackendUrl(backendUrl)}/`).toString();
  const rawTimeout = Number(config.timeoutMs);
  return {
    url,
    method: String(config.method || defaults.method).trim().toUpperCase(),
    monthQueryParam: String(config.monthQueryParam ?? defaults.monthQueryParam ?? "").trim(),
    headers: config.headers && typeof config.headers === "object" ? config.headers : {},
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : 0,
  };
}

async function requestBackendJson(url, options, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`后端返回了无效 JSON: HTTP ${response.status}`);
    }

    const result = unwrapBackendResult(data);
    if (!response.ok) {
      throw new Error(result.message || `后端请求失败: HTTP ${response.status}`);
    }
    if (result.status === false) {
      throw new Error(result.message || "后端业务处理失败");
    }
    return result;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`后端请求超时（${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function unwrapBackendResult(value) {
  let result = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const nested = result?.data;
    const isWrappedResult = nested
      && typeof nested === "object"
      && !Array.isArray(nested)
      && ("data" in nested || "status" in nested || "code" in nested || "message" in nested);
    if (!isWrappedResult) break;
    result = nested;
  }
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") return result;
  return result == null ? {} : { data: result };
}
