import { log } from "@anycrawl/libs";
import type { CrawlingContext } from "../types/engine.js";

/**
 * Template hooks for pre-navigation and other lifecycle events
 */
export class TemplateHooks {

    /**
     * Create template execution hook for post-navigation processing
     * This hook can be used to execute template-specific logic after navigation
     * @param templateId - The template ID
     * @param templateVariables - Template variables
     * @returns Post-navigation hook function
     */
    public static createTemplateExecutionHook(templateId: string, templateVariables?: Record<string, any>) {
        return async (context: CrawlingContext) => {
            try {
                log.debug(`[templateExecutionHook] Executing template '${templateId}' for URL: ${context.request.url}`);

                // Template execution logic can be added here
                // This is a placeholder for future template execution hooks

                log.debug(`[templateExecutionHook] Template '${templateId}' execution completed for URL: ${context.request.url}`);
            } catch (error) {
                log.error(`[templateExecutionHook] Error in template execution hook: ${error instanceof Error ? error.message : String(error)}`);
                // Don't throw error to avoid breaking the crawling process
            }
        };
    }

    /**
     * Create template cleanup hook for post-processing cleanup
     * This hook can be used to clean up template-specific resources
     * @param templateId - The template ID
     * @returns Cleanup hook function
     */
    public static createTemplateCleanupHook(templateId: string) {
        return async (context: CrawlingContext) => {
            try {
                log.debug(`[templateCleanupHook] Cleaning up template '${templateId}' for URL: ${context.request.url}`);

                // Template cleanup logic can be added here
                // This is a placeholder for future template cleanup hooks

                log.debug(`[templateCleanupHook] Template '${templateId}' cleanup completed for URL: ${context.request.url}`);
            } catch (error) {
                log.error(`[templateCleanupHook] Error in template cleanup hook: ${error instanceof Error ? error.message : String(error)}`);
                // Don't throw error to avoid breaking the crawling process
            }
        };
    }

    /**
     * Get all template-related hooks for a given template
     * @param templateId - The template ID
     * @param templateVariables - Template variables
     * @param options - Hook options
     * @returns Object containing all template hooks
     */
    public static getTemplateHooks(
        templateId: string,
        templateVariables?: Record<string, any>,
        options?: {
            enableExecution?: boolean;
            enableCleanup?: boolean;
        }
    ) {
        const opts = {
            enableExecution: false,
            enableCleanup: false,
            ...options
        };

        return {
            executionHook: opts.enableExecution ? this.createTemplateExecutionHook(templateId, templateVariables) : null,
            cleanupHook: opts.enableCleanup ? this.createTemplateCleanupHook(templateId) : null
        };
    }
}