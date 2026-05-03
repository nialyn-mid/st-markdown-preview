/**
 * js/compat.js
 * Centralized registry for importing SillyTavern core modules.
 * Handles different installation paths (standard vs third-party) and provides
 * a single source of truth for external script dependencies.
 */

/**
 * Attempts to import a module from various relative and absolute SillyTavern paths.
 * @param {string} fileName - The name of the script or folder to import (e.g., 'openai.js' or 'extensions/autocomplete')
 * @returns {Promise<any|null>} The imported module or null if not found.
 */
async function tryImportST(fileName) {
    // If it doesn't look like a direct file, try common entry points
    const variations = fileName.endsWith('.js')
        ? [fileName]
        : [fileName + '.js', fileName + '/index.js', fileName + '/AutoComplete.js'];

    const roots = [
        '../../',
        '../../../',
        '../../scripts/',
        '../../../scripts/',
        '/scripts/'
    ];

    for (const root of roots) {
        for (const variant of variations) {
            const path = root + variant;
            try {
                const module = await import(path);
                if (module) return module;
            } catch (e) {
                // Continue to next possibility
            }
        }
    }

    console.warn(`[ST-Markdown] Could not find SillyTavern core script or extension: "${fileName}".`);
    return null;
}

/**
 * Imports SillyTavern's AutoComplete.js module.
 */
export async function getAutoCompleteModule() {
    return await tryImportST('extensions/autocomplete');
}
