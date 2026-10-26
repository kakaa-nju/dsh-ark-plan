# dsh-ark-plan

火山方舟 Agent Plan 的 DSH 插件：把套餐可用模型自动同步进 `llm-pi-ai` Provider，并在 Web GUI 中显示 5 小时 / 每日 / 每周 / 每月 AFP 额度。

## 功能

- **模型目录**：通过控制面接口 `ListAgentPlanVirtualModelID` 获取当前套餐开放的全部文本模型，连同上下文窗口、最大输出、输入模态一起整理。
- **逐模型开关**：设置页「方舟 Agent Plan」页为每个文本模型提供开关，打开则写入 `llm-pi-ai` 的 `arkcli-agent-plan` provider，关闭则从 provider 移除；未被手动干预过的模型默认加入，套餐新上架的模型会自动出现。
- **思考强度与多模态**：每个模型自动带上 `reasoningEfforts`，档位与方舟线上取值一一对应；能读图的模型自动声明 `input: [text, image]`。
- **额度显示**：展示 `AFPFiveHour` / `AFPDaily` / `AFPWeekly` / `AFPMonthly` 的已用、配额、百分比与重置倒计时。
- **两处展示**：设置页新增「方舟 Agent Plan」页；对话输入框下方显示一行额度摘要。

## 安装

```sh
dsh plugin add dsh-ark-plan
```

## 凭据

插件从 DSH 凭据服务读取以下键（`~/.dsh/.credentials.yaml`）：

| 键 | 用途 | 必需 |
|---|---|---|
| `ARKCLI_AGENT_PLAN_API_KEY` | 模型调用：Agent Plan 专属 API Key（写入 provider 的 `apiKeyEnv`） | 是（否则模型请求报 `MISSING_CREDENTIAL`） |
| `VOLC_ACCESS_KEY` / `VOLC_SECRET_KEY` | 控制面 OpenAPI V4 签名：模型目录与额度查询 | 是（额度与目录同步） |

> 两种鉴权不能互换：Agent Plan 专属 API Key 只用于数据面 `https://ark.cn-beijing.volces.com/api/plan/v3`；控制面 `open.volcengineapi.com` 只接受 AK/SK 的 V4 签名（与 `dsh-billing-balance` 的额度查询实现一致）。
