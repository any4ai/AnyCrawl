# anycrawl-mcp

Fixed MCP server snapshot (v1.0.4) exported from Cloud Agent.

This directory mirrors the standalone repo `any4ai/anycrawl-mcp-server` and matches a local checkout named `anycrawl-mcp`.

## Sync to your machine

If your local layout is `/Users/thans/working/AnyCrawl/anycrawl-mcp`:

```bash
cd /Users/thans/working/AnyCrawl
git pull origin cursor/mcp-server-fix-patch-984e

# backup first
mv anycrawl-mcp anycrawl-mcp.bak

# copy fixed snapshot
cp -a AnyCrawl/anycrawl-mcp ./anycrawl-mcp
cd anycrawl-mcp
npm ci && npm test && npm run build
```

Or apply only the diff patch:

```bash
cd /Users/thans/working/AnyCrawl/anycrawl-mcp
git checkout -b cursor/fix-mcp-routing-auth-984e
git am ../AnyCrawl/patches/anycrawl-mcp-server/0001-fix-mcp-routing-auth.patch
```

## What changed

- Nginx routing fixes for `/`, `/{API_KEY}/messages`, HEAD probes
- Cloud API key validation on connect with TTL cache
- Version bump to 1.0.4

See `../patches/anycrawl-mcp-server/README.md` for details.
