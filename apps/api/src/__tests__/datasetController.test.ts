import { jest, describe, it, expect, beforeEach } from "@jest/globals";

/**
 * Route-level tests for DatasetController, focused on the new export endpoints
 * (POST/GET /v1/datasets/:id/exports, GET /v1/datasets/:id/exports/:export_id).
 * There was previously no route-level test file for DatasetController at all.
 *
 * Mirrors templateRun.controller.test.ts's approach: mock the `@anycrawl/db` and
 * `@anycrawl/scrape` collaborators (no live DB / Redis needed), call the
 * controller methods directly against hand-rolled req/res doubles.
 */

// --- Mocked collaborators (shared spies) -----------------------------------
const getDatasetRun = jest.fn<(...args: any[]) => Promise<any>>();
const listDatasetRunItems = jest.fn<(...args: any[]) => Promise<any>>();
const getDB = jest.fn(async () => ({}));
const getOwnedDataset = jest.fn<(db: any, id: string, owner: any) => Promise<any>>();
const createDatasetExport = jest.fn<(db: any, params: any) => Promise<any>>();
const listDatasetExports = jest.fn<(db: any, id: string, opts: any) => Promise<any>>();
const getDatasetExport = jest.fn<(db: any, datasetId: string, exportId: string) => Promise<any>>();
const addDatasetExportJob = jest.fn<(payload: any) => Promise<string>>(async () => "bull-export-1");
const getTemporaryUrl = jest.fn<(key: string) => Promise<string>>(async (key: string) => `https://signed.test/${key}`);

jest.unstable_mockModule("@anycrawl/db", () => ({
    getDB,
    getOwnedDataset,
    createDatasetExport,
    listDatasetExports,
    getDatasetExport,
    // Unused by the export routes but imported by DatasetController.ts — stub as
    // no-op jest.fn()s so the module loads without throwing.
    createDataset: jest.fn(),
    updateDataset: jest.fn(),
    softDeleteDataset: jest.fn(),
    listDatasetsByOwner: jest.fn(),
    getDatasetProjectionFields: jest.fn(),
    getDatasetItems: jest.fn(),
    listDatasetRuns: jest.fn(),
    getDatasetRun,
    listDatasetRunItems,
    listDatasetChanges: jest.fn(),
    listRunWarnings: jest.fn(),
    // Pass-through: what the real helper does for a dataset with no retention policy.
    withVisibleItemCounts: jest.fn(async (_db: any, rows: any[]) => rows),
}));

jest.unstable_mockModule("@anycrawl/scrape", () => ({
    QueueManager: { getInstance: () => ({ addDatasetExportJob }) },
}));

jest.unstable_mockModule("@anycrawl/libs", () => ({
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    s3: { getTemporaryUrl },
}));

const { DatasetController } = await import("../controllers/v1/DatasetController.js");

// --- Test doubles -------------------------------------------------------------
function mockRes(): any {
    const res: any = { statusCode: 0, body: undefined };
    res.status = (code: number) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body: any) => {
        res.body = body;
        res.statusCode = res.statusCode || 200;
        return res;
    };
    return res;
}

function mockReq(params: any = {}, opts: { body?: any; query?: any } = {}): any {
    return {
        params,
        body: opts.body ?? {},
        query: opts.query ?? {},
        auth: { user: "user-1", uuid: "key-1" },
    };
}

const ownedDataset = { uuid: "ds-1", name: "My Dataset", userId: "user-1" };

beforeEach(() => {
    jest.clearAllMocks();
    getOwnedDataset.mockResolvedValue(ownedDataset);
    getTemporaryUrl.mockImplementation(async (key: string) => `https://signed.test/${key}`);
});

describe("DatasetController.createExport (POST /v1/datasets/:id/exports)", () => {
    it("creates a queued export row and enqueues the dataset-export job (201)", async () => {
        const exportRow = {
            uuid: "exp-1",
            datasetId: "ds-1",
            format: "jsonl",
            status: "queued",
            itemCount: null,
            fileKey: null,
            error: null,
            createdAt: new Date("2026-08-07T00:00:00Z"),
            updatedAt: new Date("2026-08-07T00:00:00Z"),
            completedAt: null,
        };
        createDatasetExport.mockResolvedValue(exportRow);

        const res = mockRes();
        await new DatasetController().createExport(
            mockReq({ id: "ds-1" }, { body: { format: "jsonl" } }),
            res
        );

        expect(getOwnedDataset).toHaveBeenCalledWith(expect.anything(), "ds-1", { apiKeyId: "key-1", userId: "user-1" });
        expect(createDatasetExport).toHaveBeenCalledWith(expect.anything(), { datasetId: "ds-1", format: "jsonl" });

        expect(addDatasetExportJob).toHaveBeenCalledTimes(1);
        expect(addDatasetExportJob).toHaveBeenCalledWith({
            type: "dataset-export",
            exportId: "exp-1",
            datasetId: "ds-1",
            format: "jsonl",
        });

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.uuid).toBe("exp-1");
        expect(res.body.data.status).toBe("queued");
    });

    it("returns 404 (not 403) when the dataset is not owned / does not exist, and never enqueues", async () => {
        getOwnedDataset.mockResolvedValue(null);

        const res = mockRes();
        await new DatasetController().createExport(
            mockReq({ id: "someone-elses-ds" }, { body: { format: "csv" } }),
            res
        );

        expect(res.statusCode).toBe(404);
        expect(res.body.error).toBe("dataset_not_found");
        expect(createDatasetExport).not.toHaveBeenCalled();
        expect(addDatasetExportJob).not.toHaveBeenCalled();
    });

    it("returns 400 for an invalid format", async () => {
        const res = mockRes();
        await new DatasetController().createExport(
            mockReq({ id: "ds-1" }, { body: { format: "xml" } }),
            res
        );

        expect(res.statusCode).toBe(400);
        expect(createDatasetExport).not.toHaveBeenCalled();
        expect(addDatasetExportJob).not.toHaveBeenCalled();
    });
});

describe("DatasetController.listExports (GET /v1/datasets/:id/exports)", () => {
    it("returns the export page with a next_cursor envelope", async () => {
        const items = [
            { uuid: "exp-2", datasetId: "ds-1", format: "csv", status: "completed" },
            { uuid: "exp-1", datasetId: "ds-1", format: "jsonl", status: "queued" },
        ];
        listDatasetExports.mockResolvedValue({ items, nextCursor: null });

        const res = mockRes();
        await new DatasetController().listExports(mockReq({ id: "ds-1" }), res);

        expect(listDatasetExports).toHaveBeenCalledWith(expect.anything(), "ds-1", { limit: 100, cursor: null });
        expect(res.body.success).toBe(true);
        expect(res.body.data.exports).toHaveLength(2);
        expect(res.body.data.exports[0].uuid).toBe("exp-2");
        expect(res.body.data.next_cursor).toBeNull();
    });

    it("returns 404 when the dataset is not owned / does not exist", async () => {
        getOwnedDataset.mockResolvedValue(null);

        const res = mockRes();
        await new DatasetController().listExports(mockReq({ id: "ds-x" }), res);

        expect(res.statusCode).toBe(404);
        expect(res.body.error).toBe("dataset_not_found");
        expect(listDatasetExports).not.toHaveBeenCalled();
    });
});

describe("DatasetController.getExport (GET /v1/datasets/:id/exports/:export_id)", () => {
    it("returns 404 when the export does not exist / belongs to a different dataset", async () => {
        getDatasetExport.mockResolvedValue(null);

        const res = mockRes();
        await new DatasetController().getExport(mockReq({ id: "ds-1", export_id: "wrong-export" }), res);

        expect(res.statusCode).toBe(404);
        expect(res.body.error).toBe("dataset_export_not_found");
    });

    it("returns 404 (not 403) when the parent dataset is not owned", async () => {
        getOwnedDataset.mockResolvedValue(null);

        const res = mockRes();
        await new DatasetController().getExport(mockReq({ id: "not-mine", export_id: "exp-1" }), res);

        expect(res.statusCode).toBe(404);
        expect(res.body.error).toBe("dataset_not_found");
        expect(getDatasetExport).not.toHaveBeenCalled();
    });

    it("includes a freshly-generated download_url for a completed export", async () => {
        getDatasetExport.mockResolvedValue({
            uuid: "exp-1",
            datasetId: "ds-1",
            format: "jsonl",
            status: "completed",
            itemCount: 10,
            fileKey: "dataset-exports/ds-1/exp-1.jsonl",
            error: null,
            completedAt: new Date("2026-08-07T00:05:00Z"),
        });

        const res = mockRes();
        await new DatasetController().getExport(mockReq({ id: "ds-1", export_id: "exp-1" }), res);

        expect(getTemporaryUrl).toHaveBeenCalledWith("dataset-exports/ds-1/exp-1.jsonl");
        expect(res.body.data.download_url).toBe("https://signed.test/dataset-exports/ds-1/exp-1.jsonl");
    });

    it("omits download_url for a non-completed export and never signs a URL", async () => {
        getDatasetExport.mockResolvedValue({
            uuid: "exp-1",
            datasetId: "ds-1",
            format: "jsonl",
            status: "queued",
            itemCount: null,
            fileKey: null,
            error: null,
            completedAt: null,
        });

        const res = mockRes();
        await new DatasetController().getExport(mockReq({ id: "ds-1", export_id: "exp-1" }), res);

        expect(getTemporaryUrl).not.toHaveBeenCalled();
        expect(res.body.data.download_url).toBeUndefined();
    });
});


describe("DatasetController.runItems", () => {
    it("returns a renderable document without renaming its nested keys", async () => {
        getDatasetRun.mockResolvedValue({ uuid: "run-1" });
        const document = { jsonResult: [{ userName: "example", nestedValue: null }] };
        listDatasetRunItems.mockResolvedValue({
            items: [{ uuid: "member-1", datasetItemId: "item-1", itemKey: "key-1", sourceUrl: "https://example.com", document, sequence: 1 }],
            nextCursor: null,
        });
        const res = mockRes();
        await new DatasetController().runItems(mockReq({ id: "ds-1", run_id: "run-1" }), res);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(JSON.stringify(res.body)).data.items[0]).toEqual({
            uuid: "member-1", dataset_item_id: "item-1", item_key: "key-1",
            source_url: "https://example.com", document, sequence: 1,
        });
        expect(getDatasetRun).toHaveBeenCalledWith(expect.anything(), "ds-1", "run-1");
    });

    it("does not read items for an inaccessible dataset or a run from another dataset", async () => {
        getOwnedDataset.mockResolvedValueOnce(null);
        const denied = mockRes();
        await new DatasetController().runItems(mockReq({ id: "ds-1", run_id: "run-1" }), denied);
        expect(denied.statusCode).toBe(404);
        expect(listDatasetRunItems).not.toHaveBeenCalled();
        getDatasetRun.mockResolvedValueOnce(null);
        const mismatch = mockRes();
        await new DatasetController().runItems(mockReq({ id: "ds-1", run_id: "other-run" }), mismatch);
        expect(mismatch.statusCode).toBe(404);
        expect(listDatasetRunItems).not.toHaveBeenCalled();
    });
});
