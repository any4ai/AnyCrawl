import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const DEFAULT_OCR_PROVIDER_NAME = "vlRec";
const DEFAULT_OCR_MODEL = "PaddlePaddle/PaddleOCR-VL-1.5";
const DEFAULT_OCR_PROMPT = "OCR:";
const DEFAULT_OCR_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_OCR_TIMEOUT_MS = 30_000;
const DEFAULT_OCR_MIN_PIXELS = 112896;
const DEFAULT_OCR_MAX_PIXELS = 1003520;

export interface OCRCallOptions {
    prompt?: string;
    maxOutputTokens?: number;
    timeoutMs?: number;
    minPixels?: number;
    maxPixels?: number;
}

export interface OCRCallResult {
    text: string;
    usage?: unknown;
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

class LLMOCR {
    private readonly providerName: string;
    private readonly modelId: string;
    private readonly maxOutputTokens: number;
    private readonly timeoutMs: number;
    private readonly minPixels: number;
    private readonly maxPixels: number;
    private readonly provider: ReturnType<typeof createOpenAICompatible>;

    static isConfigured(): boolean {
        return Boolean(
            process.env.ANYCRAWL_VL_REC_SERVER_URL &&
            process.env.ANYCRAWL_VL_REC_API_KEY
        );
    }

    constructor() {
        const baseURL = process.env.ANYCRAWL_VL_REC_SERVER_URL;
        const apiKey = process.env.ANYCRAWL_VL_REC_API_KEY;

        if (!baseURL || !apiKey) {
            throw new Error("VL OCR provider is not configured. Missing ANYCRAWL_VL_REC_SERVER_URL or ANYCRAWL_VL_REC_API_KEY.");
        }

        this.providerName = process.env.ANYCRAWL_VL_REC_PROVIDER_NAME || DEFAULT_OCR_PROVIDER_NAME;
        this.modelId =
            process.env.ANYCRAWL_VL_REC_MODEL ||
            DEFAULT_OCR_MODEL;
        this.maxOutputTokens = parseNumberEnv(
            process.env.ANYCRAWL_VL_REC_MAX_OUTPUT_TOKENS,
            DEFAULT_OCR_MAX_OUTPUT_TOKENS
        );
        this.timeoutMs = parseNumberEnv(
            process.env.ANYCRAWL_VL_REC_TIMEOUT_MS,
            DEFAULT_OCR_TIMEOUT_MS
        );
        this.minPixels = parseNumberEnv(
            process.env.ANYCRAWL_VL_REC_MIN_PIXELS,
            DEFAULT_OCR_MIN_PIXELS
        );
        this.maxPixels = parseNumberEnv(
            process.env.ANYCRAWL_VL_REC_MAX_PIXELS,
            DEFAULT_OCR_MAX_PIXELS
        );

        this.provider = createOpenAICompatible({
            name: this.providerName,
            baseURL,
            apiKey,
        });
    }

    async recognizeImage(image: string | URL, options: OCRCallOptions = {}): Promise<OCRCallResult> {
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), timeoutMs);

        try {
            const result = await generateText({
                model: this.provider.chatModel(this.modelId),
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "image",
                                image,
                            },
                            {
                                type: "text",
                                text: options.prompt ?? DEFAULT_OCR_PROMPT,
                            },
                        ],
                    },
                ],
                temperature: 0,
                maxOutputTokens: options.maxOutputTokens ?? this.maxOutputTokens,
                abortSignal: abortController.signal,
                providerOptions: {
                    [this.providerName]: {
                        mm_processor_kwargs: {
                            min_pixels: options.minPixels ?? this.minPixels,
                            max_pixels: options.maxPixels ?? this.maxPixels,
                        },
                    },
                },
            });

            return {
                text: (result.text || "").trim(),
                usage: (result as any).usage,
            };
        } finally {
            clearTimeout(timer);
        }
    }
}

export { LLMOCR };
