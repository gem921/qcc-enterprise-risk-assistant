# 高级版

高级版会从企查查自身风险入口进入会员风险明细页，核验：

- 被执行人总数、近 30 天和近 90 天记录
- 被执行金额与立案日期
- 商业合作纠纷（被告）总数及近 30 天记录
- 自身风险概览和实际匹配企业名称

默认规则位于 `risk-rules-v2.json`：

- 近 30 天存在被执行记录：重大
- 近 30 天存在商业合作纠纷（被告）：高危
- 近 90 天存在被执行记录：提示

查看明细需要具备相应企查查会员权限。有自身风险不代表一定触发预警；上述两类明细为 0 时可以判定为正常。

## 启动

```powershell
.\run-qcc-risk-rpa-v2-ui.bat
```

打开 `http://127.0.0.1:18081/`。

命令行方式：

```powershell
.\run-qcc-risk-rpa-v2.bat --login
.\run-qcc-risk-rpa-v2.bat --input data\company-lists\companies.csv
```

当公司名称无法精确匹配时，页面模式会暂停并列出候选。业务人员在浏览器中进入正确企业详情页后点击“继续”；无人值守模式不会自动猜测企业。

## 外部接口

`backend-environments.example.json` 中分别配置：

- `endpoints.fetchCompanies`：按月份获取公司名单。
- `endpoints.pushResults`：回传已核验的正常、提示、高危和重大结果。

示例接口默认关闭。复制为 `backend-environments.local.json` 并修改后启用，详细协议见仓库根目录 [README.md](../README.md)。

## 本地数据

运行产生的公司名单、结果、上传文件和浏览器资料位于 `data/`、`runtime/`，不要提交到公开仓库。

## 扫描间隔

预警规则页面支持设置最小间隔和最大间隔（秒）。每家公司完成后会在配置范围内重新随机等待一次，例如 5～15 秒；命令行仍兼容 `--delay-ms` 固定间隔参数。