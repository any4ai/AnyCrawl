import { log } from "@anycrawl/libs";
import type { ChallengePlugin } from "./ChallengePlugin.js";

export class ChallengeOrchestrator {
    constructor(private readonly plugins: ChallengePlugin[]) {}

    async onPreNavigation(args: any): Promise<void> {
        for (const plugin of this.plugins) {
            if (!plugin.onPreNavigation) continue;
            try {
                await plugin.onPreNavigation(args);
            } catch (error) {
                log.warning(`[ChallengeOrchestrator] pre hook failed for ${plugin.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    async onPostNavigation(args: any): Promise<void> {
        for (const plugin of this.plugins) {
            if (!plugin.onPostNavigation) continue;
            try {
                await plugin.onPostNavigation(args);
            } catch (error) {
                log.warning(`[ChallengeOrchestrator] post hook failed for ${plugin.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    async enrichPayload(context: any, payload: any): Promise<any> {
        let result = payload;
        for (const plugin of this.plugins) {
            if (!plugin.enrichPayload) continue;
            try {
                result = await plugin.enrichPayload(context, result);
            } catch (error) {
                log.warning(`[ChallengeOrchestrator] enrich failed for ${plugin.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return result;
    }
}
