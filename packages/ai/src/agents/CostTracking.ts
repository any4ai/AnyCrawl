import { log } from "@anycrawl/libs";

// Cost tracking class similar to Firecrawl
class CostTracking {
    calls: {
        type: "extract" | "batch" | "merge" | "summary";
        metadata: Record<string, any>;
        cost: number;
        model: string;
        tokens?: {
            input: number;
            output: number;
        };
        timestamp: number;
    }[] = [];

    limit: number | null = null;

    constructor(limit: number | null = null) {
        this.limit = limit;
    }

    public addCall(call: {
        type: "extract" | "batch" | "merge" | "summary";
        metadata: Record<string, any>;
        cost: number;
        model: string;
        tokens?: {
            input: number;
            output: number;
        };
    }) {
        this.calls.push({
            ...call,
            timestamp: Date.now(),
        });

        if (this.limit !== null && this.getTotalCost() > this.limit) {
            throw new Error("Cost limit exceeded");
        }
    }

    public getTotalCost(): number {
        return this.calls.reduce((acc, call) => acc + (call.cost || 0), 0);
    }

    public getTotalTokens(): { input: number; output: number; total: number } {
        const input = this.calls.reduce((acc, call) => acc + (call.tokens?.input || 0), 0);
        const output = this.calls.reduce((acc, call) => acc + (call.tokens?.output || 0), 0);
        return { input, output, total: input + output };
    }

    public getCallsByType(): Record<string, number> {
        const counts: Record<string, number> = {};
        this.calls.forEach(call => {
            counts[call.type] = (counts[call.type] || 0) + 1;
        });
        return counts;
    }

    public getCostByType(): Record<string, number> {
        const costs: Record<string, number> = {};
        this.calls.forEach(call => {
            costs[call.type] = (costs[call.type] || 0) + call.cost;
        });
        return costs;
    }

    public getTokensByType(): Record<string, { input: number; output: number; total: number }> {
        const tokens: Record<string, { input: number; output: number; total: number }> = {};
        this.calls.forEach(call => {
            if (!tokens[call.type]) {
                tokens[call.type] = { input: 0, output: 0, total: 0 };
            }
            const typeTokens = tokens[call.type];
            if (typeTokens) {
                typeTokens.input += call.tokens?.input || 0;
                typeTokens.output += call.tokens?.output || 0;
                typeTokens.total += (call.tokens?.input || 0) + (call.tokens?.output || 0);
            }
        });
        return tokens;
    }

    public formatSummary(): string {
        const totalTokens = this.getTotalTokens();
        const totalCost = this.getTotalCost();
        const callsByType = this.getCallsByType();
        const costsByType = this.getCostByType();

        let summary = "📊 Cost Tracking Summary\n";
        summary += "=".repeat(30) + "\n";
        summary += `💰 Total Cost: $${totalCost.toFixed(6)}\n`;
        summary += `🎯 Total Tokens: ${totalTokens.total} (Input: ${totalTokens.input}, Output: ${totalTokens.output})\n`;
        summary += `📞 Total Calls: ${this.calls.length}\n\n`;

        if (Object.keys(callsByType).length > 0) {
            summary += "📈 Stats by Type:\n";
            Object.entries(callsByType).forEach(([type, count]) => {
                const cost = costsByType[type] || 0;
                summary += `   ${type}: ${count} calls, $${cost.toFixed(6)}\n`;
            });
        }

        if (this.limit !== null) {
            const percentage = (totalCost / this.limit) * 100;
            summary += `\n⚠️  Cost Limit: $${this.limit} (Used ${percentage.toFixed(1)}%)\n`;
        }

        return summary;
    }

    public printSummary(): void {
        log.info(this.formatSummary());
    }

    public toJSON() {
        return {
            calls: this.calls,
            totalCost: this.getTotalCost(),
            totalTokens: this.getTotalTokens(),
            callCount: this.calls.length,
            callsByType: this.getCallsByType(),
            costsByType: this.getCostByType(),
            tokensByType: this.getTokensByType(),
            limit: this.limit,
            summary: this.formatSummary()
        };
    }
}

export { CostTracking };