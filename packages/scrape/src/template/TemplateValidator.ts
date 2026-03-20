import { log, TemplateValidationError } from "@anycrawl/libs";
import type { DomainRestriction, DomainValidationResult } from "@anycrawl/libs";
import { DomainValidator } from "@anycrawl/template-client";
import type { CrawlingContext } from "../types/engine.js";

export { TemplateValidationError } from "@anycrawl/libs";
export type { DomainRestriction } from "@anycrawl/libs";

export type TemplateValidationResult = DomainValidationResult;

/**
 * Template validator for pre-navigation validation
 */
export class TemplateValidator {
    /**
     * Validate template configuration and domain restrictions
     * @param context - The crawling context
     * @param templateId - The template ID to validate
     * @param domainRestriction - Domain restriction configuration
     * @returns Promise<TemplateValidationResult>
     */
    public static async validateTemplate(
        context: CrawlingContext,
        templateId: string,
        domainRestriction?: DomainRestriction
    ): Promise<TemplateValidationResult> {
        try {
            // 1. Validate template ID format
            const templateIdValidation = this.validateTemplateId(templateId);
            if (!templateIdValidation.isValid) {
                return templateIdValidation;
            }

            // 2. Validate domain restrictions
            if (domainRestriction) {
                const domainValidation = this.validateDomainRestriction(context, domainRestriction);
                if (!domainValidation.isValid) {
                    return domainValidation;
                }
            }

            // 3. Validate template availability (placeholder for future implementation)
            const availabilityValidation = await this.validateTemplateAvailability(templateId);
            if (!availabilityValidation.isValid) {
                return availabilityValidation;
            }

            return {
                isValid: true
            };
        } catch (error) {
            log.error(`Template validation error: ${error instanceof Error ? error.message : String(error)}`);
            return {
                isValid: false,
                error: `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
                code: 'VALIDATION_ERROR'
            };
        }
    }

    /**
     * Validate template ID format
     * @param templateId - The template ID to validate
     * @returns TemplateValidationResult
     */
    private static validateTemplateId(templateId: string): TemplateValidationResult {
        if (!templateId || typeof templateId !== 'string') {
            return {
                isValid: false,
                error: 'Template ID is required and must be a string',
                code: 'INVALID_TEMPLATE_ID'
            };
        }

        if (templateId.trim().length === 0) {
            return {
                isValid: false,
                error: 'Template ID cannot be empty',
                code: 'EMPTY_TEMPLATE_ID'
            };
        }

        // Validate template ID format (alphanumeric, hyphens, underscores)
        const templateIdPattern = /^[a-zA-Z0-9_-]+$/;
        if (!templateIdPattern.test(templateId)) {
            return {
                isValid: false,
                error: 'Template ID can only contain alphanumeric characters, hyphens, and underscores',
                code: 'INVALID_TEMPLATE_ID_FORMAT'
            };
        }

        // Check length limits
        if (templateId.length > 100) {
            return {
                isValid: false,
                error: 'Template ID cannot exceed 100 characters',
                code: 'TEMPLATE_ID_TOO_LONG'
            };
        }

        return {
            isValid: true
        };
    }

    private static validateDomainRestriction(
        context: CrawlingContext,
        domainRestriction: DomainRestriction
    ): TemplateValidationResult {
        return DomainValidator.validateDomain(context.request.url, domainRestriction);
    }

    /**
     * Validate template availability (placeholder for future implementation)
     * @param templateId - The template ID to check
     * @returns Promise<TemplateValidationResult>
     */
    private static async validateTemplateAvailability(templateId: string): Promise<TemplateValidationResult> {
        // TODO: Implement actual template availability check
        // This could involve checking with the template server, cache, etc.

        // For now, just validate that the template ID is not in a blacklist
        const blacklistedTemplates = ['test-invalid', 'deprecated-template'];

        if (blacklistedTemplates.includes(templateId)) {
            return {
                isValid: false,
                error: `Template '${templateId}' is not available or has been deprecated`,
                code: 'TEMPLATE_NOT_AVAILABLE'
            };
        }

        return {
            isValid: true
        };
    }

    /**
     * Create a pre-navigation hook for template validation
     * @param templateId - The template ID to validate
     * @param domainRestriction - Optional domain restriction configuration
     * @returns Pre-navigation hook function
     */
    public static createPreNavigationHook(
        templateId: string,
        domainRestriction?: DomainRestriction
    ) {
        return async (context: CrawlingContext) => {
            log.debug(`Validating template '${templateId}' for URL: ${context.request.url}`);

            const validation = await this.validateTemplate(context, templateId, domainRestriction);

            if (!validation.isValid) {
                const error = new TemplateValidationError(
                    validation.error || 'Template validation failed',
                    validation.code || 'VALIDATION_ERROR'
                );

                log.error(`Template validation failed: ${error.message} (Code: ${error.code})`);
                throw error;
            }

            log.debug(`Template '${templateId}' validation passed for URL: ${context.request.url}`);
        };
    }

    public static parseDomainRestriction(targetSites?: string[]): DomainRestriction | undefined {
        if (!targetSites || targetSites.length === 0) {
            return undefined;
        }
        return DomainValidator.parseDomainRestriction(targetSites);
    }
}