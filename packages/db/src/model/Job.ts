import { asc } from "drizzle-orm";
import { getDB, schemas, eq, STATUS, sql } from "../index.js";
import { JOB_RESULT_STATUS, JobResultStatus } from "../map.js";
import { log } from "@anycrawl/libs/log";

export interface CreateJobParams {
    job_id: string;
    job_type: string;
    job_queue_name: string;
    url: string;
    req: {
        ip?: string;
        body?: any;
        auth?: { uuid?: string };
    };
    payload?: any;
    status?: string;
    is_success?: boolean;
}

export class Job {
    // Job type to expiration duration (ms)
    private static readonly JOB_TYPE_EXPIRE_MAP: Record<string, number> = {
        crawl: 3 * 60 * 60 * 1000, // 3 hours
        scrape: 1 * 60 * 60 * 1000, // 1 hour
        // add more types as needed
    };

    private static getJobExpireAt(job_type: string): Date {
        const duration = this.JOB_TYPE_EXPIRE_MAP[job_type] ?? (1 * 60 * 60 * 1000); // default 1 hour
        return new Date(Date.now() + duration);
    }

    private static extractReqMeta(req: {
        ip?: string;
        body?: any;
        auth?: { uuid?: string };
    }) {
        return {
            origin: req.ip,
            api_key_id: req.auth?.uuid,
        };
    }

    /**
     * Create a job in the jobs table
     */
    public static async create({
        job_id,
        job_type,
        job_queue_name,
        url,
        req,
        payload,
        status = STATUS.PENDING,
        is_success = false,
    }: CreateJobParams): Promise<void> {
        const db = await getDB();
        const { origin, api_key_id } = Job.extractReqMeta(req);
        const job_expire_at = Job.getJobExpireAt(job_type);

        await db.insert(schemas.jobs).values({
            jobId: job_id,
            jobType: job_type,
            jobQueueName: job_queue_name,
            jobExpireAt: job_expire_at,
            url,
            payload: payload ?? req.body,
            status: status,
            apiKey: api_key_id,
            origin: origin,
            isSuccess: is_success,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        try {
            log.info(`[DB][Job] Created job_id=${job_id} type=${job_type} queue=${job_queue_name} origin=${origin} apiKey=${api_key_id ?? "none"}`);
        } catch { }
    }

    /**
     * Get a job from the database
     * @param job_id - The ID of the job to get
     * @returns The job
     */
    public static async get(job_id: string) {
        const db = await getDB();
        const job = await db.select().from(schemas.jobs).where(eq(schemas.jobs.jobId, job_id)).limit(1);
        return job[0];
    }

    /**
     * Cancel a job
     * @param job_id - The ID of the job to cancel
     * @returns The cancelled job
     */
    public static async cancel(job_id: string) {
        const db = await getDB();
        const job = await Job.get(job_id);
        if (job) {
            await db.update(schemas.jobs).set({ status: STATUS.CANCELLED }).where(eq(schemas.jobs.jobId, job_id));
            try {
                log.info(`[DB][Job] Cancelled job_id=${job_id} status=${STATUS.CANCELLED}`);
            } catch { }
            return job;
        }
        try {
            log.warning(`[DB][Job] Cancel attempt for nonexistent job_id=${job_id}`);
        } catch { }
        return null;
    }

    /**
     * Update the status of a job
     * @param job_id - The ID of the job to update
     * @param status - The status to update the job to
     */
    public static async updateStatus(job_id: string, status: string, isSuccess: boolean | null = null) {
        const db = await getDB();
        if (isSuccess !== null) {
            await db.update(schemas.jobs).set({ status: status, isSuccess: isSuccess }).where(eq(schemas.jobs.jobId, job_id));
        } else {
            await db.update(schemas.jobs).set({ status: status }).where(eq(schemas.jobs.jobId, job_id));
        }
        try {
            log.info(`[DB][Job] Updated status job_id=${job_id} status=${status}${isSuccess !== null ? ` isSuccess=${isSuccess}` : ""}`);
        } catch { }
    }

    /**
     * Mark a job as completed
     * @param jobId - The ID of the job to mark as completed
     */
    public static async markAsCompleted(
        jobId: string,
        isSuccess: boolean = true,
        counts?: { total?: number; completed?: number; failed?: number }
    ) {
        const db = await getDB();
        await db.update(schemas.jobs).set({
            status: STATUS.COMPLETED,
            isSuccess: isSuccess,
            ...(counts?.total !== undefined ? { total: counts.total } : {}),
            ...(counts?.completed !== undefined ? { completed: counts.completed } : {}),
            ...(counts?.failed !== undefined ? { failed: counts.failed } : {}),
            updatedAt: new Date(),
        }).where(eq(schemas.jobs.jobId, jobId));

        try {
            const countsInfo = `total=${counts?.total ?? "-"} completed=${counts?.completed ?? "-"} failed=${counts?.failed ?? "-"}`;
            log.info(`[DB][Job] Marked completed job_id=${jobId} isSuccess=${isSuccess} ${countsInfo}`);
        } catch { }
    }

    /**
     * Mark a job as pending
     * @param jobId - The ID of the job to mark as pending
     */
    public static async markAsPending(jobId: string) {
        await Job.updateStatus(jobId, STATUS.PENDING);
    }

    /**
     * Mark a job as failed
     * @param jobId - The ID of the job to mark as failed
     */
    public static async markAsFailed(
        jobId: string,
        errorMessage: string,
        isSuccess: boolean = false,
        counts?: { total?: number; completed?: number; failed?: number }
    ) {
        const db = await getDB();
        await db.update(schemas.jobs).set({
            status: STATUS.FAILED,
            isSuccess: isSuccess,
            errorMessage: errorMessage,
            ...(counts?.total !== undefined ? { total: counts.total } : {}),
            ...(counts?.completed !== undefined ? { completed: counts.completed } : {}),
            ...(counts?.failed !== undefined ? { failed: counts.failed } : {}),
            updatedAt: new Date(),
        }).where(eq(schemas.jobs.jobId, jobId));

        try {
            const countsInfo = `total=${counts?.total ?? "-"} completed=${counts?.completed ?? "-"} failed=${counts?.failed ?? "-"}`;
            log.error(`[DB][Job] Marked failed job_id=${jobId} message="${errorMessage}" ${countsInfo}`);
        } catch { }
    }

    /**
     * Sanitize malformed Unicode characters from data to prevent PostgreSQL JSONB errors.
     * Recursively cleans strings, arrays, and object properties.
     * @param data - The data to sanitize
     * @returns Sanitized data safe for PostgreSQL JSONB
     */
    private static sanitizeUnicode(data: any): any {
        if (data === null || data === undefined) {
            return data;
        }

        if (typeof data === 'string') {
            // Replace unpaired surrogates with Unicode replacement character (U+FFFD)
            // This regex matches:
            // - High surrogates (U+D800 to U+DBFF) not followed by low surrogates
            // - Low surrogates (U+DC00 to U+DFFF) not preceded by high surrogates
            return data
                .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD') // unpaired high surrogate
                .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD'); // unpaired low surrogate
        }

        if (Array.isArray(data)) {
            return data.map(item => Job.sanitizeUnicode(item));
        }

        if (typeof data === 'object') {
            const sanitized: any = {};
            for (const [key, value] of Object.entries(data)) {
                sanitized[key] = Job.sanitizeUnicode(value);
            }
            return sanitized;
        }

        return data;
    }

    /**
     * Insert a job result into the job_results table
     * @param jobId - The string ID of the job
     * @param url - The URL that was processed
     * @param data - The extracted data
     * @param status - The status of this particular result (e.g., 'success', 'failed')
     */
    public static async insertJobResult(jobId: string, url: string, data: any, status: JobResultStatus = JOB_RESULT_STATUS.SUCCESS) {
        const db = await getDB();

        // First, get the job by jobId to obtain its UUID
        const job = await Job.get(jobId);
        if (!job) {
            throw new Error(`Job with ID ${jobId} not found`);
        }

        // Sanitize data to prevent PostgreSQL JSONB errors from malformed Unicode
        const sanitizedData = Job.sanitizeUnicode(data);

        await db.insert(schemas.jobResults).values({
            jobUuid: job.uuid, // Use the job's UUID as foreign key
            url: url,
            data: sanitizedData,
            status: status,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        try {
            const dataType = sanitizedData === null || sanitizedData === undefined ? "null" : Array.isArray(sanitizedData) ? `array(len=${sanitizedData.length})` : typeof sanitizedData;
            log.info(`[DB][JobResult] Inserted result job_id=${jobId} url=${url} status=${status} dataType=${dataType}`);
        } catch { }
    }

    /**
     * Get all results for a job
     * @param jobId - The string ID of the job
     * @returns Array of job results
     */
    public static async getJobResults(jobId: string) {
        const db = await getDB();

        // First, get the job by jobId to obtain its UUID
        const job = await Job.get(jobId);
        if (!job) {
            throw new Error(`Job with ID ${jobId} not found`);
        }

        return await db.select().from(schemas.jobResults).where(eq(schemas.jobResults.jobUuid, job.uuid));
    }

    /**
     * Get paginated results for a job
     * @param jobId - The job ID
     * @param skip - Number of records to skip
     * @param limit - Max number of records to return
     */
    public static async getJobResultsPaginated(jobId: string, skip: number, limit: number) {
        const db = await getDB();

        const job = await Job.get(jobId);
        if (!job) {
            throw new Error(`Job with ID ${jobId} not found`);
        }

        return await db
            .select()
            .from(schemas.jobResults)
            .where(eq(schemas.jobResults.jobUuid, job.uuid))
            .orderBy(asc(schemas.jobResults.createdAt))
            .limit(limit)
            .offset(skip);
    }

    /**
     * Get total count of results for a job
     */
    public static async getJobResultsCount(jobId: string): Promise<number> {
        const db = await getDB();

        const job = await Job.get(jobId);
        if (!job) {
            throw new Error(`Job with ID ${jobId} not found`);
        }

        const rows = await db
            .select({ count: sql<number>`count(*)` })
            .from(schemas.jobResults)
            .where(eq(schemas.jobResults.jobUuid, job.uuid));
        const count = rows?.[0]?.count as unknown as number;
        return Number(count || 0);
    }

    /**
     * Update job counts without changing status
     */
    public static async updateCounts(jobId: string, counts: { total?: number; completed?: number; failed?: number }) {
        const db = await getDB();
        await db.update(schemas.jobs).set({
            ...(counts.total !== undefined ? { total: counts.total } : {}),
            ...(counts.completed !== undefined ? { completed: counts.completed } : {}),
            ...(counts.failed !== undefined ? { failed: counts.failed } : {}),
            updatedAt: new Date(),
        }).where(eq(schemas.jobs.jobId, jobId));

        try {
            const countsInfo = `total=${counts.total ?? "-"} completed=${counts.completed ?? "-"} failed=${counts.failed ?? "-"}`;
            log.info(`[DB][Job] Updated counts job_id=${jobId} ${countsInfo}`);
        } catch { }
    }

    /**
     * Add network traffic usage to a job (atomic increment).
     */
    public static async addTraffic(
        jobId: string,
        delta: { totalBytes?: number; requestBytes?: number; responseBytes?: number; requestCount?: number }
    ) {
        const db = await getDB();
        const update: Record<string, any> = { updatedAt: new Date() };

        if (delta.totalBytes && delta.totalBytes > 0) {
            update.trafficBytes = sql`${schemas.jobs.trafficBytes} + ${delta.totalBytes}`;
        }
        if (delta.requestBytes && delta.requestBytes > 0) {
            update.trafficRequestBytes = sql`${schemas.jobs.trafficRequestBytes} + ${delta.requestBytes}`;
        }
        if (delta.responseBytes && delta.responseBytes > 0) {
            update.trafficResponseBytes = sql`${schemas.jobs.trafficResponseBytes} + ${delta.responseBytes}`;
        }
        if (delta.requestCount && delta.requestCount > 0) {
            update.trafficRequestCount = sql`${schemas.jobs.trafficRequestCount} + ${delta.requestCount}`;
        }

        await db.update(schemas.jobs).set(update).where(eq(schemas.jobs.jobId, jobId));

        try {
            log.debug(
                `[DB][Job] Added traffic job_id=${jobId} total=${delta.totalBytes ?? 0} request=${delta.requestBytes ?? 0} response=${delta.responseBytes ?? 0} count=${delta.requestCount ?? 0}`
            );
        } catch { }
    }
}
