import { getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { debounce } from '../../utils.js';
import { debounce_timeout } from '../../constants.js';

const MODULE_NAME = 'st-markdown-preview';

const defaultSettings = {
    enabled: true,
};

let settings = { ...defaultSettings };

/**
 * Saves settings to SillyTavern's extension settings.
 */
function saveSettings() {
    const context = getContext();
    if (!context.extensionSettings) context.extensionSettings = {};
    context.extensionSettings[MODULE_NAME] = settings;
    context.saveSettingsDebounced();
}

/**
 * Loads settings from SillyTavern's extension settings.
 */
function loadSettings() {
    const context = getContext();
    const saved = context.extensionSettings?.[MODULE_NAME];
    if (saved) {
        settings = { ...defaultSettings, ...saved };
    }
}

/**
 * Updates the preview content and visibility.
 */
function updatePreview() {
    if (!settings.enabled) {
        $('#st-markdown-preview-container').removeClass('visible');
        return;
    }

    const input = $('#send_textarea').val();
    if (!input || input.trim() === '') {
        $('#st-markdown-preview-container').removeClass('visible');
        return;
    }

    const context = getContext();
    const name1 = context.name1 || 'You';
    
    // Format the text using SillyTavern's native formatting
    // messageFormatting(mes, ch_name, isSystem, isUser, messageId, sanitizerOverrides, isReasoning)
    let formattedText = context.messageFormatting(input, name1, false, true, -1);

    // Wrap in mes_text for consistent ST styling
    $('#st-markdown-preview-content').empty().append($('<div class="mes_text"></div>').html(formattedText));
    $('#st-markdown-preview-container').addClass('visible');
}

const updatePreviewDebounced = debounce(updatePreview, debounce_timeout.short);

/**
 * Initializes the settings UI in the extensions menu.
 */
function initSettingsUI() {
    const enabledCheckbox = $('#st-markdown-preview-enabled');
    enabledCheckbox.prop('checked', settings.enabled);
    enabledCheckbox.on('change', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettings();
        updatePreview();
    });
}

/**
 * Entry point for the extension.
 */
async function init() {
    loadSettings();

    // Render the templates
    const previewHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'preview');
    const $preview = $(previewHtml);

    // Split preview and settings
    const $previewContainer = $preview.filter('#st-markdown-preview-container');
    const $settings = $preview.filter('#st-markdown-preview-settings');

    // Inject preview container as an overlay within the send form
    $('#send_form').prepend($previewContainer);

    // Inject settings into the extension settings menu
    $('#extensions_settings').append($settings);

    initSettingsUI();

    // Listen for input on the send textarea
    $(document).on('input', '#send_textarea', () => {
        updatePreviewDebounced();
    });

    // Also update when focus/blur if needed
    $(document).on('focus', '#send_textarea', () => {
        updatePreview();
    });

    const context = getContext();
    
    // Handle character selection changes (to update macros)
    context.eventSource.on(context.eventTypes.CHARACTER_SELECTED, () => {
        if ($('#st-markdown-preview-container').hasClass('visible')) {
            updatePreviewDebounced();
        }
    });

    // Clear preview when a message is rendered (sent)
    context.eventSource.on(context.eventTypes.USER_MESSAGE_RENDERED, () => {
        $('#st-markdown-preview-container').removeClass('visible');
    });
}

jQuery(init);
