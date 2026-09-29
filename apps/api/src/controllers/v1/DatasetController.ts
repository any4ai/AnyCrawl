import { Response } from "express";
import { z } from "zod";
import { RequestWithAuth, type OwnerContext, log, s3 } from "@anycrawl/libs";
import { QueueManager } from "@anycrawl/scrape";
import {
    getDB,
    createDataset,
    getOwnedDataset,
    updateDataset,
    softDeleteDataset,
    listDatasetsByOwner,
    getDatasetProjectionFields,
    getDatasetItems,
    listDatasetRuns,
    getDatasetRun,
    listDatasetRunItems,
    listDatasetChanges,
    listRunWarnings,
    createDatasetExport,
    listDatasetExports,
    getDatasetExport,
    type DatasetItemFilter,
    type DatasetItemSort,
    type DatasetPageResult,
    withVisibleItemCounts,
} from "@anycrawl/db";
import { serializeRecord, serializeRecords } from "../../utils/serializer.js";
import { encodeCursor, decodeCursor, InvalidCursorError, type Cursor } from "../../utils/cursor.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const ALLOWED_OPS = new Set(["eq", "in", "lt", "lte", "gt", "gte"]);

const createDatasetSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    schema: z.object({
        name: z.string().min(1),
        version: z.string().min(1),
    }),
    // Field name matches the GET response (`retention_policy`) so create/read/update are symmetric.
    retention_policy: z
        .object({
            item_days: z.number().int().positive().optional(),
            change_days: z.number().int().positive().optional(),
        })
        .optional(),
});

const createExportSchema = z.object({
    format: z.enum(["jsonl", "csv"]),
});

const updateDatasetSchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    retention_policy: z
        .object({
            item_days: z.number().int().positive().optional(),
            change_days: z.number().int().positive().optional(),
        })
        .nullable()
        .optional(),
});

interface RawFilter {
    field: string;
    op: string;
    value: string;
}

export class DatasetController {
    // --- Collection CRUD -----------------------------------------------------

    /** POST /v1/datasets */
    public create = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const data = createDatasetSchema.parse(req.body);
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const dataset = await createDataset(db, {
                apiKeyId: owner.apiKeyId ?? null,
                userId: owner.userId ?? null,
                name: data.name,
                description: data.description,
                schemaName: data.schema.name,
                schemaVersion: data.schema.version,
                retentionPolicy: data.retention_policy ?? null,
                sourceType: "manual",
            });

            res.status(201).json({ success: true, data: serializeRecord(dataset) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /** GET /v1/datasets */
    public list = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const limit = this.parseLimit(req.query.limit);
            const cursor = this.parseCursor(req, res);
            if (cursor === false) return;

            const page = await listDatasetsByOwner(db, owner, { limit, cursor });
            const items = await withVisibleItemCounts(db, page.items);
            this.sendList(res, "datasets", page, serializeRecords(items));
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /** GET /v1/datasets/:id */
    public get = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const dataset = await getOwnedDataset(db, req.params.id!, owner);
            if (!dataset) {
                this.notFound(res, "dataset_not_found");
                return;
            }
            const [visible] = await withVisibleItemCounts(db, [dataset]);
            res.json({ success: true, data: serializeRecord(visible) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /** PATCH /v1/datasets/:id (name / description / retention_policy only) */
    public update = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const data = updateDatasetSchema.parse(req.body);
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const existing = await getOwnedDataset(db, req.params.id!, owner);
            if (!existing) {
                this.notFound(res, "dataset_not_found");
                return;
            }

            const updated = await updateDataset(db, req.params.id!, {
                name: data.name,
                description: data.description,
                retentionPolicy: data.retention_policy,
            });
            // The policy may have just changed, so recount against the new one.
            const [visible] = updated ? await withVisibleItemCounts(db, [updated]) : [updated];
            res.json({ success: true, data: serializeRecord(visible) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /** DELETE /v1/datasets/:id (soft delete) */
    public delete = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const existing = await getOwnedDataset(db, req.params.id!, owner);
            if (!existing) {
                this.notFound(res, "dataset_not_found");
                return;
            }

            await softDeleteDataset(db, req.params.id!);
            res.json({ success: true, message: "Dataset deleted successfully" });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    // --- Items ---------------------------------------------------------------

    /** GET /v1/datasets/:id/items */
    public items = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const dataset = await getOwnedDataset(db, req.params.id!, owner);
            if (!dataset) {
                this.notFound(res, "dataset_not_found");
                return;
            }

            const limit = this.parseLimit(req.query.limit);
            const cursor = this.parseCursor(req, res);
            if (cursor === false) return;

            // Queryable-field catalog: field → { path, type }, read from the dataset's
            // frozen query_fields snapshot. Filter/sort fields are validated against it
            // (unknown field → 400); the resolved path + type drive the jsonb query.
            // NOTE: ad-hoc querying of undeclared document fields is out of scope — the
            // declared-field whitelist below could become an opt-in toggle later.
            const projection = await getDatasetProjectionFields(db, req.params.id!);

            // Filters
            const filters: DatasetItemFilter[] = [];
            for (const raw of this.extractRawFilters(req.query)) {
                const entry = projection.get(raw.field);
                if (!entry) {
                    this.badRequest(res, "invalid_filter", `Unknown filter field: ${raw.field}`);
                    return;
                }
                if (!ALLOWED_OPS.has(raw.op)) {
                    this.badRequest(res, "invalid_filter", `Unknown filter operator: ${raw.op}`);
                    return;
                }
                const values =
                    raw.op === "in"
                        ? raw.value.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
                        : [raw.value];
                filters.push({
                    field: raw.field,
                    fieldType: entry.type,
                    path: entry.path,
                    op: raw.op as DatasetItemFilter["op"],
                    values,
                });
            }

            // Sort
            let sort: DatasetItemSort | null = null;
            if (req.query.sort !== undefined) {
                const rawSort = String(req.query.sort);
                const dir = rawSort.startsWith("-") ? "desc" : "asc";
                const field = rawSort.replace(/^-/, "");
                const entry = projection.get(field);
                if (!entry) {
                    this.badRequest(res, "invalid_sort", `Unknown sort field: ${field}`);
                    return;
                }
                sort = { field, fieldType: entry.type, path: entry.path, dir };
            }

            const page = await getDatasetItems(db, {
                datasetId: req.params.id!,
                limit,
                cursor,
                filters,
                sort,
            });
            this.sendList(res, "items", page, this.serializeItems(page.items));
        } catch (error) {
            this.handleError(error, res);
        }
    };

    // --- Runs ----------------------------------------------------------------

    /** GET /v1/datasets/:id/runs */
    public runs = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const dataset = await getOwnedDataset(db, req.params.id!, owner);
            if (!dataset) {
                this.notFound(res, "dataset_not_found");
                return;
            }
            const limit = this.parseLimit(req.query.limit);
            const cursor = this.parseCursor(req, res);
            if (cursor === false) return;

            const page = await listDatasetRuns(db, req.params.id!, { limit, cursor });
            this.sendList(res, "runs", page, serializeRecords(page.items));
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /** GET /v1/datasets/:id/runs/:run_id */
    public run = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const dataset = await getOwnedDataset(db, req.params.id!, owner);
            if (!dataset) {
                this.notFound(res, "dataset_not_found");
                return;
            }
            const run = await getDatasetRun(db, req.params.id!, req.params.run_id!);
            if (!run) {
                this.notFound(res, "dataset_run_not_found");
                return;
            }
            res.json({ success: true, data: serializeRecord(run) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /** GET /v1/datasets/:id/runs/:run_id/items */
    public runItems = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const dataset = await getOwnedDataset(db, req.params.id!, owner);
            if (!dataset) {
                this.notFound(res, "dataset_not_found");
                return;
            }
            const run = await getDatasetRun(db, req.params.id!, req.params.run_id!);
            if (!run) {
                this.notFound(res, "dataset_run_not_found");
                return;
            }
            const limit = this.parseLimit(req.query.limit);
            const cursor = this.parseCursor(req, res);
            if (cursor === false) return;

            const page = await listDatasetRunItems(db, req.params.run_id!, { limit, cursor });
            this.sendList(res, "items", page, this.serializeItems(page.items));
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /** GET /v1/datasets/:id/runs/:run_id/warnings */
    public runWarnings = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const dataset = await getOwnedDataset(db, req.params.id!, owner);
            if (!dataset) {
                this.notFound(res, "dataset_not_found");
                return;
            }
            const run = await getDatasetRun(db, req.params.id!, req.params.run_id!);
            if (!run) {
                this.notFound(res, "dataset_run_not_found");
                return;
            }
            const limit = this.parseLimit(req.query.limit);
            const cursor = this.parseCursor(req, res);
            if (cursor === false) return;

            const page = await listRunWarnings(db, req.params.run_id!, {
                limit,
                cursor,
                code: this.strParam(req.query.code),
                scope: this.strParam(req.query.scope),
                itemKey: this.strParam(req.query.item_key),
            });
            this.sendList(res, "warnings", page, serializeRecords(page.items));
        } catch (error) {
            this.handleError(error, res);
        }
    };

    // --- Changes -------------------------------------------------------------

    /** GET /v1/datasets/:id/changes */
    public changes = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const dataset = await getOwnedDataset(db, req.params.id!, owner);
            if (!dataset) {
                this.notFound(res, "dataset_not_found");
                return;
            }
            const limit = this.parseLimit(req.query.limit);
            const cursor = this.parseCursor(req, res);
            if (cursor === false) return;

            const since = this.parseDate(req.query.since, res, "since");
            if (since === false) return;
            const until = this.parseDate(req.query.until, res, "until");
            if (until === false) return;

            const page = await listDatasetChanges(db, req.params.id!, {
                limit,
                cursor,
                datasetRunId: this.strParam(req.query.dataset_run_id),
                scopeKey: this.strParam(req.query.scope_key),
                itemKey: this.strParam(req.query.item_key),
                changeType: this.strParam(req.query.change_type),
                since: since ?? undefined,
                until: until ?? undefined,
            });
            this.sendList(res, "changes", page, this.serializeChanges(page.items));
        } catch (error) {
            this.handleError(error, res);
        }
    };

    // --- Exports ---------------------------------------------------------------

    /** POST /v1/datasets/:id/exports */
    public createExport = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const data = createExportSchema.parse(req.body);
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const dataset = await getOwnedDataset(db, req.params.id!, owner);
            if (!dataset) {
                this.notFound(res, "dataset_not_found");
                return;
            }

            const exportRow = await createDatasetExport(db, {
                datasetId: req.params.id!,
                format: data.format,
            });

            await QueueManager.getInstance().addDatasetExportJob({
                type: "dataset-export",
                exportId: exportRow.uuid,
                datasetId: req.params.id!,
                format: data.format,
            });

            res.status(201).json({ success: true, data: serializeRecord(exportRow) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /** GET /v1/datasets/:id/exports */
    public listExports = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const dataset = await getOwnedDataset(db, req.params.id!, owner);
            if (!dataset) {
                this.notFound(res, "dataset_not_found");
                return;
            }
            const limit = this.parseLimit(req.query.limit);
            const cursor = this.parseCursor(req, res);
            if (cursor === false) return;

            const page = await listDatasetExports(db, req.params.id!, { limit, cursor });
            this.sendList(res, "exports", page, serializeRecords(page.items));
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /** GET /v1/datasets/:id/exports/:export_id */
    public getExport = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const dataset = await getOwnedDataset(db, req.params.id!, owner);
            if (!dataset) {
                this.notFound(res, "dataset_not_found");
                return;
            }
            const exportRow = await getDatasetExport(db, req.params.id!, req.params.export_id!);
            if (!exportRow) {
                this.notFound(res, "dataset_export_not_found");
                return;
            }

            const data = serializeRecord<Record<string, unknown>>(exportRow);
            // Presigned URLs expire — mint a fresh one on every read rather than
            // persisting it on the row.
            if (exportRow.status === "completed" && exportRow.fileKey) {
                data.download_url = await s3.getTemporaryUrl(exportRow.fileKey);
            }
            res.json({ success: true, data });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    // --- Helpers -------------------------------------------------------------

    private getOwnerContext(req: RequestWithAuth): OwnerContext {
        return {
            apiKeyId: req.auth?.uuid,
            userId: req.auth?.user,
        };
    }

    private parseLimit(raw: unknown): number {
        let n = Number.parseInt(String(raw ?? ""), 10);
        if (!Number.isFinite(n) || n <= 0) n = DEFAULT_LIMIT;
        if (n > MAX_LIMIT) n = MAX_LIMIT;
        return n;
    }

    /**
     * Decode the `cursor` query param. Returns the decoded cursor (or null when
     * absent), or `false` after having already written a 400 response.
     */
    private parseCursor(req: RequestWithAuth, res: Response): Cursor | null | false {
        if (req.query.cursor === undefined) return null;
        try {
            return decodeCursor(String(req.query.cursor));
        } catch (error) {
            if (error instanceof InvalidCursorError) {
                this.badRequest(res, "invalid_cursor", "Malformed pagination cursor");
                return false;
            }
            throw error;
        }
    }

    private parseDate(raw: unknown, res: Response, field: string): Date | null | false {
        if (raw === undefined) return null;
        const d = new Date(String(raw));
        if (Number.isNaN(d.getTime())) {
            this.badRequest(res, "Validation error", `Invalid ${field} timestamp`);
            return false;
        }
        return d;
    }

    private strParam(raw: unknown): string | undefined {
        if (raw === undefined || raw === null) return undefined;
        const s = String(raw);
        return s.length > 0 ? s : undefined;
    }

    /** Extract `filter[field][op]=value` params from either query-parser shape. */
    private extractRawFilters(query: any): RawFilter[] {
        const out: RawFilter[] = [];
        const nested = query?.filter;
        if (nested && typeof nested === "object" && !Array.isArray(nested)) {
            for (const field of Object.keys(nested)) {
                const ops = nested[field];
                if (ops && typeof ops === "object" && !Array.isArray(ops)) {
                    for (const op of Object.keys(ops)) {
                        out.push({ field, op, value: String(ops[op]) });
                    }
                }
            }
        }
        for (const key of Object.keys(query ?? {})) {
            const m = key.match(/^filter\[([^\]]+)\]\[([^\]]+)\]$/);
            if (m) {
                const value = query[key];
                out.push({
                    field: m[1]!,
                    op: m[2]!,
                    value: Array.isArray(value) ? value.join(",") : String(value),
                });
            }
        }
        return out;
    }

    /** Serialize item rows, keeping the `document` JSON blob untouched. */
    private serializeItems(rows: any[]): any[] {
        return rows.map((row) => {
            const { document, ...rest } = row;
            return { ...serializeRecord(rest), document: document ?? null };
        });
    }

    /** Serialize change rows, keeping the `field_changes` JSON blob untouched. */
    private serializeChanges(rows: any[]): any[] {
        return rows.map((row) => {
            const { fieldChanges, ...rest } = row;
            return { ...serializeRecord(rest), field_changes: fieldChanges ?? null };
        });
    }

    private sendList(res: Response, key: string, page: DatasetPageResult, serialized: any[]): void {
        res.json({
            success: true,
            data: {
                [key]: serialized,
                next_cursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
            },
        });
    }

    private notFound(res: Response, code: string): void {
        res.status(404).json({ success: false, error: code });
    }

    private badRequest(res: Response, code: string, message: string): void {
        res.status(400).json({ success: false, error: code, message });
    }

    private handleError(error: any, res: Response): void {
        if (error instanceof z.ZodError) {
            const formattedErrors = error.errors.map((err) => ({
                field: err.path.join("."),
                message: err.message,
                code: err.code,
            }));
            const message = error.errors.map((err) => err.message).join(", ");
            res.status(400).json({
                success: false,
                error: "Validation error",
                message,
                details: formattedErrors,
            });
        } else {
            log.error(`Dataset controller error: ${error}`);
            res.status(500).json({
                success: false,
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
}
