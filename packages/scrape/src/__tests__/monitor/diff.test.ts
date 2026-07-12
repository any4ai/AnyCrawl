import { textDiff, priceDiff, classifyPriceChange } from "../../monitor/diff.js";

describe("monitor/diff", () => {
    describe("textDiff", () => {
        test("identical content reports no change", () => {
            const r = textDiff("line a\nline b", "line a\nline b");
            expect(r.changed).toBe(false);
            expect(r.ratio).toBe(0);
            expect(r.diffText).toBe("");
        });

        test("changed content reports a diff with ratio > 0", () => {
            const r = textDiff("price: $19\nplan: pro", "price: $24\nplan: pro");
            expect(r.changed).toBe(true);
            expect(r.ratio).toBeGreaterThan(0);
            expect(r.diffText).toContain("-price: $19");
            expect(r.diffText).toContain("+price: $24");
        });

        test("added lines appear as additions", () => {
            const r = textDiff("a\nb", "a\nb\nc");
            expect(r.changed).toBe(true);
            expect(r.diffText).toContain("+c");
        });
    });

    describe("priceDiff", () => {
        test("no diff for identical objects", () => {
            const diffs = priceDiff({ price: 19, currency: "USD" }, { price: 19, currency: "USD" });
            expect(diffs).toHaveLength(0);
        });

        test("numeric change carries delta", () => {
            const diffs = priceDiff({ price: 19 }, { price: 24 });
            expect(diffs).toHaveLength(1);
            expect(diffs[0]).toMatchObject({ path: "price", from: 19, to: 24, delta: 5 });
        });

        test("nested array path extraction", () => {
            const prev = { plans: [{ name: "pro", price: 19 }] };
            const next = { plans: [{ name: "pro", price: 24 }] };
            const diffs = priceDiff(prev, next);
            expect(diffs).toHaveLength(1);
            expect(diffs[0]!.path).toBe("plans[0].price");
            expect(diffs[0]!.delta).toBe(5);
        });

        test("added array element", () => {
            const prev = { plans: [{ name: "pro" }] };
            const next = { plans: [{ name: "pro" }, { name: "enterprise" }] };
            const diffs = priceDiff(prev, next);
            expect(diffs.some((d) => d.path.startsWith("plans[1]"))).toBe(true);
        });
    });

    describe("classifyPriceChange", () => {
        test("classifies a price increase as price_up", () => {
            const diffs = [{ path: "plans[0].price", from: 19, to: 24, delta: 5 }];
            expect(classifyPriceChange(diffs)).toBe("price_up");
        });

        test("classifies a price decrease as price_down", () => {
            const diffs = [{ path: "price", from: 24, to: 19, delta: -5 }];
            expect(classifyPriceChange(diffs)).toBe("price_down");
        });

        test("respects price_change_pct threshold", () => {
            // 19 -> 19.10 is ~0.5% change, below a 1% threshold
            const diffs = [{ path: "price", from: 19, to: 19.1, delta: 0.1 }];
            expect(classifyPriceChange(diffs, { price_change_pct: 1 })).toBe("content");
        });

        test("stock field change classified as stock", () => {
            const diffs = [{ path: "in_stock", from: true, to: false }];
            expect(classifyPriceChange(diffs)).toBe("stock");
        });

        test("no diffs returns null", () => {
            expect(classifyPriceChange([])).toBeNull();
        });
    });
});
