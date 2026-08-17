import { spawnSync } from "node:child_process";
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

console.log(`Syntax check passed for ${files.length} files.`);
