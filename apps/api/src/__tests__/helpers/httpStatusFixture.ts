import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

/** A real HTTP origin and loopback-only forwarding proxy for status tests. */
export async function startHttpStatusFixture() {
    const sockets = new Set<Socket>();
    const hits = new Map<number, number>();
    const server = createServer((req, res) => {
        const path = new URL(req.url || "/", "http://fixture.local").pathname;
        const status = path === "/status/403" ? 403 : path === "/status/404" ? 404 : 200;
        hits.set(status, (hits.get(status) || 0) + 1);
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Connection": "close" });
        res.end(`<html><head><title>HTTP ${status}</title></head><body><main>${status} ${status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "OK"}</main></body></html>`);
    });
    server.on("connection", socket => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    server.on("connect", (req, client, head) => {
        const destination = new URL(`http://${req.url}`);
        const port = (server.address() as AddressInfo).port;
        if (destination.hostname !== "127.0.0.1" || Number(destination.port) !== port) {
            client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
            return;
        }
        const upstream = connect(port, "127.0.0.1", () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            client.pipe(upstream);
            upstream.pipe(client);
        });
        client.on("error", () => upstream.destroy());
        client.on("close", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        url,
        hits,
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}
