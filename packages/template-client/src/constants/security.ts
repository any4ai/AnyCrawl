/**
 * Security patterns for code validation and sandbox execution
 */

/**
 * Dangerous patterns to block in template code
 * Used by both Validator (pre-execution) and Sandbox (runtime)
 */
export const DANGEROUS_PATTERNS = [
    // Module & Process Access
    { pattern: /require\s*\(/gi, message: "require() is not allowed" },
    { pattern: /import\s+/gi, message: "import statements are not allowed" },
    { pattern: /process\./gi, message: "process object is not allowed" },
    { pattern: /child_process/gi, message: "child_process module is not allowed" },
    { pattern: /fs\./gi, message: "fs module is not allowed" },
    { pattern: /__dirname/gi, message: "__dirname is not allowed" },
    { pattern: /__filename/gi, message: "__filename is not allowed" },

    // Global Object Access
    { pattern: /global\./gi, message: "global object is not allowed" },
    { pattern: /globalThis\./gi, message: "globalThis is not allowed" },

    // Dynamic Code Execution
    { pattern: /\bFunction\s*\(/g, message: "Function constructor is not allowed" },
    { pattern: /eval\s*\(/gi, message: "eval() is not allowed" },
    { pattern: /new\s+Function/gi, message: "new Function is not allowed" },
    { pattern: /AsyncFunction/gi, message: "AsyncFunction constructor is not allowed" },
    { pattern: /GeneratorFunction/gi, message: "GeneratorFunction is not allowed" },

    // Prototype Chain Manipulation
    { pattern: /__proto__\s*=/gi, message: "__proto__ assignment is not allowed" },
    { pattern: /Object\.setPrototypeOf/gi, message: "Object.setPrototypeOf is not allowed" },
    { pattern: /Object\.defineProperty/gi, message: "Object.defineProperty is not allowed" },
    { pattern: /Object\.defineProperties/gi, message: "Object.defineProperties is not allowed" },

    // Reflection & Meta-programming
    { pattern: /Reflect\.construct/gi, message: "Reflect.construct is not allowed" },
    { pattern: /Reflect\.apply/gi, message: "Reflect.apply is not allowed" },
    { pattern: /new\s+Proxy/gi, message: "new Proxy is not allowed" },
    { pattern: /Symbol\.for/gi, message: "Symbol.for is not allowed" },

    // Constructor Access (potential escape)
    { pattern: /\.constructor\.constructor/gi, message: "constructor chain is not allowed" },

    // Timer restrictions (use controlled timers instead)
    // { pattern: /setTimeout\s*\(/g, message: "setTimeout is not allowed (use sandbox-provided timers)" },
    // { pattern: /setInterval\s*\(/g, message: "setInterval is not allowed" },
] as const;

/**
 * Default whitelist of allowed Playwright/Puppeteer page methods
 */
export const DEFAULT_ALLOWED_PAGE_METHODS = [
    // Navigation & waiting
    'goto', 'reload', 'waitForSelector', 'waitForTimeout', 'waitForLoadState', 'waitForNavigation', 'waitForEvent',
    "waitForRequest", "waitForResponse",
    // Interaction
    'click', 'fill', 'type', 'press', 'hover', 'focus', 'blur', 'check', 'uncheck', 'selectOption',
    // Evaluation
    'evaluate', 'evaluateHandle', '$eval', '$$eval',
    // Queries
    '$', '$$', 'locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId',
    // Content
    'content', 'title', 'url', 'textContent', 'innerHTML', 'innerText',
    // Screenshots & PDF
    'screenshot', 'pdf',
    // Frames
    'frame', 'frames', 'mainFrame',
    // Attributes
    'getAttribute', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled', 'isChecked',
    'addScriptTag',
    // Window management & events
    'bringToFront', 'on',
    // Misc / Safe utilities
    'toJSON', 'isClosed'
] as const;

