import { jest } from '@jest/globals';

describe('EngineFactory Tests', () => {
    let EngineFactoryRegistry: any;
    let CheerioEngineFactory: any;
    let PlaywrightEngineFactory: any;
    let PuppeteerEngineFactory: any;

    beforeEach(async () => {
        jest.resetModules();
        jest.clearAllMocks();
        
        // Import the module
        const factoryModule = await import('../../engines/EngineFactory.js');
        EngineFactoryRegistry = factoryModule.EngineFactoryRegistry;
        CheerioEngineFactory = factoryModule.CheerioEngineFactory;
        PlaywrightEngineFactory = factoryModule.PlaywrightEngineFactory;
        PuppeteerEngineFactory = factoryModule.PuppeteerEngineFactory;
    });

    describe('EngineFactoryRegistry', () => {
        test('should have pre-registered engine types', () => {
            const types = EngineFactoryRegistry.getRegisteredEngineTypes();
            expect(types).toContain('cheerio');
            expect(types).toContain('playwright');
            expect(types).toContain('puppeteer');
            expect(types.length).toBeGreaterThanOrEqual(3);
        });

        test('should allow registering new engine factories', () => {
            const mockFactory = {
                createEngine: jest.fn().mockImplementation(() => Promise.resolve({} as any))
            };

            EngineFactoryRegistry.register('test-engine', mockFactory);
            const types = EngineFactoryRegistry.getRegisteredEngineTypes();
            expect(types).toContain('test-engine');
        });

        test('should throw error for unknown engine type', async () => {
            const mockQueue = {} as any;
            
            await expect(
                EngineFactoryRegistry.createEngine('unknown-engine', mockQueue)
            ).rejects.toThrow('No factory registered for engine type: unknown-engine');
        });
    });

    describe('Individual Factory Classes', () => {
        test('CheerioEngineFactory should implement IEngineFactory', () => {
            const factory = new CheerioEngineFactory();
            expect(typeof factory.createEngine).toBe('function');
            expect(factory.createEngine.length).toBe(2); // queue and options parameters
        });

        test('PlaywrightEngineFactory should implement IEngineFactory', () => {
            const factory = new PlaywrightEngineFactory();
            expect(typeof factory.createEngine).toBe('function');
            expect(factory.createEngine.length).toBe(2);
        });

        test('PuppeteerEngineFactory should implement IEngineFactory', () => {
            const factory = new PuppeteerEngineFactory();
            expect(typeof factory.createEngine).toBe('function');
            expect(factory.createEngine.length).toBe(2);
        });
    });

    describe('Factory Configuration', () => {
        test('should handle environment variables', () => {
            // Test that factories can be instantiated without throwing
            expect(() => new CheerioEngineFactory()).not.toThrow();
            expect(() => new PlaywrightEngineFactory()).not.toThrow();
            expect(() => new PuppeteerEngineFactory()).not.toThrow();
        });

        test('should have expected exports', async () => {
            // Verify that the module loads and has expected exports
            const factoryModule = await import('../../engines/EngineFactory.js');
            
            expect(factoryModule.CheerioEngineFactory).toBeDefined();
            expect(factoryModule.PlaywrightEngineFactory).toBeDefined();
            expect(factoryModule.PuppeteerEngineFactory).toBeDefined();
            expect(factoryModule.EngineFactoryRegistry).toBeDefined();
            expect(factoryModule.buildEngineOptions).toBeDefined();
        });

        test('should preserve explicit autoscaled and browser pool options', async () => {
            const factoryModule = await import('../../engines/EngineFactory.js');
            const passedOptions = factoryModule.buildEngineOptions({
                baseOptions: {
                    keepAlive: true,
                    useSessionPool: true,
                },
                performanceOptions: {
                    minConcurrency: 2,
                    maxConcurrency: 10,
                    autoscaledPoolOptions: {
                        desiredConcurrency: 5,
                        scaleUpStepRatio: 0.5,
                    },
                    browserPoolOptions: {
                        useFingerprints: true,
                    },
                },
                engineSpecificOptions: {
                    browserPoolOptions: {
                        maxOpenPagesPerBrowser: 3,
                    },
                },
                options: {
                    maxConcurrency: 99,
                    autoscaledPoolOptions: {
                        desiredConcurrency: 42,
                        scaleUpStepRatio: 0.9,
                    },
                    browserPoolOptions: {
                        useFingerprints: false,
                        maxOpenPagesPerBrowser: 7,
                    },
                } as any,
                proxyConfiguration: {} as any,
                requestQueue: {} as any,
            });

            expect(passedOptions.maxConcurrency).toBe(99);
            expect(passedOptions.autoscaledPoolOptions).toMatchObject({
                desiredConcurrency: 42,
                scaleUpStepRatio: 0.9,
            });
            expect(passedOptions.browserPoolOptions).toMatchObject({
                useFingerprints: false,
                maxOpenPagesPerBrowser: 7,
            });
        });

        test('should inject CloakBrowser launcher into playwright and puppeteer factories', async () => {
            jest.resetModules();

            const playwrightLauncher = jest.fn();
            const puppeteerLauncher = jest.fn();
            jest.unstable_mockModule('cloakbrowser', () => ({
                ensureBinary: jest.fn(async () => undefined),
                launch: playwrightLauncher,
                launchPersistentContext: jest.fn(async () => undefined),
            }));
            jest.unstable_mockModule('cloakbrowser/puppeteer', () => ({
                ensureBinary: jest.fn(async () => undefined),
                launch: puppeteerLauncher,
            }));

            const factoryModule = await import('../../engines/EngineFactory.js');
            const playwrightOptions = await (new factoryModule.PlaywrightEngineFactory() as any).getEngineSpecificOptions();
            const puppeteerOptions = await (new factoryModule.PuppeteerEngineFactory() as any).getEngineSpecificOptions();

            expect(playwrightOptions.launchContext.launcher.launch).toBe(playwrightLauncher);
            expect(playwrightOptions.launchContext.launcher.name()).toBe('chromium');
            expect(typeof playwrightOptions.launchContext.launcher.launchPersistentContext).toBe('function');
            expect(playwrightOptions.launchContext.launcher.__anycrawlBrowserRuntime).toBe('cloakbrowser');
            expect(playwrightOptions.launchContext.useIncognitoPages).toBe(true);
            expect(puppeteerOptions.launchContext.launcher.launch).toBe(puppeteerLauncher);
            expect(puppeteerOptions.launchContext.launcher.__anycrawlBrowserRuntime).toBe('cloakbrowser');
            expect(puppeteerOptions.launchContext.useIncognitoPages).toBe(true);
        });

        test('should preserve the CloakBrowser launcher when custom launchContext is supplied', async () => {
            jest.resetModules();

            const playwrightLauncher = jest.fn();
            const customLauncher = { launch: jest.fn() };
            jest.unstable_mockModule('cloakbrowser', () => ({
                ensureBinary: jest.fn(async () => undefined),
                launch: playwrightLauncher,
                launchPersistentContext: jest.fn(async () => undefined),
            }));

            const factoryModule = await import('../../engines/EngineFactory.js');
            const playwrightOptions = await (new factoryModule.PlaywrightEngineFactory() as any).getEngineSpecificOptions();
            const mergedLaunchContext = factoryModule.mergeLaunchContexts(
                playwrightOptions.launchContext,
                {
                    launcher: customLauncher,
                    launchOptions: {
                        defaultViewport: {
                            width: 800,
                            height: 600,
                        },
                        args: ['--custom-arg'],
                    },
                },
            ) as any;

            expect(mergedLaunchContext.launcher.launch).toBe(playwrightLauncher);
            expect(mergedLaunchContext.launcher).not.toBe(customLauncher);
            expect(mergedLaunchContext.launchOptions.defaultViewport).toEqual({
                width: 800,
                height: 600,
            });
            expect(mergedLaunchContext.launchOptions.args).toContain('--custom-arg');
        });
    });

    describe('Engine Type Management', () => {
        test('should maintain consistent engine type list', () => {
            const types1 = EngineFactoryRegistry.getRegisteredEngineTypes();
            const types2 = EngineFactoryRegistry.getRegisteredEngineTypes();
            
            expect(types1).toEqual(types2);
            expect(types1.length).toBe(types2.length);
        });

        test('should handle duplicate registrations', () => {
            const mockFactory1 = { createEngine: jest.fn() };
            const mockFactory2 = { createEngine: jest.fn() };
            
            EngineFactoryRegistry.register('duplicate-test', mockFactory1);
            const typesBefore = EngineFactoryRegistry.getRegisteredEngineTypes();
            
            EngineFactoryRegistry.register('duplicate-test', mockFactory2);
            const typesAfter = EngineFactoryRegistry.getRegisteredEngineTypes();
            
            expect(typesBefore.length).toBe(typesAfter.length);
            expect(typesAfter).toContain('duplicate-test');
        });
    });

    describe('Error Handling', () => {
        test('should handle factory creation errors gracefully', () => {
            expect(() => new CheerioEngineFactory()).not.toThrow();
            expect(() => new PlaywrightEngineFactory()).not.toThrow();
            expect(() => new PuppeteerEngineFactory()).not.toThrow();
        });

        test('should validate engine type parameter', async () => {
            const mockQueue = {} as any;
            
            await expect(
                EngineFactoryRegistry.createEngine('', mockQueue)
            ).rejects.toThrow();
            
            await expect(
                EngineFactoryRegistry.createEngine(null as any, mockQueue)
            ).rejects.toThrow();
        });
    });
});
