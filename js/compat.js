/**
 * js/compat.js
 * Centralized registry for importing SillyTavern core modules.
 * Handles different installation paths (standard vs third-party) and provides
 * a single source of truth for external script dependencies.
 */

import { logger } from './logger.js';

/**
 * Attempts to import a module from various relative and absolute SillyTavern paths.
 * @param {string} fileName - The name of the script or folder to import (e.g., 'openai.js' or 'extensions/autocomplete')
 * @returns {Promise<any|null>} The imported module or null if not found.
 */
async function tryImportST(fileName) {
    // Determine the search variations
    const variations = fileName.endsWith('.js') 
        ? [fileName] 
        : [
            fileName + '/AutoComplete.js', // Most common for core
            fileName + '/index.js',        // Common for extensions
            fileName + '.js'               // Direct file
        ];

    // Priority roots - search absolute core paths first to avoid relative noise
    const roots = [
        '/scripts/',
        '../../../',
        '../../',
        '../../../scripts/',
        '../../scripts/'
    ];

    for (const root of roots) {
        for (const variant of variations) {
            const path = root + variant;
            try {
                // Try the import. Browser will log 404 if not found.
                const module = await import(path);
                if (module) {
                    logger.debug(`Successfully imported "${fileName}" from: ${path}`);
                    return module;
                }
            } catch (e) {
                // Fail silently and try next path
            }
        }
    }

    logger.warn(`Could not resolve SillyTavern module: "${fileName}"`);
    return null;
}

/**
 * Imports SillyTavern's AutoComplete.js module.
 */
export async function getAutoCompleteModule() {
    return await tryImportST('autocomplete');
}
