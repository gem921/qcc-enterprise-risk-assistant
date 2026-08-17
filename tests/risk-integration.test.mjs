import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchPendingCompanyNames as fetchBasicCompanies,
  pushMajorRiskBatch,
} from "../basic/risk-integration.mjs";
import {
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
