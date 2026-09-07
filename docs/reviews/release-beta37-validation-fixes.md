# beta.37 发布验收修复

2026-09-07。用户已授权修正验收中发现的测试契约、搜索错误传播及验证预算问题，并继续原发版任务。

## 原因与修改

- 抓取测试未请求 HTML 却读取 `data.html`，并要求 example.com 包含 `200 ok`。用例现在显式请求 HTML/Markdown，验证实际 `Example Domain` 内容；另保留默认只返回 Markdown 的回归。
- httpstat.us 的 403/404 目标在当前网络中出现 CONNECT/TLS 超时及 502，不能稳定提供目标状态。状态语义测试改为进程内启动的真实 HTTP origin 和仅允许连接该 origin 的 loopback 代理，继续经过 API、队列和 Cheerio Worker。实际 HTTP 404 按现有公开文档验证为失败抓取，修正原测试将它当成功的预期。
- 外部 example.com 和 expired.badssl.com 的三引擎请求保留，用于验证真实代理/浏览器与既有 SSL 策略。它们不证明商业代理访问外部 403/404 站点的覆盖；状态语义与外部连通性分别记录。
- JSON 抽取测试现在验证任务为 completed、JSON 存在且满足输出结构和实际页面内容。输入拒绝测试保持短预算，不调用 LLM。根数组沿用现有 `{items: [...]}` 输出包装。
- 真实抓取/JSON 请求使用 120 秒请求预算与 135 秒 Jest 预算，与 auto-proxy 的文档预算一致；真实多次 LLM 调用使用 120 秒功能预算，并输出耗时。未改变生产超时、模型或 provider，不将功能通过视为满足原来的 30 秒性能目标。
- AI 自定义提示词测试使用与抽取意图一致的 schema，验证公司名称按提示词转为大写、成立年份正确；不再同时要求 industry 必填和缺失。两段抽取仍校验分段数与有效内容。

## 搜索错误契约

- `SearchService` 检查上游 HTTP 状态，400/422 对应 `SearchServiceError` 的 `SEARCH_INVALID_REQUEST`；其余非 2xx 或传输错误对应 `SEARCH_UPSTREAM_ERROR`。错误消息不包含上游地址、凭据或原始错误正文。
- API 分别返回 HTTP 400/502，`success: false`，以及可用时的 `upstream_status`。正常零结果和空查询仍成功返回空数组。
- 多页搜索先收集全部页面；任一页失败时不交付成功页面回调，避免失败搜索提前派发后续抓取。失败页面回调仍被等待和记录；成功时按页顺序等待回调。
- API 将失败搜索记为 failed、发出既有失败 Webhook，并将请求计费归零，不写成功 Dataset 结果。
- 定时搜索沿用现有异常终结路径，因此上游失败不再被当作成功的空结果计费。Map 的搜索发现保留自身错误处理逻辑。

## 验证

- 新增 14 个 SearchService 回归：修复前 13 失败/1 通过，修复后 14 通过。覆盖 400/422、401/403/429/5xx、传输错误、正常空结果、空查询、顺序/并行多页失败和异步回调顺序。
- 全仓库 typecheck：16/16 任务通过，无缓存。
- 全套测试：15/15 任务通过，无缓存；706 tests 通过，保留原有 20 个 opt-in 跳过（API 17、scrape 3），没有新增 skip。API 12 suites / 102 tests、AI 20 tests 均通过。
- 实际调用原有 `custom/glm-4.5` 模型；本轮两段抽取耗时 85,173 ms，功能验证通过，不代表满足 30 秒性能目标。
- 隔离 SQLite 中的失败搜索已核验为 `status=failed`、`credits_used=0`、`total=1`、`completed=0`、`failed=1`。
- 最终生产构建：9/9 任务通过，无缓存；公开文档 330 页构建完成。
- OpenAPI 生成器及普通/template 规范同步搜索 400/502 响应；结构比较确认其他端点及响应未改变。规范更新后的 docs typecheck 和 production build 再次通过。

## Docs consulted

- [Jest 配置](../jest-config-guide.md)
- [搜索计费与后续抓取约定](../api/search-scrape-credits-and-templates.md)
- [缓存](../cache.md)
- [先前监控验收与迁移](./web-change-monitoring-fix-validation-2026-09-06.md)
- [中文抓取接口](../../apps/docs/content/docs/general/scrape.zh-cn.mdx)
- [英文搜索接口](../../apps/docs/content/docs/general/search.mdx)
- [中文搜索接口](../../apps/docs/content/docs/general/search.zh-cn.mdx)
