import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const createDeferred = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

describe("EngineQueueManager", () => {
    let manager: any;

    beforeEach(async () => {
        jest.resetModules();
        const { EngineQueueManager } = await import("../../managers/EngineQueue.js");
        manager = EngineQueueManager.getInstance();
        manager.engines = new Map();
        manager.engineRuns = new Map();
    });

    it("does not start the same engine twice while it is running", async () => {
        const runState = createDeferred();
        const engine = {
            init: jest.fn(async () => undefined),
            run: jest.fn(() => runState.promise),
            stop: jest.fn(async () => undefined),
        };
        manager.engines.set("playwright", engine);
        await manager.startEngines();
        await manager.startEngines();

        expect(engine.run).toHaveBeenCalledTimes(1);

        runState.resolve();
        await runState.promise;
        await Promise.resolve();
        await Promise.resolve();
    });

    it("allows an engine to be started again after its run promise settles", async () => {
        const firstRun = createDeferred();
        const secondRun = createDeferred();
        const engine = {
            init: jest.fn(async () => undefined),
            run: jest.fn()
                .mockImplementationOnce(() => firstRun.promise)
                .mockImplementationOnce(() => secondRun.promise),
            stop: jest.fn(async () => undefined),
        };
        manager.engines.set("playwright", engine);
        await manager.startEngines();
        firstRun.resolve();
        await firstRun.promise;
        await Promise.resolve();
        await Promise.resolve();
        await manager.startEngines();

        expect(engine.run).toHaveBeenCalledTimes(2);

        secondRun.resolve();
        await secondRun.promise;
        await Promise.resolve();
        await Promise.resolve();
    });
});
