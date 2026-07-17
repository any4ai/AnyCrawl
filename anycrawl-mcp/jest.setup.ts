// Jest setup file
// Add any global test setup here

// Mock console methods to avoid noise in tests
const originalConsole = global.console;

beforeAll(() => {
    global.console = {
        ...originalConsole,
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    };
});

afterAll(() => {
    global.console = originalConsole;
});
