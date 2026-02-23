import { eq, and, gt, gte, sql, desc } from "drizzle-orm";
import { getDB, schemas } from "./db/index.js";
import { STATUS, JOB_RESULT_STATUS } from "./map.js";
import { Job, CreateJobParams } from "./model/Job.js";
import { Template, CreateTemplateParams } from "./model/Template.js";
import { Billing } from "./model/Billing.js";
import {
    buildTaskWhereClause as buildTaskWhereClauseByOwner,
    buildWebhookWhereClause as buildWebhookWhereClauseByOwner,
    getOwnedTask as getOwnedTaskByOwner,
    listTasksByOwner as listTasksByOwnerOwner,
    getOwnedWebhook as getOwnedWebhookByOwner,
    listWebhooksByOwner as listWebhooksByOwnerOwner,
} from "./model/OwnerAccess.js";

// Backward compatibility functions
export const createJob = Job.create;
export const getJob = Job.get;
export const cancelJob = Job.cancel;
export const updateJobStatus = Job.updateStatus;
export const failedJob = Job.markAsFailed;
export const completedJob = Job.markAsCompleted;
export const insertJobResult = Job.insertJobResult;
export const getJobResults = Job.getJobResults;
export const getJobResultsPaginated = Job.getJobResultsPaginated;
export const getJobResultsCount = Job.getJobResultsCount;
export const updateJobCounts = Job.updateCounts;
export const updateJobCacheHits = Job.updateCacheHits;
export const addJobTraffic = Job.addTraffic;


export const createTemplate = Template.create;
export const getTemplate = Template.get;
export const updateTemplate = Template.update;
export const deleteTemplate = Template.delete;
export const deleteTemplateIfExists = Template.deleteIfExists;
export const existsTemplate = Template.exists;

export const chargeDeltaByJobId = Billing.chargeDeltaByJobId;
export const chargeToUsedByJobId = Billing.chargeToUsedByJobId;
export const buildTaskWhereClause = buildTaskWhereClauseByOwner;
export const buildWebhookWhereClause = buildWebhookWhereClauseByOwner;
export const getOwnedTask = getOwnedTaskByOwner;
export const listTasksByOwner = listTasksByOwnerOwner;
export const getOwnedWebhook = getOwnedWebhookByOwner;
export const listWebhooksByOwner = listWebhooksByOwnerOwner;

// Template system exports
export { templates, templateExecutions, billingLedger } from "./db/schemas/PostgreSQL.js";

// Scheduled tasks and webhooks exports
export {
    scheduledTasks,
    taskExecutions,
    webhookSubscriptions,
    webhookDeliveries,
    pageCache,
    mapCache
} from "./db/schemas/PostgreSQL.js";

export { eq, and, gt, gte, sql, desc, getDB, schemas, STATUS, JOB_RESULT_STATUS, Job, Billing };
export type { CreateJobParams, CreateTemplateParams };
