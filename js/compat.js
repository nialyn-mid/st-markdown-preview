/**
 * js/compat.js
 * Centralized registry for importing SillyTavern core modules.
 * Handles different installation paths (standard vs third-party) and provides
 * a single source of truth for external script dependencies.
 */

/**
 * Attempts to import a module from various relative and absolute SillyTavern paths.
 * @param {string} fileName - The name of the script to import (e.g., 'openai.js')
 * @returns {Promise<any|null>} The imported module or null if not found.
 */
async function tryImportST(fileName) {
    const paths = [
        `../../${fileName}`,
        `../../../${fileName}`,
        `../../scripts/${fileName}`,
        `../../../scripts/${fileName}`,
        `/scripts/${fileName}` // Absolute fallback
    ];

    for (const path of paths) {
        try {
            const module = await import(path);
            if (module) return module;
        } catch (e) {
            // Silently continue to next path
        }
    }

    console.warn(`[ST-Markdown] Could not find SillyTavern core script "${fileName}".`);
    return null;
}

/**
 * Imports SillyTavern's AutoComplete.js module.
 */
export async function getAutoCompleteModule() {
    return await tryImportST('autocomplete/AutoComplete.js');
}
