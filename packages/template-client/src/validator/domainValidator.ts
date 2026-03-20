import { minimatch } from "minimatch";
import type { DomainRestriction, DomainValidationResult } from "@anycrawl/libs";

export type { DomainRestriction, DomainValidationResult };

/**
 * Domain validator for template domain restrictions and keyword/pattern matching
 */
export class DomainValidator {
    /**
     * Generic pattern validation - can be used for domains, keywords, or any string matching
     * @param value - The string value to validate
     * @param restriction - Pattern restriction configuration
     * @param fieldName - Name of the field being validated (for error messages)
     * @returns DomainValidationResult
     */
    public static validatePattern(
        value: string,
        restriction?: DomainRestriction,
        fieldName: string = 'value'
    ): DomainValidationResult {
        if (!restriction || !restriction.patterns || restriction.patterns.length === 0) {
            return { isValid: true };
        }

        const normalizedValue = value.toLowerCase().trim();

        for (const pattern of restriction.patterns) {
            if (!pattern) continue;

            const normalizedPattern = pattern.toLowerCase().trim();

            if (restriction.type === 'exact') {
                if (normalizedValue === normalizedPattern) {
                    return { isValid: true };
                }
            } else if (restriction.type === 'glob') {
                if (minimatch(normalizedValue, normalizedPattern)) {
                    return { isValid: true };
                }
            }
        }

        return {
            isValid: false,
            error: `${fieldName} '${value}' is not allowed for this template. Allowed patterns: ${restriction.patterns.join(', ')}`,
            code: 'PATTERN_NOT_ALLOWED'
        };
    }

    /**
     * Validate if a URL is allowed based on domain restrictions
     * @param url - The URL to validate
     * @param domainRestriction - Domain restriction configuration
     * @returns DomainValidationResult
     */
    public static validateDomain(url: string, domainRestriction?: DomainRestriction): DomainValidationResult {
        try {
            if (!domainRestriction || !domainRestriction.patterns || domainRestriction.patterns.length === 0) {
                return { isValid: true };
            }

            const urlObj = new URL(url);
            const normalizedTarget = this.normalizeUrlForComparison(urlObj);

            for (const pattern of domainRestriction.patterns) {
                if (!pattern) continue;

                if (domainRestriction.type === 'exact') {
                    const normalizedPattern = this.normalizePatternForExact(pattern);
                    if (normalizedPattern && normalizedPattern === normalizedTarget) {
                        return { isValid: true };
                    }
                    if (urlObj.hostname.toLowerCase() === pattern.toLowerCase()) {
                        return { isValid: true };
                    }
                } else if (domainRestriction.type === 'glob') {
                    if (this.matchesGlobPattern(pattern, urlObj, normalizedTarget)) {
                        return { isValid: true };
                    }
                }
            }

            return {
                isValid: false,
                error: `URL '${normalizedTarget}' is not allowed for this template. Allowed patterns: ${domainRestriction.patterns.join(', ')}`,
                code: 'DOMAIN_NOT_ALLOWED'
            };
        } catch (error) {
            return {
                isValid: false,
                error: `Invalid URL format: ${error instanceof Error ? error.message : String(error)}`,
                code: 'INVALID_URL'
            };
        }
    }

    /**
     * Parse domain patterns from template metadata
     * @param allowedDomains - Allowed domains from template metadata
     * @returns DomainRestriction or undefined
     */
    public static parseDomainRestriction(allowedDomains: any): DomainRestriction | undefined {
        if (!allowedDomains || typeof allowedDomains !== 'object' && typeof allowedDomains !== 'string') {
            return undefined;
        }

        const parsed = this.parsePatternInput(allowedDomains);
        if (!parsed) {
            return undefined;
        }

        const { type = 'exact', patterns } = parsed;
        const normalizedPatterns = this.normalizePatterns(patterns);
        if (normalizedPatterns.length === 0) {
            return undefined;
        }

        return {
            type,
            patterns: normalizedPatterns
        };
    }

    private static normalizeUrlForComparison(url: URL): string {
        const pathname = url.pathname || '/';
        const queryString = url.search || '';
        const hash = url.hash || '';
        // Don't add trailing slash, keep the URL as-is for better glob matching
        return `${url.origin.toLowerCase()}${pathname}${queryString}${hash}`;
    }

    private static normalizePatternForExact(pattern: string): string | null {
        try {
            const parsed = new URL(pattern);
            return this.normalizeUrlForComparison(parsed);
        } catch {
            return null;
        }
    }

    private static normalizePatterns(patterns: unknown[]): string[] {
        const normalized: string[] = [];

        for (const pattern of patterns) {
            if (typeof pattern !== 'string') {
                continue;
            }

            const segments = pattern
                .split(',')
                .map((segment) => segment.trim())
                .filter((segment) => segment.length > 0);

            // Allow writing comma-delimited patterns for convenience in templates
            normalized.push(...segments);
        }

        return normalized;
    }

    private static parsePatternInput(input: unknown): { type?: DomainRestriction['type']; patterns: unknown[] } | undefined {
        if (typeof input === 'string') {
            return {
                type: 'exact',
                patterns: [input]
            };
        }

        if (Array.isArray(input)) {
            return {
                type: 'exact',
                patterns: input
            };
        }

        if (input && typeof input === 'object' && 'patterns' in input) {
            const { patterns, type } = input as { patterns?: unknown; type?: DomainRestriction['type'] };
            if (!Array.isArray(patterns)) {
                return undefined;
            }
            // Preserve explicit type (glob/exact) from template configuration
            return {
                type,
                patterns
            };
        }

        return undefined;
    }

    private static matchesGlobPattern(pattern: string, url: URL, normalizedTarget: string): boolean {
        const normalizedPattern = pattern.toLowerCase();
        const hostname = url.hostname.toLowerCase();
        const origin = url.origin.toLowerCase();
        const pathname = url.pathname || '/';
        const queryString = url.search || '';
        const hash = url.hash || '';
        const normalizedPathWithSlash = pathname === '/' ? '/' : pathname.replace(/\/+$/, '/');
        const normalizedPathNoSlash = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');

        // Generate multiple representations of the URL so various glob pattern formats work correctly
        // Example: For URL 'https://api.example.com/v1/data?q=test', we generate:
        //   - 'api.example.com' → matches pattern 'api.example.com' or '*.example.com'
        //   - 'https://api.example.com' → matches pattern 'https://api.example.com' or 'https://*.example.com'
        //   - 'api.example.com/v1/data/?q=test' → matches pattern 'api.example.com/v1/*'
        //   - 'https://api.example.com/v1/data?q=test' → matches pattern 'https://api.example.com/v1/*'
        // Using Set to automatically deduplicate entries (e.g., when pathname is '/')
        const candidates = new Set<string>([
            normalizedTarget,
            origin,
            `${origin}${normalizedPathWithSlash}`,
            `${origin}${normalizedPathNoSlash}`,
            `${origin}${normalizedPathWithSlash}${queryString}${hash}`,
            `${origin}${normalizedPathNoSlash}${queryString}${hash}`,
            hostname,
            `${hostname}${normalizedPathWithSlash}`,
            `${hostname}${normalizedPathNoSlash}`,
            `${hostname}${normalizedPathWithSlash}${queryString}${hash}`,
            `${hostname}${normalizedPathNoSlash}${queryString}${hash}`
        ]);

        // Include variant without leading slash when combining hostname + path
        if (normalizedPathNoSlash.startsWith('/') && normalizedPathNoSlash !== '/') {
            const pathWithoutSlash = normalizedPathNoSlash.slice(1);
            candidates.add(`${hostname}/${pathWithoutSlash}`);
            candidates.add(`${hostname}/${pathWithoutSlash}${queryString}${hash}`);
        }

        // Check all normalized variants against the glob pattern using standard minimatch behavior
        for (const candidate of candidates) {
            if (minimatch(candidate, normalizedPattern)) {
                return true;
            }
        }

        return false;
    }
}
