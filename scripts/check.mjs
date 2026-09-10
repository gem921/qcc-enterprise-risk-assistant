import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = [
  "basic/qcc-risk-rpa.mjs",
  "basic/qcc-risk-rpa-ui.mjs",
  "basic/risk-integration.mjs",
  "basic/ui/app.js",
  "advanced/qcc-risk-rpa-v2.mjs",
  "advanced/qcc-risk-rpa-v2-ui.mjs",
  "advanced/risk-integration.mjs",
  "advanced/ui/app.js",
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const textFiles = [...new Set([
  ...files,
  "README.md",
  "basic/README.md",
  "advanced/README.md",
  "basic/ui/index.html",
  "basic/ui/styles.css",
  "advanced/ui/index.html",
  "advanced/ui/styles.css",
  "basic/start-qcc-risk-rpa-ui.ps1",
  "advanced/start-qcc-risk-rpa-v2-ui.ps1",
  "basic/run-qcc-risk-rpa.bat",
  "basic/run-qcc-risk-rpa-ui.bat",
  "advanced/run-qcc-risk-rpa-v2.bat",
  "advanced/run-qcc-risk-rpa-v2-ui.bat",
  "basic/extract-excel-companies.py",
  "advanced/extract-excel-companies.py",
  "basic/risk-rules.json",
  "advanced/risk-rules-v2.json",
  "basic/backend-environments.example.json",
  "advanced/backend-environments.example.json",
])];

for (const file of textFiles) {
  const content = readFileSync(join(root, file), "utf8");
  if (/\?{3,}|\uFFFD/u.test(content)) {
    console.error(`发现疑似乱码或问号占位文本: ${file}`);
    process.exit(1);
  }
}

console.log(`Syntax checks passed for ${files.length} source files; text checks passed for ${textFiles.length} files.`);
