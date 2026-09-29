import type { OwnerContext } from "@anycrawl/libs";
import { and, eq, gt, gte, lt, lte, or, sql } from "drizzle-orm";
import { schemas } from "../db/index.js";
import { resolveDatasetOwnerScope } from "./DatasetAccess.js";

type DBExecutor = any;

const IS_SQLITE = process.env.ANYCRAWL_API_DB_TYPE?.toLowerCase() === "sqlite";

// Sentinel used to sort NULL run-item sequences deterministically last (max int32).
const SEQUENCE_NULLS_LAST = 2147483647;

export type FieldType = "string" | "number" | "boolean" | "timestamptz";
export type FilterOp = "eq" | "in" | "lt" | "lte" | "gt" | "gte";

export interface ItemFilter {
    field: string;
    fieldType: FieldType;
    /** RFC 6901 JSON pointer into the document ("/price/amount" or "price"). */
    path: string;
    op: FilterOp;
    /** Raw string value(s) from the query string; coerced to `fieldType` at bind time. */
    values: string[];
}

export interface ItemSort {
    field: string;
    fieldType: FieldType;
    /** RFC 6901 JSON pointer into the document. */
    path: string;
    dir: "asc" | "desc";
}

/** One queryable field: its document path + type. */
export interface ProjectionCatalogEntry {
    path: string;
    type: FieldType;
}

export interface CursorKey {
    v: string | number | boolean | null;
    id: string;
}

export interface PageResult {
    items: any[];
    nextCursor: CursorKey | null;
}

const OP_SQL: Record<Exclude<FilterOp, "in">, any> = {
    eq: sql`=`,
    lt: sql`<`,
    lte: sql`<=`,
    gt: sql`>`,
    gte: sql`>=`,
};

// --- jsonb-direct query helpers (replaces the EAV field_values layer) ---------

/**
 * Parse an RFC 6901 JSON pointer ("/a/b" or the shorthand "a") into path segments,
 * unescaping `~1` -> `/` and `~0` -> `~` (in that order) so keys containing `/`
 * or `~` resolve correctly. Mirrors DatasetWriter.getPath.
 */
function pathSegments(path: string): string[] {
    return String(path)
        .split("/")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** SQLite json path ($."a"."b") with embedded quotes doubled. */
function sqliteJsonPath(segs: string[]): string {
    return "$" + segs.map((s) => `."${s.replace(/"/g, '""')}"`).join("");
}

/** Postgres text[] path literal (ARRAY['a','b']::text[]) with bound elements. */
function pgPathArray(segs: string[]): any {
    return sql`ARRAY[${sql.join(segs.map((s) => sql`${s}`), sql`, `)}]::text[]`;
}

/**
 * Typed scalar expression extracting `segs` from the document, cast for the field
 * type so range/sort comparisons are correct in each dialect.
 *   PG:     (document #>> '{a,b}')::<numeric|boolean|timestamptz|text>
 *   SQLite: json_extract(document, '$.a.b')  (CAST to REAL for numbers)
 */
function fieldExpr(segs: string[], type: FieldType): any {
    const col = schemas.datasetItems.document;
    if (IS_SQLITE) {
        const base = sql`json_extract(${col}, ${sqliteJsonPath(segs)})`;
        // json_extract already yields native INTEGER/REAL/TEXT and 1/0 for JSON
        // booleans; timestamps live as ISO-8601 text (lexicographically ordered).
        return type === "number" ? sql`CAST(${base} AS REAL)` : base;
    }
    const extract = sql`(${col} #>> ${pgPathArray(segs)})`;
    switch (type) {
        case "number":
            return sql`(${extract})::numeric`;
        case "boolean":
            return sql`(${extract})::boolean`;
        case "timestamptz":
            return sql`(${extract})::timestamptz`;
        default:
            return extract; // text
    }
}

/** Render a comparison RHS literal, dialect + type aware, from a raw/scalar value. */
function typedLiteral(type: FieldType, raw: string | number | boolean | null): any {
    if (raw === null || raw === undefined) return sql`NULL`;
    switch (type) {
        case "number":
            return sql`${Number(raw)}`;
        case "boolean": {
            const b = raw === true || raw === 1 || raw === "true" || raw === "1";
            return IS_SQLITE ? sql`${b ? 1 : 0}` : sql`${b}`;
        }
        case "timestamptz": {
            const iso =
                typeof raw === "number"
                    ? new Date(raw).toISOString()
                    : new Date(String(raw)).toISOString();
            return IS_SQLITE ? sql`${iso}` : sql`${iso}::timestamptz`;
        }
        default:
            return sql`${String(raw)}`;
    }
}

/** jsonb_build_object value for a fast top-level eq containment (PG only). */
function containmentValue(type: FieldType, raw: string): any {
    switch (type) {
        case "number":
            return sql`${Number(raw)}::numeric`;
        case "boolean":
            return sql`${raw === "true" || raw === "1"}::boolean`;
        default:
            return sql`${String(raw)}::text`;
    }
}

/** Build a single filter predicate against the document jsonb. */
function filterCondition(f: ItemFilter): any {
    const segs = pathSegments(f.path);

    // Fast PG eq: single top-level key, non-timestamp → jsonb containment (GIN).
    if (!IS_SQLITE && f.op === "eq" && segs.length === 1 && f.fieldType !== "timestamptz") {
        // Cast the key to text: jsonb_build_object is variadic "any", so an untyped
        // bind param makes PG error "could not determine data type of parameter".
        return sql`${schemas.datasetItems.document} @> jsonb_build_object(${segs[0]}::text, ${containmentValue(f.fieldType, f.values[0] ?? "")})`;
    }

    const expr = fieldExpr(segs, f.fieldType);
    if (f.op === "in") {
        const list = f.values.map((v) => typedLiteral(f.fieldType, v));
        return sql`${expr} IN (${sql.join(list, sql`, `)})`;
    }
    return sql`${expr} ${OP_SQL[f.op]} ${typedLiteral(f.fieldType, f.values[0] ?? "")}`;
}

/** Normalize a projection value read back from the DB into a compact cursor value. */
function projectionToCursorValue(fieldType: FieldType, dbVal: any): CursorKey["v"] {
    if (dbVal === null || dbVal === undefined) return null;
    switch (fieldType) {
        case "string":
            return String(dbVal);
        case "number":
            return Number(dbVal);
        case "boolean":
            return !!dbVal;
        case "timestamptz":
            if (dbVal instanceof Date) return dbVal.getTime();
            if (typeof dbVal === "number") return dbVal;
            return new Date(dbVal).getTime();
    }
}

/** Keyset predicate for a typed jsonb sort expression with a typed bound literal. */
function projectionKeyset(
    expr: any,
    uuidCol: any,
    dir: "asc" | "desc",
    type: FieldType,
    cursor: CursorKey
): any {
    const bound = typedLiteral(type, cursor.v);
    if (dir === "desc") {
        return sql`(${expr} < ${bound} OR (${expr} = ${bound} AND ${uuidCol} < ${cursor.id}))`;
    }
    return sql`(${expr} > ${bound} OR (${expr} = ${bound} AND ${uuidCol} > ${cursor.id}))`;
}

/**
 * Keyset predicate for a real timestamp column (created_at / last_seen_at). The
 * cursor value is epoch millis; drizzle encodes the Date per dialect. Exported
 * so sibling child-table models (e.g. DatasetExport) reuse the same keyset
 * logic instead of reimplementing timestamp-cursor pagination.
 */
export function timestampKeyset(col: any, uuidCol: any, dir: "asc" | "desc", cursor: CursorKey): any {
    const d = new Date(Number(cursor.v));
    if (dir === "desc") {
        return or(lt(col, d), and(eq(col, d), lt(uuidCol, cursor.id)));
    }
    return or(gt(col, d), and(eq(col, d), gt(uuidCol, cursor.id)));
}

/**
 * Trim a limit+1 fetch and derive the next timestamp cursor from the last row.
 * Exported standalone (mirrored by `Dataset.finalizeTimestamp` below for
 * existing in-class call sites) so sibling child-table models reuse it too.
 */
export function finalizeTimestampPage(
    rows: any[],
    limit: number,
    getDate: (row: any) => Date | number | null
): PageResult {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    let nextCursor: CursorKey | null = null;
    if (hasMore && last) {
        const d = getDate(last);
        const millis = d instanceof Date ? d.getTime() : typeof d === "number" ? d : null;
        nextCursor = { v: millis, id: last.uuid };
    }
    return { items, nextCursor };
}

/** Keyset predicate for an arbitrary SQL sort expression (projection sort / sequence). */
function exprKeyset(expr: any, uuidCol: any, dir: "asc" | "desc", boundValue: any, id: string): any {
    if (dir === "desc") {
        return sql`(${expr} < ${boundValue} OR (${expr} = ${boundValue} AND ${uuidCol} < ${id}))`;
    }
    return sql`(${expr} > ${boundValue} OR (${expr} = ${boundValue} AND ${uuidCol} > ${id}))`;
}

function combine(conditions: any[]): any {
    return conditions.length === 1 ? conditions[0] : and(...conditions);
}

/** A dataset's `retention_policy` as stored. */
export type DatasetRetentionPolicy = { item_days?: number; change_days?: number } | null | undefined;

export interface DatasetVisibilityCutoffs {
    /** Inactive items last seen before this are hidden. Null: no item is hidden. */
    itemCutoff: Date | null;
    /** Changes and run warnings created before this are hidden. Null: none hidden. */
    changeCutoff: Date | null;
}

/**
 * What a dataset's retention policy hides from reads.
 *
 * Retention is a VIEW, not a purge: nothing is deleted. Rows past a cutoff stay
 * in the database and reappear if the policy is loosened or cleared. Following
 * the platform design, an active item is never hidden however old it is.
 */
export function datasetVisibilityCutoffs(
    policy: DatasetRetentionPolicy,
    now = new Date()
): DatasetVisibilityCutoffs {
    const cutoff = (days: unknown): Date | null =>
        typeof days === "number" && Number.isFinite(days) && days > 0
            ? new Date(now.getTime() - days * 86_400_000)
            : null;
    return { itemCutoff: cutoff(policy?.item_days), changeCutoff: cutoff(policy?.change_days) };
}

/** An item stays visible while it is active, or while last seen after the cutoff. */
export function visibleItemCondition(itemCutoff: Date): any {
    return or(eq(schemas.datasetItems.isActive, true), gte(schemas.datasetItems.lastSeenAt, itemCutoff));
}

/**
 * Cutoffs for a dataset, looked up by id.
 *
 * Every user-facing read resolves the policy itself rather than trusting the
 * caller to pass it, so a new call site cannot forget and leak hidden rows.
 * Module-level on purpose: the Dataset statics are re-exported unbound, so they
 * must not reach helpers through `this`.
 */
export async function datasetVisibilityCutoffsById(
    db: DBExecutor,
    datasetId: string
): Promise<DatasetVisibilityCutoffs> {
    const rows = await db
        .select({ retentionPolicy: schemas.datasets.retentionPolicy })
        .from(schemas.datasets)
        .where(eq(schemas.datasets.uuid, datasetId))
        .limit(1);
    return datasetVisibilityCutoffs(rows[0]?.retentionPolicy);
}

/** Cutoffs for the dataset a run belongs to. */
async function datasetVisibilityCutoffsByRun(db: DBExecutor, runId: string): Promise<DatasetVisibilityCutoffs> {
    const rows = await db
        .select({ retentionPolicy: schemas.datasets.retentionPolicy })
        .from(schemas.datasetRuns)
        .innerJoin(schemas.datasets, eq(schemas.datasetRuns.datasetId, schemas.datasets.uuid))
        .where(eq(schemas.datasetRuns.uuid, runId))
        .limit(1);
    return datasetVisibilityCutoffs(rows[0]?.retentionPolicy);
}

/**
 * Replace each dataset's `itemCount` with the number of items its retention
 * policy leaves visible, so the count matches what listing the items returns.
 * Datasets without an item cutoff keep the stored counter and cost no query.
 * `activeItemCount` never changes: active items are never hidden.
 */
export async function withVisibleItemCounts<T extends { uuid: string; itemCount: number; retentionPolicy?: DatasetRetentionPolicy }>(
    db: DBExecutor,
    rows: T[]
): Promise<T[]> {
    return Promise.all(
        rows.map(async (row) => {
            const { itemCutoff } = datasetVisibilityCutoffs(row.retentionPolicy);
            if (!itemCutoff) return row;
            const [result] = await db
                .select({ count: sql<number>`count(*)` })
                .from(schemas.datasetItems)
                .where(and(eq(schemas.datasetItems.datasetId, row.uuid), visibleItemCondition(itemCutoff)));
            return { ...row, itemCount: Number(result?.count ?? 0) };
        })
    );
}

export class Dataset {
    /** Create a manually-owned dataset. */
    static async create(
        db: DBExecutor,
        params: {
            apiKeyId?: string | null;
            userId?: string | null;
            name: string;
            description?: string | null;
            sourceType?: string;
            sourceTemplateId?: string | null;
            schemaName: string;
            schemaVersion: string;
            retentionPolicy?: { item_days?: number; change_days?: number } | null;
            /** Queryable-field catalog snapshot: [{ field, path, type }]. */
            queryFields?: Array<{ field: string; path: string; type: FieldType }> | null;
        }
    ): Promise<any> {
        const now = new Date();
        const result = await db
            .insert(schemas.datasets)
            .values({
                apiKey: params.apiKeyId ?? null,
                userId: params.userId ?? null,
                name: params.name,
                description: params.description ?? null,
                sourceType: params.sourceType ?? "manual",
                sourceTemplateId: params.sourceTemplateId ?? null,
                schemaName: params.schemaName,
                schemaVersion: params.schemaVersion,
                queryFields: params.queryFields ?? null,
                retentionPolicy: params.retentionPolicy ?? null,
                createdAt: now,
                updatedAt: now,
            })
            .returning();
        return result[0];
    }

    /**
     * Look up an existing non-deleted dataset for an owner by name. Owner scope
     * precedence matches resolveDatasetOwnerScope (userId wins, else apiKeyId).
     * Returns the oldest match (stable target for ensure-by-name accumulation), or
     * null when unscoped or none exists. Backs DatasetWriter's ensure-by-name.
     */
    static async getByOwnerAndName(
        db: DBExecutor,
        owner: OwnerContext,
        name: string
    ): Promise<any | null> {
        const scope = resolveDatasetOwnerScope(owner);
        const conditions: any[] = [
            sql`${schemas.datasets.deletedAt} IS NULL`,
            eq(schemas.datasets.name, name),
        ];
        if (scope.by === "user") {
            conditions.push(eq(schemas.datasets.userId, scope.value as string));
        } else if (scope.by === "apiKey") {
            conditions.push(eq(schemas.datasets.apiKey, scope.value as string));
        } else {
            // No auth / self-host: datasets are unowned — scope ensure-by-name to the
            // unowned set so repeated runs still accumulate into one named dataset.
            conditions.push(sql`${schemas.datasets.userId} IS NULL`);
            conditions.push(sql`${schemas.datasets.apiKey} IS NULL`);
        }
        const rows = await db
            .select()
            .from(schemas.datasets)
            .where(combine(conditions))
            .orderBy(sql`${schemas.datasets.createdAt} ASC, ${schemas.datasets.uuid} ASC`)
            .limit(1);
        return rows[0] ?? null;
    }

    /** Patch mutable dataset fields (name / description / retention_policy). */
    static async update(
        db: DBExecutor,
        datasetId: string,
        patch: {
            name?: string;
            description?: string | null;
            retentionPolicy?: { item_days?: number; change_days?: number } | null;
        }
    ): Promise<any | null> {
        const updateData: any = { updatedAt: new Date() };
        if (patch.name !== undefined) updateData.name = patch.name;
        if (patch.description !== undefined) updateData.description = patch.description;
        if (patch.retentionPolicy !== undefined) updateData.retentionPolicy = patch.retentionPolicy;

        const result = await db
            .update(schemas.datasets)
            .set(updateData)
            .where(eq(schemas.datasets.uuid, datasetId))
            .returning();
        return result[0] || null;
    }

    /** Soft-delete a dataset (sets deleted_at; blocks it from all owner-scoped reads). */
    static async softDelete(db: DBExecutor, datasetId: string): Promise<void> {
        const now = new Date();
        await db
            .update(schemas.datasets)
            .set({ deletedAt: now, updatedAt: now })
            .where(eq(schemas.datasets.uuid, datasetId));
    }

    /** Owner-scoped dataset list, cursor on (created_at DESC, uuid DESC). */
    static async listByOwner(
        db: DBExecutor,
        owner: OwnerContext,
        opts: { limit: number; cursor?: CursorKey | null }
    ): Promise<PageResult> {
        const scope = resolveDatasetOwnerScope(owner);
        const conditions: any[] = [sql`${schemas.datasets.deletedAt} IS NULL`];
        if (scope.by === "user") {
            conditions.push(eq(schemas.datasets.userId, scope.value as string));
        } else if (scope.by === "apiKey") {
            conditions.push(eq(schemas.datasets.apiKey, scope.value as string));
        }
        if (opts.cursor) {
            conditions.push(
                timestampKeyset(schemas.datasets.createdAt, schemas.datasets.uuid, "desc", opts.cursor)
            );
        }
        const rows = await db
            .select()
            .from(schemas.datasets)
            .where(combine(conditions))
            .orderBy(sql`${schemas.datasets.createdAt} DESC, ${schemas.datasets.uuid} DESC`)
            .limit(opts.limit + 1);

        return Dataset.finalizeTimestamp(rows, opts.limit, (r: any) => r.createdAt);
    }

    /**
     * The dataset's queryable-field catalog (field → { path, type }), read from the
     * frozen `datasets.query_fields` snapshot. Used by the controller to validate
     * filter/sort fields and to resolve each field's document path + type for the
     * jsonb-direct query. Empty when the producer declared no projections.
     */
    static async getProjectionCatalog(
        db: DBExecutor,
        datasetId: string
    ): Promise<Map<string, ProjectionCatalogEntry>> {
        const rows = await db
            .select({ queryFields: schemas.datasets.queryFields })
            .from(schemas.datasets)
            .where(eq(schemas.datasets.uuid, datasetId))
            .limit(1);
        const map = new Map<string, ProjectionCatalogEntry>();
        const fields = (rows[0]?.queryFields ?? []) as Array<{
            field: string;
            path: string;
            type: FieldType;
        }>;
        for (const f of fields) {
            if (f && typeof f.field === "string") {
                map.set(f.field, { path: f.path, type: f.type });
            }
        }
        return map;
    }

    /**
     * Dataset items. Default order (last_seen_at DESC, uuid DESC); optional filters
     * and a sort that query the `document` jsonb directly (dialect-aware) using each
     * field's projection path + type, with a matching keyset cursor.
     */
    static async getItems(
        db: DBExecutor,
        opts: {
            datasetId: string;
            limit: number;
            cursor?: CursorKey | null;
            filters?: ItemFilter[];
            sort?: ItemSort | null;
        }
    ): Promise<PageResult> {
        const conditions: any[] = [eq(schemas.datasetItems.datasetId, opts.datasetId)];
        for (const f of opts.filters ?? []) {
            conditions.push(filterCondition(f));
        }
        // Applies to both the sorted and default paths below, and to exports,
        // which page through this same function.
        const { itemCutoff } = await datasetVisibilityCutoffsById(db, opts.datasetId);
        if (itemCutoff) conditions.push(visibleItemCondition(itemCutoff));

        if (opts.sort) {
            const expr = fieldExpr(pathSegments(opts.sort.path), opts.sort.fieldType);
            const dir = opts.sort.dir;
            if (opts.cursor) {
                conditions.push(
                    projectionKeyset(expr, schemas.datasetItems.uuid, dir, opts.sort.fieldType, opts.cursor)
                );
            }
            const dirSql = dir === "desc" ? sql`DESC` : sql`ASC`;
            const rows = await db
                .select({ item: schemas.datasetItems, sortValue: expr })
                .from(schemas.datasetItems)
                .where(combine(conditions))
                .orderBy(sql`${expr} ${dirSql}, ${schemas.datasetItems.uuid} ${dirSql}`)
                .limit(opts.limit + 1);

            const hasMore = rows.length > opts.limit;
            const page = hasMore ? rows.slice(0, opts.limit) : rows;
            const last = page[page.length - 1];
            const nextCursor = hasMore && last
                ? { v: projectionToCursorValue(opts.sort.fieldType, last.sortValue), id: last.item.uuid }
                : null;
            return { items: page.map((r: any) => r.item), nextCursor };
        }

        if (opts.cursor) {
            conditions.push(
                timestampKeyset(schemas.datasetItems.lastSeenAt, schemas.datasetItems.uuid, "desc", opts.cursor)
            );
        }
        const rows = await db
            .select()
            .from(schemas.datasetItems)
            .where(combine(conditions))
            .orderBy(sql`${schemas.datasetItems.lastSeenAt} DESC, ${schemas.datasetItems.uuid} DESC`)
            .limit(opts.limit + 1);

        return Dataset.finalizeTimestamp(rows, opts.limit, (r: any) => r.lastSeenAt);
    }

    /** Dataset runs, cursor on (created_at DESC, uuid DESC). */
    static async listRuns(
        db: DBExecutor,
        datasetId: string,
        opts: { limit: number; cursor?: CursorKey | null }
    ): Promise<PageResult> {
        const conditions: any[] = [eq(schemas.datasetRuns.datasetId, datasetId)];
        if (opts.cursor) {
            conditions.push(
                timestampKeyset(schemas.datasetRuns.createdAt, schemas.datasetRuns.uuid, "desc", opts.cursor)
            );
        }
        const rows = await db
            .select()
            .from(schemas.datasetRuns)
            .where(combine(conditions))
            .orderBy(sql`${schemas.datasetRuns.createdAt} DESC, ${schemas.datasetRuns.uuid} DESC`)
            .limit(opts.limit + 1);

        return Dataset.finalizeTimestamp(rows, opts.limit, (r: any) => r.createdAt);
    }

    /** A single run scoped to its parent dataset. Null when not found / mismatched. */
    static async getRun(db: DBExecutor, datasetId: string, runId: string): Promise<any | null> {
        const rows = await db
            .select()
            .from(schemas.datasetRuns)
            .where(
                and(
                    eq(schemas.datasetRuns.uuid, runId),
                    eq(schemas.datasetRuns.datasetId, datasetId)
                )
            )
            .limit(1);
        return rows[0] || null;
    }

    /** Resolve the Dataset Run written by a legacy producer job. */
    static async getRunByProducer(
        db: DBExecutor,
        datasetId: string,
        producerType: string,
        producerId: string
    ): Promise<any | null> {
        const rows = await db
            .select()
            .from(schemas.datasetRuns)
            .where(and(
                eq(schemas.datasetRuns.datasetId, datasetId),
                eq(schemas.datasetRuns.producerType, producerType),
                eq(schemas.datasetRuns.producerId, producerId)
            ))
            .limit(1);
        return rows[0] || null;
    }

    /** Run members in deterministic order, cursor on (sequence, uuid) ascending. */
    static async listRunItems(
        db: DBExecutor,
        runId: string,
        opts: { limit: number; cursor?: CursorKey | null }
    ): Promise<PageResult> {
        const seqExpr = sql`COALESCE(${schemas.datasetRunItems.sequence}, ${SEQUENCE_NULLS_LAST})`;
        const conditions: any[] = [eq(schemas.datasetRunItems.datasetRunId, runId)];
        if (opts.cursor) {
            conditions.push(
                exprKeyset(seqExpr, schemas.datasetRunItems.uuid, "asc", Number(opts.cursor.v), opts.cursor.id)
            );
        }
        // Keep member identity/order, but include the current document for rendering.
        // Run membership is not a historical document snapshot.
        const { itemCutoff } = await datasetVisibilityCutoffsByRun(db, runId);
        const query = db
            .select({
                item: schemas.datasetRunItems,
                document: schemas.datasetItems.document,
                sourceUrl: schemas.datasetItems.sourceUrl,
                firstSeenAt: schemas.datasetItems.firstSeenAt,
                lastSeenAt: schemas.datasetItems.lastSeenAt,
                isActive: schemas.datasetItems.isActive,
                sortValue: seqExpr,
            })
            .from(schemas.datasetRunItems)
            .innerJoin(
                schemas.datasetItems,
                eq(schemas.datasetRunItems.datasetItemId, schemas.datasetItems.uuid)
            );
        if (itemCutoff) conditions.push(visibleItemCondition(itemCutoff));
        const rows = await query
            .where(combine(conditions))
            .orderBy(sql`${seqExpr} ASC, ${schemas.datasetRunItems.uuid} ASC`)
            .limit(opts.limit + 1);

        const hasMore = rows.length > opts.limit;
        const page = hasMore ? rows.slice(0, opts.limit) : rows;
        const last = page[page.length - 1];
        const nextCursor = hasMore && last
            ? { v: Number(last.sortValue), id: last.item.uuid }
            : null;
        return {
            items: page.map(({ item, sortValue, ...content }: any) => ({ ...item, ...content })),
            nextCursor,
        };
    }

    /** Dataset change history, filterable, cursor on (created_at DESC, uuid DESC). */
    static async listChanges(
        db: DBExecutor,
        datasetId: string,
        opts: {
            limit: number;
            cursor?: CursorKey | null;
            datasetRunId?: string;
            scopeKey?: string;
            itemKey?: string;
            changeType?: string;
            since?: Date;
            until?: Date;
        }
    ): Promise<PageResult> {
        const conditions: any[] = [eq(schemas.datasetItemChanges.datasetId, datasetId)];
        if (opts.datasetRunId) conditions.push(eq(schemas.datasetItemChanges.datasetRunId, opts.datasetRunId));
        if (opts.scopeKey) conditions.push(eq(schemas.datasetItemChanges.scopeKey, opts.scopeKey));
        if (opts.itemKey) conditions.push(eq(schemas.datasetItemChanges.itemKey, opts.itemKey));
        if (opts.changeType) conditions.push(eq(schemas.datasetItemChanges.changeType, opts.changeType));
        if (opts.since) conditions.push(gte(schemas.datasetItemChanges.createdAt, opts.since));
        if (opts.until) conditions.push(lte(schemas.datasetItemChanges.createdAt, opts.until));
        const { changeCutoff } = await datasetVisibilityCutoffsById(db, datasetId);
        if (changeCutoff) conditions.push(gte(schemas.datasetItemChanges.createdAt, changeCutoff));
        if (opts.cursor) {
            conditions.push(
                timestampKeyset(schemas.datasetItemChanges.createdAt, schemas.datasetItemChanges.uuid, "desc", opts.cursor)
            );
        }
        const rows = await db
            .select()
            .from(schemas.datasetItemChanges)
            .where(combine(conditions))
            .orderBy(sql`${schemas.datasetItemChanges.createdAt} DESC, ${schemas.datasetItemChanges.uuid} DESC`)
            .limit(opts.limit + 1);

        return Dataset.finalizeTimestamp(rows, opts.limit, (r: any) => r.createdAt);
    }

    /** Run warnings, filterable by code/scope/item_key, cursor on (created_at DESC, uuid DESC). */
    static async listRunWarnings(
        db: DBExecutor,
        runId: string,
        opts: {
            limit: number;
            cursor?: CursorKey | null;
            code?: string;
            scope?: string;
            itemKey?: string;
        }
    ): Promise<PageResult> {
        const conditions: any[] = [eq(schemas.runWarnings.datasetRunId, runId)];
        if (opts.code) conditions.push(eq(schemas.runWarnings.code, opts.code));
        if (opts.scope) conditions.push(eq(schemas.runWarnings.scope, opts.scope));
        if (opts.itemKey) conditions.push(eq(schemas.runWarnings.itemKey, opts.itemKey));
        // Warnings age out on the change axis, per the platform design.
        const { changeCutoff } = await datasetVisibilityCutoffsByRun(db, runId);
        if (changeCutoff) conditions.push(gte(schemas.runWarnings.createdAt, changeCutoff));
        if (opts.cursor) {
            conditions.push(
                timestampKeyset(schemas.runWarnings.createdAt, schemas.runWarnings.uuid, "desc", opts.cursor)
            );
        }
        const rows = await db
            .select()
            .from(schemas.runWarnings)
            .where(combine(conditions))
            .orderBy(sql`${schemas.runWarnings.createdAt} DESC, ${schemas.runWarnings.uuid} DESC`)
            .limit(opts.limit + 1);

        return Dataset.finalizeTimestamp(rows, opts.limit, (r: any) => r.createdAt);
    }

    /** Trim a limit+1 fetch and derive the next timestamp cursor from the last row. */
    private static finalizeTimestamp(
        rows: any[],
        limit: number,
        getDate: (row: any) => Date | number | null
    ): PageResult {
        return finalizeTimestampPage(rows, limit, getDate);
    }
}
