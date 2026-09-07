import baseConfig from "../../jest.config.base.mjs";

export default {
    ...baseConfig,
    testMatch: ["<rootDir>/tests/browser-score/__tests__/**/*.test.ts"],
};
