export default {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    extensionsToTreatAsEsm: ['.ts'],
    setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            useESM: true,
        }],
    },
    moduleNameMapper: {
        '^@anycrawl/js-sdk$': '<rootDir>/src/__tests__/mocks/anycrawl-js-sdk.ts',
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    testMatch: ['**/__tests__/**/*.test.ts'],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/**/*.test.ts',
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],
};
