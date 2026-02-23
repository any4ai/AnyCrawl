import { LLMExtract } from '../agents/LLMExtract.js';
import { JSONSchema7 } from 'ai';
import { log } from '@anycrawl/libs';
import { ensureAIConfigLoaded, getAIConfig } from '../utils/config.js';
import { getExtractModelId } from '../utils/helper.js';

(globalThis as any).AI_SDK_LOG_WARNINGS = false;
// 测试数据
const testMarkdown = `
# Company Information

**Company Name:** TechCorp Solutions Inc.
**Founded:** 2015
**Industry:** Software Development, AI Services
**Headquarters:** San Francisco, CA

## About Us
TechCorp Solutions is a leading software development company specializing in AI and machine learning solutions. We have over 200 employees and serve clients worldwide.

## Contact Information
- **Email:** info@techcorp.com
- **Phone:** +1-555-123-4567
- **Website:** https://techcorp.com

## Services
- AI Development
- Machine Learning Consulting
- Cloud Solutions
- Data Analytics

## Recent News
- Raised $50M Series B funding in 2023
- Launched new AI platform
- Expanded to European markets
`;

const longTestMarkdown = `
# Comprehensive Company Report

## Executive Summary
TechCorp Solutions Inc. is a rapidly growing technology company that has established itself as a leader in the artificial intelligence and machine learning space. Founded in 2015 by a team of experienced engineers from Silicon Valley, the company has grown from a small startup to a major player in the tech industry.

## Company Overview
**Legal Name:** TechCorp Solutions Incorporated
**Trade Name:** TechCorp
**Founded:** January 15, 2015
**Incorporation:** Delaware, USA
**Industry Classification:** Software Development & AI Services
**Business Type:** B2B Technology Services
**Headquarters:** 123 Innovation Drive, San Francisco, CA 94105
**Additional Offices:** 
- New York, NY (Sales Office)
- Austin, TX (Development Center)
- London, UK (European Headquarters)
- Tokyo, Japan (Asian Operations)

## Leadership Team
**Chief Executive Officer:** Sarah Johnson (Former Google VP)
**Chief Technology Officer:** Michael Chen (Ex-Microsoft Principal Engineer)
**Chief Financial Officer:** David Rodriguez (Former Goldman Sachs VP)
**VP of Engineering:** Lisa Wang (Previously at Tesla)
**VP of Sales:** Robert Kim (Former Salesforce Director)

## Financial Information
**Last Funding Round:** Series B - $50 Million (March 2023)
**Lead Investor:** Sequoia Capital
**Total Funding Raised:** $75 Million
**Valuation:** $500 Million (as of March 2023)
**Revenue (2023):** $45 Million (estimated)
**Employee Count:** 247 (as of December 2023)
**Growth Rate:** 150% YoY

## Products and Services
### Core AI Platform
- **TechCorp AI Engine:** Proprietary machine learning platform
- **AutoML Suite:** Automated machine learning tools
- **Data Pipeline Manager:** Real-time data processing
- **Model Deployment Service:** Cloud-based ML model hosting

### Consulting Services
- AI Strategy Consulting
- Machine Learning Implementation
- Data Science Training
- Custom AI Development

### Industry Solutions
- **Healthcare AI:** Medical imaging analysis
- **Financial AI:** Fraud detection and risk assessment
- **Retail AI:** Recommendation engines and inventory optimization
- **Manufacturing AI:** Predictive maintenance and quality control

## Technology Stack
**Programming Languages:** Python, JavaScript, Go, Rust
**Machine Learning Frameworks:** TensorFlow, PyTorch, Scikit-learn
**Cloud Platforms:** AWS, Google Cloud, Azure
**Databases:** PostgreSQL, MongoDB, Redis
**Infrastructure:** Kubernetes, Docker, Terraform

## Market Position
TechCorp Solutions has positioned itself as a premium AI services provider, competing with companies like DataRobot, H2O.ai, and Databricks. The company's unique value proposition lies in its combination of cutting-edge research capabilities and practical business implementation experience.

## Recent Achievements
- **2023:** Launched TechCorp AI Engine 3.0
- **2023:** Expanded to European markets with London office
- **2022:** Achieved SOC 2 Type II compliance
- **2022:** Published 15 research papers in top-tier conferences
- **2021:** Won "Best AI Startup" award at TechCrunch Disrupt

## Contact Information
**Main Office:** 123 Innovation Drive, San Francisco, CA 94105
**Phone:** +1-555-123-4567
**Email:** info@techcorp.com
**Website:** https://www.techcorp.com
**LinkedIn:** https://linkedin.com/company/techcorp-solutions
**Twitter:** @TechCorpAI

## Compliance and Certifications
- SOC 2 Type II Certified
- ISO 27001 Compliant
- GDPR Compliant
- HIPAA Compliant (for healthcare solutions)
- FedRAMP Authorized (for government solutions)

This comprehensive overview provides a detailed look at TechCorp Solutions Inc., showcasing its growth trajectory, technological capabilities, and market position in the competitive AI landscape.
`.repeat(3); // 重复3次以创建更长的文本


// 测试用的JSON Schema
const companySchema: JSONSchema7 = {
    type: 'object',
    properties: {
        company: {
            type: 'string',
            description: 'Company name'
        },
        founded: {
            type: 'string',
            description: 'Year founded'
        },
        industry: {
            type: 'string',
            description: 'Industry sector'
        },
        headquarters: {
            type: 'string',
            description: 'Headquarters location'
        },
        employees: {
            type: 'number',
            description: 'Number of employees'
        },
        contact: {
            type: 'object',
            properties: {
                email: { type: 'string' },
                phone: { type: 'string' },
                website: { type: 'string' }
            }
        },
        services: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of services offered'
        },
        funding: {
            type: 'object',
            properties: {
                amount: { type: 'string' },
                round: { type: 'string' },
                year: { type: 'string' }
            }
        }
    },
    required: ['company']
};

const simpleSchema: JSONSchema7 = {
    type: "object",
    properties: {
        companyName: {
            type: "string",
            description: "Company name"
        },
        founded: {
            type: "string",
            description: "Year founded"
        },
        industry: {
            type: "array",
            items: { type: "string" },
            description: "Industry sector"
        }
    },
    required: ["companyName", "founded", "industry"]
};

describe('LLMExtract', () => {
    let extractor: LLMExtract;

    let defaultLLMModel: string;

    beforeEach(async () => {
        log.setLevel(log.LEVELS.INFO);
        await ensureAIConfigLoaded();
        const aiConfig = getAIConfig();
        defaultLLMModel = getExtractModelId();
        extractor = new LLMExtract(defaultLLMModel);
    });

    describe('Constructor and Initialization', () => {
        test('should initialize with default model', () => {
            expect(extractor).toBeInstanceOf(LLMExtract);
        });

        test('should initialize with cost limit', () => {
            const limitedExtractor = new LLMExtract(defaultLLMModel, undefined, 0.01);
            expect(limitedExtractor).toBeInstanceOf(LLMExtract);
        });
    });

    describe('Chunking Analysis', () => {
        test('should analyze chunking for short text', () => {
            const analysis = extractor.analyzeChunking(testMarkdown);

            expect(analysis.chunks).toBeDefined();
            expect(analysis.stats).toBeDefined();
            expect(analysis.chunks.length).toBeGreaterThan(0);
            expect(analysis.stats.totalChunks).toBeGreaterThan(0);
            expect(analysis.stats.totalTokens).toBeGreaterThan(0);
            expect(analysis.stats.averageTokensPerChunk).toBeGreaterThan(0);
            expect(analysis.stats.minTokens).toBeGreaterThan(0);
            expect(analysis.stats.maxTokens).toBeGreaterThan(0);
        });

        test('should respect custom chunk parameters and chunking for long text', () => {
            const analysis = extractor.analyzeChunking(longTestMarkdown, {
                maxTokensInput: 1000,
                chunkOverlap: 200
            });

            expect(analysis.chunks).toBeDefined();
            expect(analysis.stats).toBeDefined();

            expect(analysis.chunks.length).toBeGreaterThan(1);
        });
    });

    describe('Simple Extraction Tests', () => {
        test('should extract basic company information', async () => {
            const result = await extractor.perform(testMarkdown, simpleSchema);

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
            expect(result.tokens).toBeDefined();
            expect(result.chunks).toBeDefined();
            expect(result.cost).toBeDefined();

            expect(result.data.companyName).toBeDefined();
            expect(typeof result.data.companyName).toBe('string');
            expect(result.data.industry).toBeDefined();
        }, 60000);

        test('should handle empty text', async () => {
            const result = await extractor.perform('', simpleSchema);

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();

            expect(result.data.companyName === null).toBe(true);
            expect(result.data.industry === null).toBe(true);
        }, 30000);

    });

    describe('Complex Extraction Tests', () => {
        test('should extract comprehensive company information', async () => {
            const result = await extractor.perform(testMarkdown, companySchema);

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
            expect(result.data.company).toBeDefined();

            expect(typeof result.data.company).toBe('string');
            if (result.data.contact) {
                expect(typeof result.data.contact).toBe('object');
            }
            if (result.data.services) {
                expect(Array.isArray(result.data.services)).toBe(true);
            }
        }, 30000);

        test('should handle long text with chunking', async () => {
            const result = await extractor.perform(longTestMarkdown, companySchema);

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
            expect(result.chunks).toBeGreaterThan(0);

            expect(result.data.company).toBeDefined();
            expect(typeof result.data.company).toBe('string');
            expect(result.data.contact).toBeDefined();
            expect(result.data.services).toBeDefined();
            expect(typeof result.data.contact).toBe('object');
            expect(Array.isArray(result.data.services)).toBe(true);

            // check funding.amount exists
            expect(result.data.funding.amount).toBeDefined();
            expect(typeof result.data.funding.amount).toBe('string');

            // check funding.round exists
            expect(result.data.funding.round).toBeDefined();
            expect(typeof result.data.funding.round).toBe('string');

            // check funding.year exists
            expect(result.data.funding.year).toBeDefined();
            expect(typeof result.data.funding.year).toBe('string');

            // check employees exists
            expect(result.data.employees).toBeDefined();
            expect(typeof result.data.employees).toBe('number');
        }, 60000);
    });

    describe('Custom Options Tests', () => {
        test('should use custom prompt', async () => {
            const customPrompt = 'Extract only the company name and founding year from this text.';
            const result = await extractor.perform(testMarkdown, simpleSchema, {
                prompt: customPrompt
            });
            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
            expect(result.data.industry === undefined || result.data.industry === null).toBe(true);
        }, 30000);

        test('should use custom system prompt', async () => {
            const customSystemPrompt = 'You are a specialized data extraction assistant. Focus on accuracy and completeness.';
            const result = await extractor.perform(testMarkdown, simpleSchema, {
                systemPrompt: customSystemPrompt
            });

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
            expect(result.data.industry).toBeDefined();
            expect(result.data.industry !== null).toBe(true);
        }, 30000);

        test('should respect token limits', async () => {
            const result = await extractor.perform(longTestMarkdown, simpleSchema, {
                maxTokensInput: 2000
            });

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();

            expect(result.chunks).toBe(2);
        }, 30000);
    });

    describe('Array Input Tests', () => {
        test('should handle array of texts', async () => {
            const textArray = [
                'Company: TechCorp, Founded: 2015',
                'Industry: Software Development',
                'Location: San Francisco, CA'
            ];

            const result = await extractor.perform(textArray, simpleSchema);

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
            expect(result.data.companyName).toBeDefined();
            expect(result.data.industry).toBeDefined();
            expect(result.data.founded).toBeDefined();

        }, 30000);
    });

    describe('Error Handling Tests', () => {
        test('should handle invalid schema gracefully', async () => {
            const invalidSchema = {
                type: 'invalid_type'
            } as any;

            const result = await extractor.perform(testMarkdown, invalidSchema);

            expect(result).toBeDefined();
        }, 30000);

        test('should handle invalid model id', async () => {
            expect.assertions(2);
            try {
                const invalidExtractor = new LLMExtract('invalid-model-id');
                await invalidExtractor.perform(testMarkdown, simpleSchema);
            } catch (error) {
                expect(error).toBeDefined();
                expect(
                    error instanceof Error && error.message.includes('Model invalid-model-id is not found')
                ).toBe(true);
            }
        }, 30000);
    });


    describe('Cost Tracking Tests', () => {
        test('should track costs accurately', async () => {
            const result = await extractor.perform(testMarkdown, companySchema);

            expect(result.cost).toBeDefined();
            expect(result.cost).toBeGreaterThan(0);
            expect(result.tokens.total).toBeGreaterThan(0);

            expect(result.cost?.toFixed(6)).toBeDefined();
            expect(Number(result.cost?.toFixed(6))).toBeGreaterThan(0);
            expect(result.tokens.total).toBeGreaterThan(0);
            expect(result.tokens.input).toBeGreaterThan(0);
            expect(result.tokens.output).toBeGreaterThan(0);
            expect(result.chunks).toBeGreaterThan(0);
            expect(result.data).toBeDefined();
            expect(result.data.company).toBeDefined();
        }, 30000);

        test('should respect cost limits', async () => {
            const lowCostExtractor = new LLMExtract(defaultLLMModel, undefined, 0.001); // 很低的成本限制

            try {
                const result = await lowCostExtractor.perform(longTestMarkdown, companySchema);
            } catch (error) {
                expect(error).toBeDefined();
                expect(error instanceof Error).toBe(true);
                expect((error as Error).message.includes('Cost limit exceeded')).toBe(true);
            }
        }, 60000);
    });
});
