import express, { type Application, type ErrorRequestHandler } from "express";
import v1Router from "./routers/v1/index.js";
import v1PublicRouter from "./routers/v1/public.js";
import bodyParser from "body-parser";
import cors from "cors";
import morgan from "morgan";
import responseTime from "response-time";
import { logMiddleware } from "./middlewares/LogMiddleware.js";
import { authMiddleware } from "./middlewares/AuthMiddleware.js";
import { checkCreditsMiddleware } from "./middlewares/CheckCreditsMiddleware.js";
import { deductCreditsMiddleware } from "./middlewares/DeductCreditsMiddleware.js";
import { log, ConsoleStream } from "@anycrawl/libs/log";
import { appConfig } from "@anycrawl/libs";

export const app: Application = express();
const port = process.env.ANYCRAWL_API_PORT || 8080;

app.disable("x-powered-by");
app.use(cors());
app.use(
    morgan(process.env.NODE_ENV === "development" ? "dev" : "combined", {
        stream: new ConsoleStream(),
    })
);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Handle body parsing errors and client-aborted requests early
const bodyErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
    if (!err) return next();
    // Client closed connection during body read
    if ((err as any).type === "aborted" || (err as any).code === "ECONNRESET") {
        if (!res.headersSent) {
            res.status(400).json({ success: false, error: "request aborted" });
        }
        return;
    }
    // Payload too large (from body-parser/raw-body)
    if ((err as any).type === "entity.too.large" || (err as any).status === 413) {
        if (!res.headersSent) {
            res.status(413).json({ success: false, error: "payload too large" });
        }
        return;
    }
    return next(err as any);
};
app.use(bodyErrorHandler);

app.use(responseTime());
app.use(logMiddleware);

// Mount root router before auth middleware
app.get("/", (_req: express.Request, res: express.Response) => {
    res.send("Hello World");
});

// Health check endpoint
app.get("/health", (_req: express.Request, res: express.Response) => {
    res.status(200).json({ status: "ok" });
});

// load public routers
app.use("/v1/public", v1PublicRouter);

// check Auth
app.use(authMiddleware);
// check credits
app.use(checkCreditsMiddleware);
// deduct credits after successful requests
app.use(deductCreditsMiddleware);
// load routers
app.use("/v1", v1Router);

// Start the server
const server = app.listen(port, async () => {
    log.info(`✨ Server is running on port ${port}`);
    log.info(`🔐 Auth enabled: ${appConfig.authEnabled}`);
    log.info(`💳 Credits deduction enabled: ${appConfig.creditsEnabled}`);
});

// Align server timeouts with typical proxy defaults to reduce unexpected resets
try {
    // keepAliveTimeout must be less than headersTimeout to avoid ERR_HTTP_HEADERS_TIMEOUT
    // Values can be tuned with the proxy (e.g., Nginx keepalive_timeout 65s)
    (server as any).keepAliveTimeout = 70_000; // 70s
    (server as any).headersTimeout = 75_000;   // 75s
    // Allow long-running requests; set to 0 for no timeout or increase as needed
    // Node 18+: requestTimeout exists; ignored in older versions
    (server as any).requestTimeout = 0;
} catch { }

// Graceful shutdown handling
const gracefulShutdown = (signal: string) => {
    log.info(`🔄 Received ${signal}. Starting graceful shutdown...`);

    server.close((err) => {
        if (err) {
            log.error('❌ Error during server shutdown:', err);
            process.exit(1);
        }

        log.info('✅ Server closed gracefully');
        process.exit(0);
    });

    // Force shutdown if graceful shutdown takes too long
    setTimeout(() => {
        log.error('⚠️  Graceful shutdown timeout. Forcing exit...');
        process.exit(1);
    }, 10000); // 10 seconds timeout
};

// Handle process signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions and unhandled rejections
const isNonFatalNetworkError = (value: unknown): boolean => {
    const msg = typeof value === 'string'
        ? value
        : value instanceof Error
            ? `${value.name}: ${value.message}`
            : `${value}`;
    const lowered = msg.toLowerCase();
    return (
        lowered.includes('econnreset') ||
        lowered.includes('request aborted') ||
        lowered.includes('client aborted') ||
        lowered.includes('socket hang up') ||
        lowered.includes('connection reset by peer')
    );
};

process.on('uncaughtException', (err) => {
    if (isNonFatalNetworkError(err)) {
        log.warning(`⚠️  Uncaught non-fatal network exception suppressed: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    log.error('💥 Uncaught Exception:', err);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    if (isNonFatalNetworkError(reason)) {
        log.warning(`⚠️  Unhandled non-fatal rejection suppressed at: ${promise}`);
        return;
    }
    log.error(`💥 Unhandled Rejection at: ${promise} reason: ${reason}`);
    gracefulShutdown('UNHANDLED_REJECTION');
});

export { server };
