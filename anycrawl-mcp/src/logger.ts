export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

export class Logger {
    private level: LogLevel;

    constructor(level?: LogLevel) {
        if (level !== undefined) {
            this.level = level;
        } else {
            const env = process.env.LOG_LEVEL;
            this.level = env === 'debug' ? LogLevel.DEBUG :
                env === 'warn' ? LogLevel.WARN :
                    env === 'error' ? LogLevel.ERROR :
                        LogLevel.INFO;
        }
    }

    private shouldLog(level: LogLevel): boolean {
        return level >= this.level;
    }

    private formatMessage(level: string, message: string, ...args: any[]): string {
        const timestamp = new Date().toISOString();
        const seen = new WeakSet<object>();
        const safeStringify = (value: unknown): string => {
            if (value === null || value === undefined) return String(value);
            if (typeof value !== 'object') return String(value);
            try {
                return JSON.stringify(value, (key, val) => {
                    if (typeof val === 'object' && val !== null) {
                        if (seen.has(val)) return '[Circular]';
                        seen.add(val);
                    }
                    return val;
                });
            } catch {
                return '[Unserializable]';
            }
        };
        const formattedArgs = args.length > 0 ? ' ' + args.map(safeStringify).join(' ') : '';
        return `[${timestamp}] [${level}] ${message}${formattedArgs}`;
    }

    debug(message: string, ...args: any[]): void {
        if (this.shouldLog(LogLevel.DEBUG)) {
            console.error(this.formatMessage('DEBUG', message, ...args));
        }
    }

    info(message: string, ...args: any[]): void {
        if (this.shouldLog(LogLevel.INFO)) {
            console.error(this.formatMessage('INFO', message, ...args));
        }
    }

    warn(message: string, ...args: any[]): void {
        if (this.shouldLog(LogLevel.WARN)) {
            console.error(this.formatMessage('WARN', message, ...args));
        }
    }

    error(message: string, ...args: any[]): void {
        if (this.shouldLog(LogLevel.ERROR)) {
            console.error(this.formatMessage('ERROR', message, ...args));
        }
    }
}

export const logger = new Logger(
    process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG :
        process.env.LOG_LEVEL === 'warn' ? LogLevel.WARN :
            process.env.LOG_LEVEL === 'error' ? LogLevel.ERROR :
                LogLevel.INFO
);
