# 真实供应商验收

常规 `npm run verify` 完全使用本机夹具，不会调用供应商。真实验收是独立、显式执行的入口，会产生供应商费用。

先在当前终端通过自己的密钥管理方式设置 `SENTINEL_API_KEY` 环境变量。脚本不会读取Codex配置、导入浏览器密钥或把认证写入报告。以下URL和模型均为占位示例，需要替换为自己供应商的实际值。

```sh
# 发现模型，不发送答题请求
node scripts/live.cjs --url https://api.example.com/v1/responses --models

# 默认仅一次原题请求：16输出token、none推理、60秒超时
node scripts/live.cjs --url https://api.example.com/v1/responses --model YOUR_MODEL --output smoke.local.json

# 显式完整矩阵：原题与五维轮换，共6次；加--chat另测Chat原题，共7次
node scripts/live.cjs --url https://api.example.com/v1/responses --model YOUR_MODEL --matrix --chat --token-ceiling 4000 --output matrix.local.json

node scripts/live.cjs --help
```

不使用 `/v1` 的服务应填完整 `/responses` 端点。仅调用指定协议和模型，不自动重试、切换路由或扩大预算。支持显式 `--budget`、`--effort`，默认分别为16和none；`--chat` 必须与 `--matrix` 一起使用。

`--token-ceiling` 是**已报告总token的批次停止线**，包括供应商报告的缓存token，默认4000。每个请求完成后检查累计值，到线后不发下一题；401/403或用量未知时也不发下一题。供应商可能忽略输出限制，因此单次就可能超线，不能据此保证账单上限。此规则只约束手动验收批次，正常自动监测的超时继续规则不变。

报告文件必须以 `.local.json` 结尾，已加入Git忽略与打包排除。脚本在请求前独占创建目标文件，目录缺失、无法写入、文件已存在或参数错误均在付费请求前退出。每次响应在下一题发送前通过同步临时文件和原子替换保存，保留原题、标准答案、用量、判定、请求ID和脱敏诊断；后续写入失败时停止追加请求，并保留上一次完整报告。文件状态为 `running` 时表示仍在执行或进程曾被中断，应先查看已有记录，避免重复调用。报告可能包含自己的供应商地址和题目，不应直接公开上传。

答对始终通过；超预算、产生推理token或供应商回传参数不同，只添加提示。命令退出码0表示计划内题目全部答对；1表示存在未通过、批次提前停止或工具错误，详情以各条记录为准。报告中的 `knownTokens` 是供应商自报数量，不是费用金额，也不能证明实际模型身份。

工具不会操作Codex会话。实机停止兼容性与供应商答题验收分别说明于[验证范围](validation.md)。
