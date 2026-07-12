import { generateObject, getExtractModelId, getLLM } from "@anycrawl/ai";
import { z } from "zod";
import { log } from "@anycrawl/libs";

const verdictSchema = z.object({
    meaningful: z.boolean(),
    confidence: z.enum(["low", "medium", "high"]),
    reason: z.string(),
});

export interface JudgmentResult {
    meaningful: boolean;
    confidence: "low" | "medium" | "high";
    reason: string;
}

/**
 * Ask an LLM whether a diff is meaningful relative to a user-defined goal.
 *
 * Returns { meaningful: true, confidence: "medium", reason: "..." } when no
 * LLM provider is configured, so monitoring keeps running without AI in
 * degraded mode.
 */
export async function judgeChange(
    goal: string,
    diffText: string,
    url: string
): Promise<JudgmentResult> {
    const modelId = getExtractModelId();

    const systemPrompt = `You are a change-detection judge. Your only job is to decide whether an observed diff on a web page is meaningful relative to the stated monitoring goal.

Ignore mechanical noise such as rotating tokens, session IDs, footer timestamps, ad slots, or cache-buster query strings.

Respond ONLY with a JSON object matching the schema: { meaningful: boolean, confidence: "low"|"medium"|"high", reason: string }.`;

    const userPrompt = `Monitoring goal: "${goal}"

URL: ${url}

Diff (unified format, first 3000 chars):
${diffText.slice(0, 3000)}

Is this change meaningful relative to the goal?`;

    try {
        const generateObjectFn = generateObject as any;
        const { object } = await generateObjectFn({
            model: getLLM(modelId),
            system: systemPrompt,
            prompt: userPrompt,
            schema: verdictSchema,
        });
        return object as JudgmentResult;
    } catch (err) {
        log.warning(`[MONITOR JUDGE] LLM judgment failed for ${url}: ${err}. Treating as meaningful.`);
        return { meaningful: true, confidence: "low", reason: "AI judge unavailable; defaulting to meaningful" };
    }
}
