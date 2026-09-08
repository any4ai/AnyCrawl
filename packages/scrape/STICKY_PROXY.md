# Sticky 代理与浏览器复用

浏览器仍使用 CloakBrowser。统一 sticky 管理在已选定代理后分配 session，保留现有 base、stealth、auto 和域名路由/fallback 规则。默认关闭，不提供单代理覆盖。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| ANYCRAWL_PROXY_STICKY_ENABLED | false | 统一开启浏览器 sticky 生命周期管理 |
| ANYCRAWL_PROXY_STICKY_TTL_SECS | 空 | 开启时必填，整数秒，必须大于 10；上限 2147483 秒 |
| ANYCRAWL_BROWSER_ISOLATE_CONTEXTS | true | 现有开关；false 使用普通共享 context |
| ANYCRAWL_KEEP_ALIVE | true | 现有引擎/浏览器池复用开关 |
| ANYCRAWL_BROWSER_GEOIP | true | 现有 CloakBrowser 出口地域解析开关 |

TTL 是应用可依赖的有效窗口，不会修改供应商设置。所有受管代理都必须支持从新 session 首次使用起至少保持该时长。应用无法从普通代理连接读取剩余期限。

配置位置保持不变：ANYCRAWL_PROXY_URL、ANYCRAWL_PROXY_STEALTH_URL 的逗号分隔列表、proxy 配置中的域名规则，以及请求的自定义 proxy。启用时，浏览器代理 URL 的用户名必须有且只有一个字面量 `{sessionId}` 占位符。例如：

```text
http://ACCOUNT-time-20-session-{sessionId}:PASSWORD@GATEWAY:PORT
```

应用替换成 16 位随机十六进制 session；不改其它凭据、time 参数、端口或地域。密码/主机/路径里的占位符不受支持。已知 Flashproxy EU 路由还会校验统一期限不超过用户名 time 参数。

供应商已经配置为至少 20 分钟、且所有代理均满足约定时，可使用：

```env
ANYCRAWL_PROXY_STICKY_ENABLED=true
ANYCRAWL_PROXY_STICKY_TTL_SECS=1200
ANYCRAWL_BROWSER_ISOLATE_CONTEXTS=false
ANYCRAWL_KEEP_ALIVE=true
ANYCRAWL_BROWSER_GEOIP=true
```

这只是配置示例；两分钟代理不能配成 1200。自动地域策略不要同时写死不相符的全局时区。API 和 worker 的普通/隔离配置应一致，以保持结果缓存策略一致。

## 生命周期

每个业务浏览器绑定独立 session，从首次代理使用前以单调时钟计时，包含 GeoIP 和启动。统一期限、分别计时，不集中定时重启全部浏览器。

保留 10 秒安全余量，剩余窗口必须覆盖整次浏览器请求的剩余预算。预算直接使用 Crawlee 已执行的外层请求超时，包含导航、处理和缓冲。当前工厂默认外层预算为 670 秒，不能用导航 hook 的 30 秒替代。

有效且有容量时复用；不足时停止接新任务并按需换代；安全期限到达后关闭。故障/退休先撤销分配资格，再清理。第一版没有预热，空闲到期后下一次请求会冷启动。

普通 context 在同一进程内共享 cookie、localStorage 等网站状态。每个新进程使用独立临时 profile；不承诺跨 session 或重启保存登录。

## 非浏览器请求与缓存

Cheerio、HttpClient 共用代理列表，但不建立浏览器租约。启用时，HTTP 请求前把模板展开为新的 session；已有具体 URL 保持原义。HTTP 请求不因此获得浏览器时区或持续身份保证。

域名 workingProxy 缓存保存稳定模板，不复活浏览器的旧运行 session。普通/隔离模式加入页面结果缓存标识；随机 session 不加入页面结果 key。旧模式缓存保留，但不会按新模式误命中。

## fallback 与错误

既有策略允许重试时，先选择允许的目标代理，再复用它的合格浏览器或创建新 session。不会在同一浏览器进程里换代理却保留旧时区。base 不新增 stealth 升级；auto/stealth 保留现有 tier 规则；自定义 URL 不新增备用池。

正常到期不伪造目标封锁或触发代理升级。期限/模板配置错误明确失败；超时不因错误包装而额外重试。目标 HTTP 401 认证挑战页仍受已有认证/blocked-status 行为限制，详见验证记录。

## 部署与回退

代码默认关闭。启用前核对供应商时长、模板、任务预算和部署资源，并在目标平台验收。环境配置通过正常部署重启生效，本功能不提供热切换。

关闭 sticky 时恢复具体代理 URL，不能继续把未展开模板发给代理。普通/隔离模式通过原开关单独恢复；API/worker 同步变更。

## 验证

相关回归位于 `src/__tests__/core/StickyBrowserManager.test.ts`、`src/__tests__/core/CloakBrowserLauncher.test.ts` 与 `src/__tests__/managers/StickyProxyFallback.test.ts`。从仓库根目录运行 `pnpm --filter @anycrawl/scrape test -- --runInBand`，以及 `pnpm --filter @anycrawl/libs test -- --runInBand`。生产构建使用 `pnpm --filter @anycrawl/scrape build`。

部署前应在实际平台验证代理认证、长期轮换、并发和取消清理。普通模式的指纹检测结果与业务抓取成功率需要分别验收。
