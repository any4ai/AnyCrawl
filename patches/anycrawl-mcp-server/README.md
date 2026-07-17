# anycrawl-mcp-server MCP 修复补丁

Cloud Agent 对 `any4ai/anycrawl-mcp-server` 的修复因 bot 无 push 权限未能直接推送到 MCP 仓库，补丁保存在此目录。

## 在本机应用

你的本地目录如果是 `/Users/thans/working/AnyCrawl/anycrawl-mcp`，可以直接拉 AnyCrawl 分支拿完整修复版：

```bash
cd /Users/thans/working/AnyCrawl
git fetch origin cursor/mcp-server-fix-patch-984e
git checkout cursor/mcp-server-fix-patch-984e
# 修复版在 anycrawl-mcp/ 目录，见 anycrawl-mcp/SYNC.md
```

或单独 clone MCP 仓库后打补丁：

```bash
git clone https://github.com/any4ai/anycrawl-mcp-server.git
cd anycrawl-mcp-server
git checkout -b cursor/fix-mcp-routing-auth-984e
git am /path/to/anycrawl/patches/anycrawl-mcp-server/0001-fix-mcp-routing-auth.patch
npm ci && npm test && npm run build
git push -u origin cursor/fix-mcp-routing-auth-984e
```

若 `git am` 失败，可改用：

```bash
git apply --3way patches/anycrawl-mcp-server/0001-fix-mcp-routing-auth.patch
```

## 修复内容

- Nginx：`/` JSON 状态、`/{API_KEY}/messages` 路由、删除错误 catch-all、HEAD 探活
- 鉴权：云端建连时校验 API Key（TTL 缓存）
- 版本：1.0.4
- 测试与 README troubleshooting

## 发布后验证

```bash
curl https://mcp.anycrawl.dev/
curl -I https://mcp.anycrawl.dev/health
```
