import { getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { debounce } from '../../utils.js';
import { debounce_timeout } from '../../constants.js';

const MODULE_NAME = 'st-markdown-preview';

const defaultSettings = {
    enabled: true,
    aboveInput: true,
    additionalSpacer: 0,
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
 * Ensures the chat spacer exists and is at the bottom of the chat area.
 */
function ensureChatSpacer() {
    const $chat = $('#chat');
    if (!$chat.length) return;

    let $spacer = $('#st-markdown-preview-spacer');
    if (!$spacer.length) {
        $spacer = $('<div id="st-markdown-preview-spacer"></div>');
        $chat.append($spacer);
    } else if ($spacer.parent()[0] !== $chat[0] || $spacer.next().length > 0) {
        // Move it to the end if it's not there
        $chat.append($spacer);
    }
}

/**
 * Scrolls the chat to the bottom.
 * Attempts to use SillyTavern's native scroll helpers if available.
 */
function scrollToBottom(smooth = true) {
    // 1. Try SillyTavern's native global function
    if (typeof window.scrollChatToBottom === 'function') {
        window.scrollChatToBottom({ waitForFrame: true });
        return;
    }

    // 2. Try SillyTavern's context-aware function
    const context = getContext();
    if (context && typeof context.scrollChatToBottom === 'function') {
        context.scrollChatToBottom({ waitForFrame: true });
        return;
    }

    // 3. Fallback to direct DOM manipulation
    const chat = document.getElementById('chat');
    if (!chat) return;

    if (smooth) {
        $(chat).animate({ scrollTop: chat.scrollHeight }, 200);
    } else {
        chat.scrollTop = chat.scrollHeight;
    }
}

/**
 * Updates the chat spacer height based on preview visibility and settings.
 */
function updateChatSpacer() {
    ensureChatSpacer();
    const $container = $('#st-markdown-preview-container');
    const $spacer = $('#st-markdown-preview-spacer');

    if (!$spacer.length) return;

    let height = parseInt(settings.additionalSpacer) + 10 || 0;

    if (settings.enabled && settings.aboveInput && $container.hasClass('visible')) {
        height += $container.outerHeight() || 0;
    }

    $spacer.css('height', `${height}px`);

    // If we are at the bottom of the chat, ensure we stay there
    const chat = document.getElementById('chat');
    if (chat) {
        const threshold = 150;
        const isAtBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < threshold;
        if (isAtBottom) {
            scrollToBottom(false);
        }
    }
}

/**
 * Updates the preview content and visibility.
 */
function updatePreview() {
    if (!settings.enabled) {
        $('#st-markdown-preview-container').removeClass('visible');
        updateChatSpacer();
        return;
    }

    const input = $('#send_textarea').val();
    if (!input || input.trim() === '') {
        $('#st-markdown-preview-container').removeClass('visible');
        updateChatSpacer();
        return;
    }

    const context = getContext();
    const name1 = context.name1 || 'You';

    // Format the text using SillyTavern's native formatting
    let formattedText = context.messageFormatting(input, name1, false, true, -1);

    // Wrap in mes_text for consistent ST styling
    $('#st-markdown-preview-content').empty().append($('<div class="mes_text"></div>').html(formattedText));
    $('#st-markdown-preview-container').addClass('visible');

    // Update spacer immediately, but the ResizeObserver will handle size changes
    updateChatSpacer();
}

const updatePreviewDebounced = debounce(updatePreview, debounce_timeout.short);

/**
 * Initializes the settings UI in the extensions menu.
 */
function initSettingsUI() {
    $('#st-markdown-preview-enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettings();
        updatePreview();
    });

    $('#st-markdown-preview-above-input').prop('checked', settings.aboveInput).on('change', function () {
        settings.aboveInput = !!$(this).prop('checked');
        saveSettings();
        updatePreview();
    });

    const $slider = $('#st-markdown-preview-spacer-slider');
    const $input = $('#st-markdown-preview-additional-spacer');

    $slider.val(settings.additionalSpacer).on('input', function () {
        const val = parseInt($(this).val()) || 0;
        $input.val(val);
        settings.additionalSpacer = val;
        saveSettings();
        updateChatSpacer();
    });

    $input.val(settings.additionalSpacer).on('input', function () {
        const val = parseInt($(this).val()) || 0;
        $slider.val(val);
        settings.additionalSpacer = val;
        saveSettings();
        updateChatSpacer();
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

    const $previewContainer = $preview.filter('#st-markdown-preview-container');
    const $settings = $preview.filter('#st-markdown-preview-settings');

    // Inject preview container
    $('#send_form').prepend($previewContainer);

    // Inject settings
    $('#extensions_settings').append($settings);

    initSettingsUI();

    // MutationObserver to keep spacer at bottom and detect chat changes
    const chat = document.getElementById('chat');
    if (chat) {
        const observer = new MutationObserver(() => {
            ensureChatSpacer();
        });
        observer.observe(chat, { childList: true });
    }

    // ResizeObserver to handle preview height changes (text wrapping, etc.)
    const resizeObserver = new ResizeObserver(() => {
        updateChatSpacer();
    });
    if ($previewContainer[0]) {
        resizeObserver.observe($previewContainer[0]);
    }

    // Listen for input
    $(document).on('input', '#send_textarea', () => {
        updatePreviewDebounced();
    });

    $(document).on('focus', '#send_textarea', () => {
        updatePreview();
    });

    const context = getContext();

    /**
     * Aggressively forces the chat to scroll to the bottom during the initial load period.
     */
    async function forceInitialScroll() {
        console.log('Markdown Preview: Starting robust scroll-to-bottom sequence.');
        for (let i = 0; i < 8; i++) {
            updateChatSpacer();
            scrollToBottom(false);
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // Handle character selection changes (to update macros)
    context.eventSource.on(context.eventTypes.CHARACTER_SELECTED, () => {
        if ($('#st-markdown-preview-container').hasClass('visible')) {
            updatePreviewDebounced();
        }
        // Force scroll to bottom after character change
        setTimeout(() => scrollToBottom(false), 200);
    });

    // Handle chat load events
    context.eventSource.on(context.eventTypes.CHAT_LOADED, () => {
        forceInitialScroll();
    });

    // Clear preview when a message is rendered (sent)
    context.eventSource.on(context.eventTypes.USER_MESSAGE_RENDERED, () => {
        $('#st-markdown-preview-container').removeClass('visible');
        updateChatSpacer();
    });

    // Handle window resize
    window.addEventListener('resize', updateChatSpacer);

    // Initial sequence
    forceInitialScroll();
}

jQuery(init);
