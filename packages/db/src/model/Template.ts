import { getDB, schemas } from "../db/index.js";
import { eq, sql } from "drizzle-orm";
import type { TemplateConfig } from "@anycrawl/libs";

export interface CreateTemplateParams {
    templateId: string;
    name: string;
    description?: string;
    tags: string[];
    templateType: "scrape" | "crawl" | "search";
    pricing: {
        perCall: number;
        currency: string;
    };
    reqOptions: any;
    customHandlers?: any;
    metadata?: any;
    variables?: any;
    createdBy: string;
    publishedBy?: string;
    reviewedBy?: string;
    status?: string;
    reviewStatus?: string;
    reviewNotes?: string;
    trusted?: boolean;
}

export class Template {
    /**
     * Create a new template
     */
    static async create(params: CreateTemplateParams): Promise<TemplateConfig> {
        const db = await getDB();

        const templateData = {
            templateId: params.templateId,
            name: params.name,
            description: params.description || "",
            tags: params.tags,
            version: "1.0.0",
            templateType: params.templateType,
            pricing: params.pricing,
            reqOptions: params.reqOptions,
            customHandlers: params.customHandlers || null,
            metadata: params.metadata || {},
            variables: params.variables || null,
            createdBy: params.createdBy,
            publishedBy: params.publishedBy || null,
            reviewedBy: params.reviewedBy || null,
            status: params.status || "draft",
            reviewStatus: params.reviewStatus || "pending",
            reviewNotes: params.reviewNotes || "",
            trusted: params.trusted || false,
            createdAt: new Date(),
            updatedAt: new Date(),
            publishedAt: params.publishedBy ? new Date() : null,
            reviewedAt: params.reviewedBy ? new Date() : null,
        };

        const result = await db.insert(schemas.templates).values(templateData).returning();
        return Template.mapDbToTemplate(result[0]);
    }

    /**
     * Get template by ID
     */
    static async get(templateId: string): Promise<TemplateConfig | null> {
        const db = await getDB();
        const result = await db
            .select()
            .from(schemas.templates)
            .where(eq(schemas.templates.templateId, templateId))
            .limit(1);

        if (result.length === 0) {
            return null;
        }

        return Template.mapDbToTemplate(result[0]);
    }

    /**
     * Get template by UUID (primary key)
     */
    static async getByUuid(uuid: string): Promise<TemplateConfig | null> {
        const db = await getDB();
        const result = await db
            .select()
            .from(schemas.templates)
            .where(eq(schemas.templates.uuid, uuid))
            .limit(1);

        if (result.length === 0) {
            return null;
        }

        return Template.mapDbToTemplate(result[0]);
    }

    /**
     * Update template
     */
    static async update(
        templateId: string,
        updates: Partial<CreateTemplateParams> & { version?: string }
    ): Promise<TemplateConfig | null> {
        const db = await getDB();

        const updateData: any = {
            updatedAt: new Date(),
        };

        if (updates.name !== undefined) updateData.name = updates.name;
        if (updates.description !== undefined) updateData.description = updates.description;
        if (updates.tags !== undefined) updateData.tags = updates.tags;
        if (updates.templateType !== undefined) updateData.templateType = updates.templateType;
        if (updates.pricing !== undefined) updateData.pricing = updates.pricing;
        if (updates.reqOptions !== undefined) updateData.reqOptions = updates.reqOptions;
        if (updates.customHandlers !== undefined)
            updateData.customHandlers = updates.customHandlers || null;
        if (updates.metadata !== undefined) updateData.metadata = updates.metadata;
        if (updates.variables !== undefined) updateData.variables = updates.variables || null;
        if (updates.status !== undefined) updateData.status = updates.status;
        if (updates.reviewStatus !== undefined) updateData.reviewStatus = updates.reviewStatus;
        if (updates.reviewNotes !== undefined) updateData.reviewNotes = updates.reviewNotes;
        if (updates.trusted !== undefined) updateData.trusted = updates.trusted;
        if (updates.version !== undefined) updateData.version = updates.version;

        const result = await db
            .update(schemas.templates)
            .set(updateData)
            .where(eq(schemas.templates.templateId, templateId))
            .returning();

        if (result.length === 0) {
            return null;
        }

        return Template.mapDbToTemplate(result[0]);
    }

    /**
     * Delete template
     */
    static async delete(templateId: string): Promise<boolean> {
        const db = await getDB();
        const result = await db
            .delete(schemas.templates)
            .where(eq(schemas.templates.templateId, templateId))
            .returning();

        return result.length > 0;
    }

    /**
     * Get all templates
     */
    static async getAll(filters?: {
        status?: string;
        createdBy?: string;
        tags?: string[];
    }): Promise<TemplateConfig[]> {
        const db = await getDB();
        let query = db.select().from(schemas.templates);

        if (filters) {
            if (filters.status) {
                query = query.where(eq(schemas.templates.status, filters.status));
            }
            if (filters.createdBy) {
                query = query.where(eq(schemas.templates.createdBy, filters.createdBy));
            }
        }

        const results = await query;
        return results.map((row: any) => Template.mapDbToTemplate(row));
    }

    /**
     * Delete template if exists
     */
    static async deleteIfExists(templateId: string): Promise<void> {
        const db = await getDB();
        await db.delete(schemas.templates).where(eq(schemas.templates.templateId, templateId));
    }

    /**
     * Check if template exists
     */
    static async exists(templateId: string): Promise<boolean> {
        const db = await getDB();
        const result = await db
            .select({ count: sql<number>`count(*)` })
            .from(schemas.templates)
            .where(eq(schemas.templates.templateId, templateId));

        return result[0].count > 0;
    }

    /**
     * Map database row to TemplateConfig
     */
    private static mapDbToTemplate(row: any): TemplateConfig {
        return {
            uuid: row.uuid,
            templateId: row.templateId,
            name: row.name,
            description: row.description,
            tags: row.tags || [],
            version: row.version,
            templateType: row.templateType,
            pricing: row.pricing,
            reqOptions: row.reqOptions,
            customHandlers: row.customHandlers || undefined,
            metadata: row.metadata || {},
            variables: row.variables || undefined,
            createdBy: row.createdBy,
            publishedBy: row.publishedBy,
            reviewedBy: row.reviewedBy,
            status: row.status,
            reviewStatus: row.reviewStatus,
            reviewNotes: row.reviewNotes,
            trusted: row.trusted || false,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            publishedAt: row.publishedAt,
            reviewedAt: row.reviewedAt,
            archivedAt: row.archivedAt,
        };
    }
}
