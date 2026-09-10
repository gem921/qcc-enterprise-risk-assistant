import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchPendingCompanyNames as fetchBasicCompanies,
  pushMajorRiskBatch,
} from "../basic/risk-integration.mjs";
import {
  createV2RiskBatch,
  fetchPendingCompanyNames as fetchAdvancedCompanies,
  pushV2RiskBatch,
} from "../advanced/risk-integration.mjs";

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

for (const [name, fetchCompanies] of [
  ["basic", fetchBasicCompanies],
  ["advanced", fetchAdvancedCompanies],
]) {
  test(`${name} uses the configured company endpoint`, async () => {
    let request;
    const companies = await fetchCompanies({
      backendUrl: "https://api.example.com",
      endpoint: {
        method: "GET",
        path: "/custom/company-source",
        monthQueryParam: "period",
        headers: { "x-api-key": "test-key" },
      },
      month: "2026-08",
      fetchImpl: async (url, options) => {
        request = { url, options };
        return jsonResponse({ data: [] });
      },
    });

    assert.deepEqual(companies, []);
    assert.equal(request.url, "https://api.example.com/custom/company-source?period=2026-08");
    assert.equal(request.options.headers["x-api-key"], "test-key");
  });
}

for (const [name, pushResults] of [
  ["basic", pushMajorRiskBatch],
  ["advanced", pushV2RiskBatch],
]) {
  test(`${name} uses the configured result endpoint`, async () => {
    let request;
    const result = await pushResults({
      backendUrl: "https://api.example.com",
      endpoint: {
        method: "POST",
        path: "/custom/result-callback",
        headers: { authorization: "Bearer test-token" },
      },
      payload: { records: [] },
      fetchImpl: async (url, options) => {
        request = { url, options };
        return jsonResponse({ data: 0 });
      },
    });

    assert.equal(result.count, 0);
    assert.equal(request.url, "https://api.example.com/custom/result-callback");
    assert.equal(request.options.headers.authorization, "Bearer test-token");
  });
}

test("advanced marks a complete successful batch as a full snapshot", () => {
  const payload = createV2RiskBatch({
    rows: [
      { "公司名称": "示例企业一", "状态": "成功", "预警等级": "正常" },
      { "公司名称": "示例企业二", "状态": "成功", "预警等级": "重大" },
    ],
    scanBatchId: "batch-full",
    bizMonth: "2026-09",
    expectedCompanyCount: 2,
    usedLimit: false,
  });

  assert.equal(payload.fullSnapshot, true);
  assert.equal(payload.scannedCompanyCount, 2);
  assert.equal(payload.failedCompanyCount, 0);
  assert.equal(payload.records.length, 2);
});

test("advanced does not mark limited or incomplete batches as full snapshots", () => {
  const rows = [
    { "公司名称": "示例企业一", "状态": "成功", "预警等级": "正常" },
  ];
  const limited = createV2RiskBatch({
    rows,
    scanBatchId: "batch-limited",
    bizMonth: "2026-09",
    expectedCompanyCount: 1,
    usedLimit: true,
  });
  const incomplete = createV2RiskBatch({
    rows,
    scanBatchId: "batch-incomplete",
    bizMonth: "2026-09",
    expectedCompanyCount: 2,
    usedLimit: false,
  });

  assert.equal(limited.fullSnapshot, false);
  assert.equal(incomplete.fullSnapshot, false);
});
