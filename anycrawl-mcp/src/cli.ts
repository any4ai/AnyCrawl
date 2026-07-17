#!/usr/bin/env node
import { main } from './index.js';
import { logger } from './logger.js';

// Start the server with error handling
main().catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
});