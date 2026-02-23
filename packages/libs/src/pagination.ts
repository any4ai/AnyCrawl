type PaginationOptions = {
    defaultLimit?: number;
    defaultOffset?: number;
    maxLimit?: number;
};

/**
 * Normalize common limit/offset query parameters.
 */
export function normalizePagination(
    limitRaw?: string,
    offsetRaw?: string,
    options: PaginationOptions = {}
): { limit: number; offset: number } {
    const defaultLimit = Number.isInteger(options.defaultLimit) && (options.defaultLimit as number) > 0
        ? (options.defaultLimit as number)
        : 100;
    const defaultOffset = Number.isInteger(options.defaultOffset) && (options.defaultOffset as number) >= 0
        ? (options.defaultOffset as number)
        : 0;
    const maxLimit = Number.isInteger(options.maxLimit) && (options.maxLimit as number) > 0
        ? (options.maxLimit as number)
        : undefined;

    let limit = Number.parseInt(limitRaw || "", 10);
    if (!Number.isFinite(limit) || limit <= 0) {
        limit = defaultLimit;
    }
    if (typeof maxLimit === "number" && limit > maxLimit) {
        limit = maxLimit;
    }

    let offset = Number.parseInt(offsetRaw || "", 10);
    if (!Number.isFinite(offset) || offset < 0) {
        offset = defaultOffset;
    }

    return { limit, offset };
}
