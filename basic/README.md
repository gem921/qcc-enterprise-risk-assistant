# 基础版

基础版读取企查查企业详情页风险概览，仅提取：

- 自身风险数量
- 其中的重要风险数量
- 企查分、匹配公司和企业详情链接

默认规则位于 `risk-rules.json`。普通账号能够看到上述概览时即可使用，不会进入会员风险明细页面。

## 启动

```powershell
.\run-qcc-risk-rpa-ui.bat
```

打开 `http://127.0.0.1:18080/`。

命令行方式：

```powershell
.\run-qcc-risk-rpa.bat --login
.\run-qcc-risk-rpa.bat --input data\company-lists\companies.csv
```

公司文件支持 CSV、TXT、XLSX 和 XLSM。Excel 导入需要 Python 3 与 `openpyxl`。

## 外部接口

`backend-environments.example.json` 中分别配置：

- `endpoints.fetchCompanies`：按月份获取公司名单。
- `endpoints.pushResults`：回传触发重大预警的自身风险结果。

示例接口默认关闭。复制为 `backend-environments.local.json` 并修改后启用，详细协议见仓库根目录 [README.md](../README.md)。

## 本地数据

运行产生的公司名单、结果、上传文件和浏览器资料位于 `data/`、`runtime/`，不要提交到公开仓库。
