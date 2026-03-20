import { Response, NextFunction } from "express";
import { getDB, schemas, eq } from "@anycrawl/db";
import { RequestWithAuth, appConfig } from "@anycrawl/libs";
import { log } from "@anycrawl/libs/log";
import { getClientIp, isIpAllowed } from "../utils/ipUtils.js";
export const authMiddleware = async (
    req: RequestWithAuth,
    res: Response,
    next: NextFunction
): Promise<void> => {
    if (!appConfig.authEnabled) {
        next();
        return;
    }
    // Get API key from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        res.status(401).json({ success: false, error: "No authorization header provided" });
        return;
    }

    // Check if it's Bearer token
    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
        res.status(401).json({ success: false, error: "Invalid authorization header format" });
        return;
    }

    const apiKey = parts[1];

    try {
        // Verify API key exists and is active
        const db = await getDB();
        const keyRecord = await db
            .select()
            .from(schemas.apiKey)
            .where(eq(schemas.apiKey.key, apiKey))
            .limit(1);

        if (!keyRecord || keyRecord.length === 0) {
            res.status(401).json({ success: false, error: "Invalid API key" });
            return;
        }

        const key = keyRecord[0];

        if (!key.isActive) {
            res.status(401).json({ success: false, error: "API key is inactive" });
            return;
        }

        // Check IP whitelist if configured
        if (key.allowedIps && key.allowedIps.length > 0) {
            const clientIp = getClientIp(req);
            if (!isIpAllowed(clientIp, key.allowedIps)) {
                res.status(403).json({
                    success: false,
                    error: "IP address not allowed",
                    clientIp: clientIp || "unknown",
                });
                return;
            }
        }

        // Add API key info to request for use in other middlewares
        req.auth = key;

        next();
    } catch (error) {
        log.error(`Error validating API key: ${error}`);
        res.status(500).json({ success: false, error: "Internal server error" });
        return;
    }
};
