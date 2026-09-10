# 自动化企业风险查询助手（企查查版）

一个在本机运行的企查查企业风险批量查询工具，提供可视化控制台、公司名单导入、规则配置、CSV 结果导出，以及可选的外部系统名单获取和结果回传能力。

本项目包含两个相互独立的版本：

| 版本 | 目录 | 查询范围 | 账号要求 | 默认端口 |
| --- | --- | --- | --- | --- |
| 基础版 | `basic/` | 企业风险概览中的自身风险及重要风险数量 | 普通企查查账号 | `18080` |
| 高级版 | `advanced/` | 被执行人、近 90 天被执行记录、商业合作纠纷（被告）等明细 | 需要可查看对应风险明细的企查查会员账号 | `18081` |

## 运行要求

- Windows 10/11
- Node.js 22 或更高版本
- Chrome 或 Edge
- Python 3（仅导入 `.xlsx`、`.xlsm` 时需要）
- Python 包 `openpyxl`（仅 Excel 导入需要）：`pip install openpyxl`

核心扫描和网页控制台没有 npm 第三方依赖。

基础版默认使用 Chrome 调试端口 `9222`，高级版默认使用 `9223`，两套浏览器登录态相互隔离。

如果系统中的 Python 可执行文件不叫 `python`，可以通过环境变量指定：

```powershell
$env:QCC_RISK_PYTHON = "D:\Python\python.exe"
```

## 快速开始

基础版：

```powershell
cd basic
.\run-qcc-risk-rpa-ui.bat
```

访问 `http://127.0.0.1:18080/`。

高级版：

```powershell
cd advanced
.\run-qcc-risk-rpa-v2-ui.bat
```

访问 `http://127.0.0.1:18081/`。

在页面中先点击登录企查查，再手工录入或导入公司名单并开始扫描。首次运行会在对应版本的 `runtime/` 下创建独立浏览器资料目录。

## 外部接口配置

外部接口不是运行扫描的必需条件。示例配置默认关闭名单获取和结果回传，用户可以直接手工录入公司并下载本地 CSV。

每个版本均提供 `backend-environments.example.json`。需要接入接口时，将它复制为同目录下的 `backend-environments.local.json`，再按实际环境修改。`*.local.json` 已被 `.gitignore` 排除。

也可以用环境变量指定其他配置文件：

```powershell
$env:QCC_RISK_BACKEND_CONFIG = "D:\config\qcc-risk-backends.json"
```

单个环境的配置结构：

```json
{
  "key": "production",
  "name": "线上环境",
  "baseUrl": "https://api.example.com",
  "production": true,
  "endpoints": {
    "fetchCompanies": {
      "enabled": true,
      "method": "GET",
      "path": "/api/risk-scan/companies",
      "monthQueryParam": "month",
      "timeoutMs": 10000,
      "headers": {}
    },
    "pushResults": {
      "enabled": true,
      "method": "POST",
      "path": "/api/risk-scan/records",
      "timeoutMs": 10000,
      "headers": {
        "Authorization": "Bearer ${RISK_API_TOKEN}"
      }
    }
  }
}
```

请求头支持 `${ENVIRONMENT_VARIABLE}` 形式的环境变量替换，避免把令牌直接写入配置文件。配置中的请求头不会返回给浏览器。

### 获取公司名单接口

配置项：`endpoints.fetchCompanies`。

程序在用户选择业务月份并点击“从系统同步”后调用该接口。默认请求形式：

```http
GET /api/risk-scan/companies?month=2026-08
Accept: application/json
```

支持以下任一 JSON 返回格式：

```json
["示例企业一", "示例企业二"]
```

```json
{ "data": ["示例企业一", "示例企业二"] }
```

也兼容数组位于 `companyNames` 或 `companies` 字段的对象。

### 扫描结果回传接口

配置项：`endpoints.pushResults`。扫描完成后需要用户在页面确认才会回传；配置为 `enabled: false` 时只生成本地 CSV。

默认使用 `POST` 和 `application/json`。基础版示例路径是 `/api/risk-scan/major-risks`，高级版示例路径是 `/api/risk-scan/records`，两者都可以独立修改。

公共批次字段包括：

```json
{
  "scanBatchId": "扫描批次标识",
  "bizMonth": "2026-08",
  "sourceFile": "结果文件名",
  "scannedCompanyCount": 0,
  "failedCompanyCount": 0,
  "records": []
}
```

基础版的 `records` 仅包含触发重大预警的自身风险结果；高级版包含已完整核验的当前状态和风险明细。准确字段以两个版本的 `risk-integration.mjs` 为准。

浏览器只访问本机控制台的同源 `/api`，外部接口由 Node.js 服务端请求，因此不依赖目标接口的浏览器 CORS 配置。

## 数据安全

以下内容不会包含在仓库中，并已加入 `.gitignore`：

- 公司名单和上传的 Excel 文件
- CSV 扫描结果及回传状态
- 浏览器 Cookie、企查查登录状态和缓存
- 本地接口配置、令牌和日志

发布前仍建议执行：

```powershell
npm run check
npm test
rg -n -i "token|secret|password|authorization|真实公司名称|内部域名" .
```

## 目录

```text
basic/       基础版源码、页面、规则和接口配置示例
advanced/    高级版源码、页面、规则和接口配置示例
scripts/     仓库检查脚本
tests/       外部接口配置测试
```

## 使用边界

本项目是非官方自动化工具，与企查查运营方不存在隶属或授权关系。“企查查”是其权利人的商标。使用者应遵守适用法律、目标网站服务条款、访问频率限制和账号权限，不得绕过验证码、会员权限或其他访问控制。

本项目不保证第三方网页结构长期稳定。企查查页面改版后，页面定位逻辑可能需要同步更新。

## 开源许可

本项目采用 [MIT License](LICENSE)。你可以使用、修改、分发和商业集成本项目代码，但必须保留原始版权声明和许可证文本。

### 随机扫描间隔

基础版和高级版的预警规则页面均支持配置最小和最大扫描间隔（秒）。每家公司扫描完成后，会在该范围内按毫秒随机等待一次；例如设置 5～15 秒，每家公司之间的等待时间都会重新随机生成。原有命令行参数 `--delay-ms` 仍可用于固定间隔。
