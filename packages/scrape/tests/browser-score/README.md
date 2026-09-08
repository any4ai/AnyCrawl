# Browser-score 测试类型

修改后的应用启动器可用 `--variants application` 验证，例如 `pnpm test:browser-score --variants application --sites browserscan,creepjs,sannysoft --headed`。它使用实际的应用启动参数、参数适配器及地域策略；仍不等于包含资源拦截、解题器、队列的完整 Worker 测试。

这是独立的浏览器评分/指纹验证类型。它运行真实 CloakBrowser 并保存检测站结果，不需要 API、Redis、数据库或业务 Worker，也不随普通 `pnpm test` 访问外网。

测试只复现指纹子链路；不是完整 AnyCrawl 抓取成功率或性能测试。生产启动选项、代理池、humanize、资源拦截与挑战处理仍需另外做完整链路验证。

## 检测标准

这些站点采用不同检测方法，不是统一行业评分规范。解析定义集中在 [scoring.ts](scoring.ts)。

| ID            | 来源                                                                                | 保留指标                                         | 判定与限制                                                                                      |
| ------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `browserscan` | [BrowserScan](https://www.browserscan.net/)                                         | authenticity 0–100、botDetected、扣分项、出口 IP | 必须有实际浏览器、IP 和检测结果；静态 HTML 的初始 100% 不算结果                                 |
| `creepjs`     | [CreepJS](https://abrahamjuliot.github.io/creepjs/)                                 | likeHeadless、headless、stealth 各自的百分比     | 必须完成 FP ID 计算；不能换算成真人概率，也不制造页面未提供的 trust score                       |
| `sannysoft`   | [Sannysoft](https://bot.sannysoft.com/)                                             | webdriverPassed、advancedPassed                  | 必须填充 UA 和明确检查结果；不合成数值评分                                                      |
| `recaptcha`   | [Google 演示页](https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php) | 后端验证的 score 0–1、action、hostname           | 只接受同一演示站验证接口返回 success=true 且合法数值的 score；token、前端占位文字均不能代替分数 |

reCAPTCHA 演示分数不代表 Google 账户信誉、其他网站或 Cloudflare 通过率。见 [Google 文档](https://developers.google.com/recaptcha/docs/v3)。

## 运行

从仓库根目录执行：

```bash
# 查看检测站和所有选项；不会启动浏览器
pnpm test:browser-score --help

# 原生 vs 历史注入组合；使用 .env 中的配置代理
pnpm test:browser-score --sites browserscan,creepjs,sannysoft --headed

# 完整四组对照；每轮生成一份指纹，注入组共享同一份
pnpm test:browser-score --sites browserscan,creepjs,sannysoft --variants native,fixed-only,inject-only,injected-fixed --rounds 2 --headed

# 全部四个检测站，包括可能无法访问的 reCAPTCHA 演示
pnpm test:browser-score --headed

# 对已确认的固定出口地域进行显式对齐测试；不要把示例时区直接用于所有代理
pnpm test:browser-score --sites browserscan,creepjs --variants native --timezone America/New_York --locale en-US --headed

# 只有显式选择 direct 才使用直连；缺少代理不会自动降级
pnpm test:browser-score --network direct --sites sannysoft --variants native --headed

# 给单一待验收配置设置阈值（示例值，不是通用标准）
pnpm test:browser-score --sites browserscan,creepjs,sannysoft --variants native --min-authenticity 75 --max-stealth 0 --require-webdriver --headed
```

可在包内运行相同命令，也可使用 `pnpm --filter @anycrawl/scrape test:browser-score ...`。

### 依赖和网络

- 需要 Node.js 20+、工作区依赖、已安装且可执行的 CloakBrowser 二进制。测试不下载浏览器、不自动升级内核，不自动切换 provider。
- 优先使用 `CLOAKBROWSER_BINARY_PATH` 指向明确的测试二进制；未设置时读取 CloakBrowser 缓存信息。使用自定义路径时可另设 `CLOAKBROWSER_VERSION` 声明准确构建版本，以支持上游的版本条件配置。
- 测试进程固定使用选中的本地二进制并关闭自动更新；不会改写 `.env` 或应用配置文件。
- 如果配置了 license 但没有缓存授权二进制，测试明确失败，不替换为免费内核。授权校验/容量仍可能在浏览器运行时限制启动。
- 默认 `--network configured`，从 `ANYCRAWL_PROXY_URL` 选择第 0 个条目；用 `--proxy-env VARIABLE_NAME --proxy-index N` 明确选择其他配置。代理凭据放环境变量，CLI 不接收凭据明文参数。
- `--headed`/`--headless` 覆盖模式；未传时遵循 `ANYCRAWL_HEADLESS` 的应用默认语义。Linux headed 需要可用显示服务。
- 上下文的 `ignoreHTTPSErrors` 遵循 `ANYCRAWL_IGNORE_SSL_ERROR`；这一环境值会影响证书错误是否阻止检测。
- 不使用真实用户 profile 或登录态。每个站点尝试建立新 context，轮次间关闭浏览器。

### 对照定义

| 变体             | 指纹                                                       | 视口                                                                   |
| ---------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `application`    | 实际应用启动器、原生指纹与应用地域策略                     | 应用适配器的原生 context 默认值                                        |
| `native`         | CloakBrowser 原生                                          | 遵循安装包的 context 默认值；headed 为 null，headless 根据内核版本选择 |
| `fixed-only`     | CloakBrowser 原生                                          | 1920×1080                                                              |
| `inject-only`    | 现有 fingerprint-generator/injector，Chrome minVersion=120 | 生成指纹的 screen 尺寸                                                 |
| `injected-fixed` | 同上                                                       | 再设置 1920×1080                                                       |

`injected-fixed` 保留 2026-09-07 的注入/视口组合做历史对照，不命名为“current”，避免生产配置以后改变却仍宣称测试代表现状。`application` 读取实际应用的共享启动参数和适配器，其他变体使用安装包的默认启动参数。每个变体使用独立浏览器，避免应用的进程级地域参数影响对照组。

默认变体为 native,injected-fixed。默认 1 轮，seed=42069，后续轮次递增 seed；1–10 轮，严格串行。原始生成指纹随报告保存，不挑选有利样本。

### 采样窗口与退出码

默认导航超时 45 秒、导航后结果窗口 45 秒，可分别设置 `--navigation-timeout-ms` 和 `--result-timeout-ms`。结果需结构完整且稳定至少 3 秒；BrowserScan 至少观察 20 秒、CreepJS 5 秒、Sannysoft 3 秒。reCAPTCHA 等待后端验证结果，不额外要求稳定窗口。

这些是有界采样规则，不是检测站提供的完成保证。站点结构变化、结果缺失或窗口不足时，记录 unavailable/error，绝不把占位内容当成通过。没有隐藏重试。

| 退出码 | 含义                                                                    |
| ------ | ----------------------------------------------------------------------- |
| 0      | 所有请求的观察均完成，且所有显式阈值通过。未设阈值时，仅表示采集完成    |
| 1      | 观察完成，但至少一个显式阈值不通过                                      |
| 2      | 配置/启动/采集/产物保存失败，或者至少一个结果不可用；已采集结果继续保存 |

阈值包括 `--min-authenticity`、`--max-stealth`、`--min-recaptcha`、`--require-webdriver`；适用于所有选中的变体。需要只验收候选配置时，单独选择该变体。为未选择的检测站设置阈值会报配置错误。

## 产物与历史基线

默认目录：仓库根目录 `output/playwright/browser-score/<时间戳>-<随机ID>/`。`--output DIRECTORY` 可改变父目录；每次仍创建新的子目录，避免覆盖历史结果。

- `report.json` / `report.md`：版本、运行条件、指标、阈值失败、可用性和错误。
- 每次尝试的 `.json` / `.txt` / `.png`：原始观察、页面文字与截图，失败时尽可能保存现场。
- `fingerprint-rN.json`：该轮注入使用的具体指纹。
- 结构化日志移除代理凭据、已知 license key 和 reCAPTCHA query token；截图及页面原文仍可能含检测站显示的公网 IP/地理位置，因此产物目录默认不入 Git。
- 不启动追踪、资源拦截或外部解题服务，不保存 reCAPTCHA token 作为指标。

BrowserScan 报出的出口会被汇总检查。`exitChanged=true` 表示配置代理实际轮换出口，跨次差异不能全部归因于浏览器设置；没有 IP 观测时不能宣称出口固定。

[历史基线](baselines/2026-09-07-macos-chromium145.json) 保留上一次真实测试的摘要与限制。它仅用于解释已有问题，不能作为所有 OS、IP 和版本的自动通过阈值；大体积截图仍保留在原实验产物中。

应用修改后的观察见 [应用基线](baselines/2026-09-07-application-native.json)。

## 离线验证与维护

```bash
pnpm test:browser-score:unit
pnpm typecheck:browser-score
```

解析/参数测试也会被 scrape 包的普通 Jest 测试发现，它们不访问外网。live runner 与普通测试匹配路径分离，不接入 Turbo 缓存或普通 CI 测试任务。整个测试目录不参与生产 TypeScript 构建和 Docker 上下文。

增加检测站时：在 scoring.ts 声明独立语义和解析器，补充有效结果、占位内容、零值及缺失结果的离线用例，再执行一次显式 live 验证。不把不同检测器合并成总分；站点失效时保留 unavailable，不自动替换来源。

## Sticky 生命周期实现验证

统一 sticky 开关、代理模板、普通/隔离模式及回退步骤见 [配置与使用说明](../../STICKY_PROXY.md)。相关单元回归覆盖双驱动租约、fallback 和取消清理；真实验收应使用生产 tsc + Node，保留失败记录，并分别检查长期轮换、无痕检测和业务结果。
