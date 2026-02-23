export interface BillingChargeItem {
    code: string;
    credits: number;
    meta?: Record<string, unknown>;
}

export interface BillingChargeDetailsV1 {
    version: 1;
    basis: "charged_delta";
    calculator: string;
    total: number;
    items: BillingChargeItem[];
}

