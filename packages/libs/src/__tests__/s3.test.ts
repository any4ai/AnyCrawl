import { describe, expect, it, jest, beforeEach, afterEach, beforeAll } from "@jest/globals";
import { Readable } from "stream";

// Mock functions with proper types
const mockSend = jest.fn<() => Promise<any>>();
const mockGetSignedUrl = jest.fn<() => Promise<string>>();

// Mock AWS SDK modules
jest.mock("@aws-sdk/client-s3", () => ({
    S3Client: jest.fn().mockImplementation(() => ({
        send: mockSend,
    })),
    PutObjectCommand: jest.fn().mockImplementation((params) => params),
    GetObjectCommand: jest.fn().mockImplementation((params) => params),
}));

jest.mock("@aws-sdk/s3-request-presigner", () => ({
    getSignedUrl: mockGetSignedUrl,
}));

// Mock log module
jest.mock("../log.js", () => ({
    log: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    },
}));

describe("S3", () => {
    let s3: any;

    beforeAll(() => {
        // Set up environment variables before importing the module
        process.env.ANYCRAWL_STORAGE = "s3";
        process.env.ANYCRAWL_S3_REGION = "us-east-1";
        process.env.ANYCRAWL_S3_ENDPOINT = "https://s3.amazonaws.com";
        process.env.ANYCRAWL_S3_ACCESS_KEY = "test-access-key";
        process.env.ANYCRAWL_S3_SECRET_ACCESS_KEY = "test-secret-key";
        process.env.ANYCRAWL_S3_BUCKET = "test-bucket";
    });

    beforeEach(async () => {
        // Clear all mocks
        jest.clearAllMocks();

        // Import s3 module
        const s3Module = await import("../s3.js");
        s3 = s3Module.s3;
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    afterAll(() => {
        // Clean up environment variables
        delete process.env.ANYCRAWL_STORAGE;
        delete process.env.ANYCRAWL_S3_REGION;
        delete process.env.ANYCRAWL_S3_ENDPOINT;
        delete process.env.ANYCRAWL_S3_ACCESS_KEY;
        delete process.env.ANYCRAWL_S3_SECRET_ACCESS_KEY;
        delete process.env.ANYCRAWL_S3_BUCKET;
    });

    describe("upload", () => {
        it("should upload a string to S3", async () => {
            const mockResult = { ETag: '"123456"', VersionId: "v1" };
            mockSend.mockResolvedValue(mockResult);

            const result = await s3.upload("test-key.txt", "Hello, World!");

            expect(mockSend).toHaveBeenCalledWith({
                Bucket: "test-bucket",
                Key: "test-key.txt",
                Body: "Hello, World!",
            });
            expect(result).toEqual(mockResult);
        });

        it("should upload a Buffer to S3", async () => {
            const mockResult = { ETag: '"789012"', VersionId: "v2" };
            mockSend.mockResolvedValue(mockResult);

            const buffer = Buffer.from("Binary data");
            const result = await s3.upload("test-key.bin", buffer);

            expect(mockSend).toHaveBeenCalledWith({
                Bucket: "test-bucket",
                Key: "test-key.bin",
                Body: buffer,
            });
            expect(result).toEqual(mockResult);
        });

        it("should upload a Readable stream to S3", async () => {
            const mockResult = { ETag: '"345678"', VersionId: "v3" };
            mockSend.mockResolvedValue(mockResult);

            const stream = Readable.from(["Stream ", "data"]);
            const result = await s3.upload("test-key.stream", stream);

            expect(mockSend).toHaveBeenCalledWith({
                Bucket: "test-bucket",
                Key: "test-key.stream",
                Body: stream,
            });
            expect(result).toEqual(mockResult);
        });

        it("should handle upload errors", async () => {
            const mockError = new Error("Upload failed");
            mockSend.mockRejectedValue(mockError);

            await expect(s3.upload("test-key.txt", "data")).rejects.toThrow("Upload failed");
        });
    });

    describe("getTemporaryUrl", () => {
        it("should generate a presigned URL with default expiration", async () => {
            const mockUrl = "https://test-bucket.s3.amazonaws.com/test-key.txt?signature=abc123";
            mockGetSignedUrl.mockResolvedValue(mockUrl);

            const url = await s3.getTemporaryUrl("test-key.txt");

            expect(mockGetSignedUrl).toHaveBeenCalledWith(
                expect.any(Object), // S3Client instance
                {
                    Bucket: "test-bucket",
                    Key: "test-key.txt",
                },
                { expiresIn: 3600 }
            );
            expect(url).toBe(mockUrl);
        });

        it("should generate a presigned URL with custom expiration", async () => {
            const mockUrl = "https://test-bucket.s3.amazonaws.com/test-key.txt?signature=xyz789";
            mockGetSignedUrl.mockResolvedValue(mockUrl);

            const url = await s3.getTemporaryUrl("test-key.txt", 7200);

            expect(mockGetSignedUrl).toHaveBeenCalledWith(
                expect.any(Object), // S3Client instance
                {
                    Bucket: "test-bucket",
                    Key: "test-key.txt",
                },
                { expiresIn: 7200 }
            );
            expect(url).toBe(mockUrl);
        });

        it("should handle presigned URL generation errors", async () => {
            const mockError = new Error("Failed to generate presigned URL");
            mockGetSignedUrl.mockRejectedValue(mockError);

            await expect(s3.getTemporaryUrl("test-key.txt")).rejects.toThrow("Failed to generate presigned URL");
        });
    });

    describe("edge cases", () => {
        it("should handle empty string upload", async () => {
            const mockResult = { ETag: '"empty"' };
            mockSend.mockResolvedValue(mockResult);

            const result = await s3.upload("empty.txt", "");

            expect(mockSend).toHaveBeenCalledWith({
                Bucket: "test-bucket",
                Key: "empty.txt",
                Body: "",
            });
            expect(result).toEqual(mockResult);
        });

        it("should handle keys with special characters", async () => {
            const mockResult = { ETag: '"special"' };
            mockSend.mockResolvedValue(mockResult);

            const specialKey = "folder/sub-folder/file name with spaces.txt";
            await s3.upload(specialKey, "data");

            expect(mockSend).toHaveBeenCalledWith({
                Bucket: "test-bucket",
                Key: specialKey,
                Body: "data",
            });
        });

        it("should handle very short expiration times", async () => {
            const mockUrl = "https://test-bucket.s3.amazonaws.com/test.txt?signature=short";
            mockGetSignedUrl.mockResolvedValue(mockUrl);

            const url = await s3.getTemporaryUrl("test.txt", 60); // 1 minute

            expect(mockGetSignedUrl).toHaveBeenCalledWith(
                expect.any(Object),
                {
                    Bucket: "test-bucket",
                    Key: "test.txt",
                },
                { expiresIn: 60 }
            );
            expect(url).toBe(mockUrl);
        });
    });
});