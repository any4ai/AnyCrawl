import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('nginx routing config', () => {
    const nginxConf = readFileSync(resolve(__dirname, '../../docker/nginx.conf'), 'utf8');

    test('serves JSON status on root path', () => {
        expect(nginxConf).toContain('location = /');
        expect(nginxConf).toContain('"service":"anycrawl-mcp"');
    });

    test('routes api-key prefixed messages to SSE upstream', () => {
        expect(nginxConf).toMatch(/location ~ \^\/\(\?<apikey>\[\^\/\]\+\)\/messages\$/);
        expect(nginxConf).toContain('rewrite ^/.*/messages$ /messages break;');
        expect(nginxConf).toContain('proxy_pass http://app_sse;');
    });

    test('does not keep generic api-key catch-all route', () => {
        expect(nginxConf).not.toMatch(/location ~ \^\/\(\?<apikey>\[\^\/\]\+\)\/\(\.\*\)\$/);
    });

    test('handles HEAD probes for health and MCP endpoints', () => {
        expect(nginxConf).toContain('location /health');
        expect(nginxConf).toContain('if ($request_method = HEAD) { return 200; }');
        expect(nginxConf).toContain('location /mcp');
        expect(nginxConf).toContain('location /sse');
    });
});
