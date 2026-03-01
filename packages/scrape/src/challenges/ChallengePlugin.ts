export interface ChallengePlugin {
    readonly name: string;
    onPreNavigation?(args: any): Promise<void>;
    onPostNavigation?(args: any): Promise<void>;
    enrichPayload?(context: any, payload: any): Promise<any>;
}
