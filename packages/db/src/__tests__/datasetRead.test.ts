import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression tests for the dataset-read `this`-binding bug (live integration bug #1).
 *
 * `Dataset.getItems` / `listRuns` / `listChanges` / `listByOwner` / `listRunWarnings`
 * are re-exported *bare* from `@anycrawl/db` (e.g. `export const getDatasetItems =
 * Dataset.getItems`). Each ends by delegating to the private static helper
 * `finalizeTimestamp` to trim the limit+1 fetch and derive the next cursor. The bug
 * called it as `this.finalizeTimestamp(...)`; invoked through the bare export the
 * function has no `this`, so every `/v1/datasets` read threw
 *   "Cannot read properties of undefined (reading 'finalizeTimestamp')" → 500.
 * The fix pins the call to `Dataset.finalizeTimestamp(...)`.
 *
 * These tests import the BARE exports (the exact wiring that lost `this` at runtime)
 * and call them against a real in-memory SQLite DB seeded via the writer. If the fix
 * is reverted they fail with the TypeError above (the awaited call rejects), instead
 * of silently regressing to a 500 in production.
 *
 * The db package resolves its dialect-specific `schemas` from ANYCRAWL_API_DB_TYPE at
 * import time, so we force SQLite before importing it (mirrors datasetWriter.test.ts).
 */
process.env.ANYCRAWL_API_DB_TYPE = "sqlite";

// Bare exports under test — Dataset.<method> detached from the class.
let getDatasetItems: any;
let listDatasetRuns: any;
let listDatasetRunItems: any;
let listDatasetChanges: any;
let listDatasetsByOwner: any;
let listRunWarnings: any;
let getDatasetProjectionFields: any;
// Bound export used only to seed rows (safe — index.ts binds the writer).
let writeResultToDataset: any;

let sqlite: any;
let db: any;

/** Apply drizzle migration files (split on statement-breakpoint) in order. */
function applyMigrations(files: string[]): void {
    for (const file of files) {
        const ddl = readFileSync(resolve(process.cwd(), file), "utf8");
        for (const raw of ddl.split("--> statement-breakpoint")) {
            const stmt = raw.trim();
            if (stmt.length > 0) sqlite.exec(stmt);
        }
    }
}

const OWNER = { userId: "user-1" };
const SEARCH_MAPPING = { name: "anycrawl_search_result", version: "1.0.0" };

/** uuid of a run keyed by (dataset, producer_type, producer_id). */
const runIdOf = (datasetId: string, producerType: string, producerId: string): string =>
    (sqlite
        .prepare(
            `SELECT uuid FROM dataset_runs WHERE dataset_id = ? AND producer_type = ? AND producer_id = ?`
        )
        .get(datasetId, producerType, producerId) as any).uuid;

async function seedSearch(opts: { jobId: string; result: unknown; dataset: any }) {
    return writeResultToDataset({
        producerType: "search",
        producerId: opts.jobId,
        jobId: opts.jobId,
        scope: { kind: "job", jobId: opts.jobId },
        scopeType: "search",
        result: opts.result,
        mapping: SEARCH_MAPPING,
        owner: OWNER,
        dataset: opts.dataset,
        dbOrTx: db,
        now: new Date(),
    });
}

beforeAll(async () => {
    process.env.ANYCRAWL_API_DB_TYPE = "sqlite";
    const schema = await import("../db/schemas/SQLite.js");
    // Import the real package barrel so we exercise the *bare* export wiring itself.
    const dbPkg: any = await import("../index.js");
    ({
        getDatasetItems,
        listDatasetRuns,
        listDatasetRunItems,
        listDatasetChanges,
        listDatasetsByOwner,
        listRunWarnings,
        getDatasetProjectionFields,
        writeResultToDataset,
    } = dbPkg);

    sqlite = new Database(":memory:");
    // Dataset tables carry FKs to parent tables (api_key, jobs, ...) we don't create here.
    sqlite.pragma("foreign_keys = OFF");
    // Core DDL then the jsonb-query migration (drops EAV field_values, adds query_fields).
    applyMigrations([
        "drizzle/SQLite/0012_dataset_core_tables.sql",
        "drizzle/SQLite/0017_dataset_jsonb_query.sql",
    ]);
    db = drizzle(sqlite, { schema });
});

afterAll(() => {
    sqlite?.close();
});

describe("Dataset read bare exports keep their `this` binding (regression: this.finalizeTimestamp)", () => {
    let datasetId: string;
    let runWithWarning: string;

    beforeAll(async () => {
        // Run #1 → dataset + 3 items + 3 'created' changes.
        const out1 = await seedSearch({
            jobId: "read-1",
            result: [
                { url: "https://r.test/1", title: "a" },
                { url: "https://r.test/2", title: "b" },
                { url: "https://r.test/3", title: "c" },
            ],
            dataset: { create: { name: "Read DS" } },
        });
        datasetId = out1.datasetId;

        // Run #2 → +1 item, +1 change (total 4 items, 4 changes, 2 runs).
        await seedSearch({
            jobId: "read-2",
            result: [{ url: "https://r.test/4", title: "d" }],
            dataset: { datasetId },
        });

        // Run #3 → 1 valid item + 1 item with no key ⇒ records a `missing_item_key`
        // run warning (total 5 items, 5 changes, 3 runs, 1 warning).
        await seedSearch({
            jobId: "read-3",
            result: [
                { url: "https://r.test/5", title: "e" },
                { title: "no url here" },
            ],
            dataset: { datasetId },
        });
        runWithWarning = runIdOf(datasetId, "search", "read-3");
    });

    // Each call below routes through finalizeTimestamp. Under the reverted bug the
    // awaited promise rejects with the TypeError, failing the test.

    it("getDatasetItems returns a trimmed page + cursor (bare export)", async () => {
        const page = await getDatasetItems(db, { datasetId, limit: 2 });
        expect(page.items).toHaveLength(2); // 5 items, limit 2 → hasMore trims to 2
        expect(page.nextCursor).not.toBeNull(); // derived inside finalizeTimestamp
        expect(page.nextCursor.id).toBeTruthy();
    });

    it("listDatasetRuns returns a trimmed page + cursor (bare export)", async () => {
        const page = await listDatasetRuns(db, datasetId, { limit: 1 });
        expect(page.items).toHaveLength(1); // 3 runs, limit 1 → hasMore
        expect(page.nextCursor).not.toBeNull();
    });

    it("listDatasetChanges returns a trimmed page + cursor (bare export)", async () => {
        const page = await listDatasetChanges(db, datasetId, { limit: 2 });
        expect(page.items).toHaveLength(2); // 5 changes, limit 2 → hasMore
        expect(page.nextCursor).not.toBeNull();
    });

    it("listDatasetsByOwner returns the owner's datasets (bare export)", async () => {
        const page = await listDatasetsByOwner(db, OWNER, { limit: 5 });
        expect(page.items.length).toBeGreaterThanOrEqual(1);
        expect(page.items.some((d: any) => d.uuid === datasetId)).toBe(true);
    });

    it("listRunWarnings returns the run's warnings (bare export)", async () => {
        const page = await listRunWarnings(db, runWithWarning, { limit: 10 });
        expect(page.items.length).toBeGreaterThanOrEqual(1);
        expect(page.items[0].code).toBe("missing_item_key");
    });

    it("returns an empty page (not a throw) when there is nothing to read (bare export)", async () => {
        // finalizeTimestamp still runs on an empty result set — the reverted bug throws here too.
        const page = await getDatasetItems(db, {
            datasetId: "00000000-0000-0000-0000-000000000000",
            limit: 10,
        });
        expect(page.items).toEqual([]);
        expect(page.nextCursor).toBeNull();
    });
});

/**
 * jsonb-direct filter/sort query layer (replaces the EAV field_values queries).
 * Seeds items with structured documents via a projections mapping (which snapshots
 * the query_fields catalog) and asserts filter[field][op] + sort resolve the right
 * rows through json_extract on the document.
 */
describe("Dataset.getItems jsonb filter/sort (json_extract via query_fields catalog)", () => {
    // DatasetMapping projections use `name` (the query-facing field). The writer
    // snapshots them onto datasets.query_fields as { field: name, path, type }.
    const PROJ_SEARCH_MAPPING = {
        name: "anycrawl_search_result",
        version: "1.0.0",
        projections: [
            { name: "price", path: "/price", type: "number" },
            { name: "brand", path: "/brand", type: "string" },
            { name: "in_stock", path: "/inStock", type: "boolean" },
            { name: "published_at", path: "/publishedAt", type: "timestamptz" },
        ],
    };

    let datasetId: string;
    let catalog: Map<string, { path: string; type: string }>;

    const KEY = (n: number) => `https://query.test/${n}`;
    const keysOf = (page: any): string[] => page.items.map((i: any) => i.itemKey);

    /** Build an ItemFilter from the catalog (mirrors the controller). */
    const filter = (field: string, op: string, ...values: string[]) => {
        const entry = catalog.get(field)!;
        return { field, fieldType: entry.type as any, path: entry.path, op: op as any, values };
    };
    const sortBy = (field: string, dir: "asc" | "desc") => {
        const entry = catalog.get(field)!;
        return { field, fieldType: entry.type as any, path: entry.path, dir };
    };

    beforeAll(async () => {
        await writeResultToDataset({
            producerType: "search",
            producerId: "query-seed",
            jobId: "query-seed",
            scope: { kind: "job", jobId: "query-seed" },
            scopeType: "search",
            result: [
                { url: KEY(1), price: 10, brand: "Acme", inStock: true, publishedAt: "2026-01-01T00:00:00.000Z" },
                { url: KEY(2), price: 20, brand: "Beta", inStock: false, publishedAt: "2026-02-01T00:00:00.000Z" },
                { url: KEY(3), price: 30, brand: "Acme", inStock: true, publishedAt: "2026-03-01T00:00:00.000Z" },
            ],
            mapping: PROJ_SEARCH_MAPPING,
            owner: OWNER,
            dataset: { create: { name: "Query DS" } },
            dbOrTx: db,
            now: new Date(),
        });
        // Resolve the dataset id from the freshly-created "Query DS".
        const row = sqlite.prepare(`SELECT uuid FROM datasets WHERE name = 'Query DS'`).get() as any;
        datasetId = row.uuid;
        catalog = await getDatasetProjectionFields(db, datasetId);
    });

    it("exposes the query_fields catalog with field → { path, type }", () => {
        expect(catalog.get("price")).toEqual({ path: "/price", type: "number" });
        expect(catalog.get("brand")).toEqual({ path: "/brand", type: "string" });
        expect(catalog.get("in_stock")).toEqual({ path: "/inStock", type: "boolean" });
        expect(catalog.get("published_at")).toEqual({ path: "/publishedAt", type: "timestamptz" });
    });

    it("filters numeric eq", async () => {
        const page = await getDatasetItems(db, { datasetId, limit: 50, filters: [filter("price", "eq", "20")] });
        expect(keysOf(page)).toEqual([KEY(2)]);
    });

    it("filters numeric range (gt / lte)", async () => {
        const gt = await getDatasetItems(db, { datasetId, limit: 50, filters: [filter("price", "gt", "15")] });
        expect(keysOf(gt).sort()).toEqual([KEY(2), KEY(3)]);
        const lte = await getDatasetItems(db, { datasetId, limit: 50, filters: [filter("price", "lte", "20")] });
        expect(keysOf(lte).sort()).toEqual([KEY(1), KEY(2)]);
    });

    it("filters string eq and in", async () => {
        const eq = await getDatasetItems(db, { datasetId, limit: 50, filters: [filter("brand", "eq", "Acme")] });
        expect(keysOf(eq).sort()).toEqual([KEY(1), KEY(3)]);
        const inList = await getDatasetItems(db, { datasetId, limit: 50, filters: [filter("brand", "in", "Beta", "Acme")] });
        expect(keysOf(inList).sort()).toEqual([KEY(1), KEY(2), KEY(3)]);
    });

    it("filters boolean eq", async () => {
        const t = await getDatasetItems(db, { datasetId, limit: 50, filters: [filter("in_stock", "eq", "true")] });
        expect(keysOf(t).sort()).toEqual([KEY(1), KEY(3)]);
        const f = await getDatasetItems(db, { datasetId, limit: 50, filters: [filter("in_stock", "eq", "false")] });
        expect(keysOf(f)).toEqual([KEY(2)]);
    });

    it("filters timestamptz range", async () => {
        const page = await getDatasetItems(db, {
            datasetId,
            limit: 50,
            filters: [filter("published_at", "gt", "2026-01-15T00:00:00.000Z")],
        });
        expect(keysOf(page).sort()).toEqual([KEY(2), KEY(3)]);
    });

    it("combines multiple filters (AND)", async () => {
        const page = await getDatasetItems(db, {
            datasetId,
            limit: 50,
            filters: [filter("brand", "eq", "Acme"), filter("price", "gt", "15")],
        });
        expect(keysOf(page)).toEqual([KEY(3)]);
    });

    it("sorts by a numeric projection asc/desc with a stable uuid tiebreaker", async () => {
        const asc = await getDatasetItems(db, { datasetId, limit: 50, sort: sortBy("price", "asc") });
        expect(keysOf(asc)).toEqual([KEY(1), KEY(2), KEY(3)]);
        const desc = await getDatasetItems(db, { datasetId, limit: 50, sort: sortBy("price", "desc") });
        expect(keysOf(desc)).toEqual([KEY(3), KEY(2), KEY(1)]);
    });

    it("paginates a projection sort via the keyset cursor", async () => {
        const p1 = await getDatasetItems(db, { datasetId, limit: 2, sort: sortBy("price", "asc") });
        expect(keysOf(p1)).toEqual([KEY(1), KEY(2)]);
        expect(p1.nextCursor).not.toBeNull();
        const p2 = await getDatasetItems(db, {
            datasetId,
            limit: 2,
            sort: sortBy("price", "asc"),
            cursor: p1.nextCursor,
        });
        expect(keysOf(p2)).toEqual([KEY(3)]);
        expect(p2.nextCursor).toBeNull();
    });
});


describe("Dataset run items include documents", () => {
    it("returns only the selected run's complete items in member cursor order", async () => {
        const out = await seedSearch({
            jobId: "run-document-1",
            result: [
                { url: "https://run.test/1", title: "One", nested: { camelCase: "preserved" } },
                { url: "https://run.test/2", title: "Two" },
                { url: "https://run.test/3", title: "Three" },
            ],
            dataset: { create: { name: "Run documents" } },
        });
        const runId = runIdOf(out.datasetId, "search", "run-document-1");
        await seedSearch({
            jobId: "run-document-2",
            result: [{ url: "https://run.test/other", title: "Other run" }],
            dataset: { datasetId: out.datasetId },
        });
        // A running producer may still have NULL sequence values. Those sort last.
        sqlite.prepare("UPDATE dataset_run_items SET sequence = NULL WHERE dataset_run_id = ?").run(runId);
        sqlite.prepare("UPDATE dataset_run_items SET sequence = 1 WHERE dataset_run_id = ? AND item_key = ?").run(runId, "https://run.test/2");
        sqlite.prepare("UPDATE dataset_run_items SET sequence = 2 WHERE dataset_run_id = ? AND item_key = ?").run(runId, "https://run.test/1");
        const members = sqlite.prepare("SELECT uuid, dataset_item_id, item_key FROM dataset_run_items WHERE dataset_run_id = ?").all(runId) as any[];
        const items: any[] = [];
        let cursor = null;
        for (let i = 0; i < 3; i++) {
            const page: { items: any[]; nextCursor: { v: number; id: string } | null } =
                await listDatasetRunItems(db, runId, { limit: 1, cursor });
            expect(page.items).toHaveLength(1);
            const item = page.items[0];
            const member = members.find(m => m.item_key === item.itemKey);
            expect(item.uuid).toBe(member.uuid);
            expect(item.datasetItemId).toBe(member.dataset_item_id);
            expect(item.datasetRunId).toBe(runId);
            expect(item.document).toEqual(expect.objectContaining({ url: item.sourceUrl }));
            expect(item.firstSeenAt).toBeInstanceOf(Date);
            expect(item.lastSeenAt).toBeInstanceOf(Date);
            expect(item.isActive).toBe(true);
            items.push(item);
            cursor = page.nextCursor;
            if (i < 2) expect(cursor).toEqual(expect.objectContaining({ id: member.uuid }));
        }
        expect(cursor).toBeNull();
        expect(items.map(item => item.itemKey)).toEqual([
            "https://run.test/2", "https://run.test/1", "https://run.test/3",
        ]);
        expect(items[1].document.nested).toEqual({ camelCase: "preserved" });
        expect(await listDatasetRunItems(db, "missing-run", { limit: 1 })).toEqual({ items: [], nextCursor: null });
    });
});
