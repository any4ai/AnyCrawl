import { ConfigurableEngineType, EngineConfigurator } from "../../core/EngineConfigurator.js";

describe("EngineConfigurator", () => {
    test("preserves explicit browser pool options while filling defaults", () => {
        const configured = EngineConfigurator.configure({
            browserPoolOptions: {
                useFingerprints: false,
                maxOpenPagesPerBrowser: 7,
                fingerprintOptions: {
                    fingerprintGeneratorOptions: {
                        browsers: [{ name: "firefox", minVersion: 110 }],
                    },
                },
            },
        }, ConfigurableEngineType.PLAYWRIGHT);

        expect(configured.browserPoolOptions.useFingerprints).toBe(false);
        expect(configured.browserPoolOptions.maxOpenPagesPerBrowser).toBe(7);
        expect(configured.browserPoolOptions.fingerprintOptions.fingerprintGeneratorOptions.browsers).toEqual([
            { name: "firefox", minVersion: 110 },
        ]);
    });

    test("keeps crawlers alive when autoscaledPoolOptions already exists", () => {
        const configured = EngineConfigurator.configure({
            autoscaledPoolOptions: {
                desiredConcurrency: 5,
            },
        }, ConfigurableEngineType.PLAYWRIGHT);

        expect(configured.autoscaledPoolOptions.desiredConcurrency).toBe(5);
        expect(typeof configured.autoscaledPoolOptions.isFinishedFunction).toBe("function");
    });
});
