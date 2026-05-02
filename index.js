import { getContext, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { debounce } from '/scripts/utils.js';
import { getAutoCompleteModule } from './js/compat.js';

const MODULE_NAME = 'st-markdown-preview';
const debounce_timeout = {
    short: 50,
};

const defaultSettings = {
    enabled: true,
    aboveInput: false,
    additionalSpacer: 0,
};

let settings = { ...defaultSettings };
let cm = null;

/**
 * Loads a script from a CDN.
 */
function loadScript(url) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

/**
 * Loads a stylesheet from a CDN.
 */
function loadStyle(url) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);
}

/**
 * Initializes CodeMirror on the textarea.
 */
async function initCodeMirror() {
    if (cm) return;

    const textarea = document.getElementById('send_textarea');
    if (!textarea) return;

    // Load CodeMirror from CDN if not already loaded
    if (typeof CodeMirror === 'undefined') {
        loadStyle('https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.13/codemirror.min.css');
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.13/codemirror.min.js');
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.13/mode/markdown/markdown.min.js');
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.13/addon/display/placeholder.min.js');
    }

    cm = CodeMirror.fromTextArea(textarea, {
        mode: 'markdown',
        lineWrapping: true,
        scrollbarStyle: null,
        viewportMargin: Infinity,
        spellcheck: true,
        inputStyle: 'contenteditable',
        placeholder: textarea.placeholder || 'Type a message...',
    });

    const wrapper = cm.getWrapperElement();

    // Proxy bounding box methods so ST's AutoComplete finds the editor's position
    // instead of the hidden textarea's position.
    if (!textarea.originalGetBoundingClientRect) {
        textarea.originalGetBoundingClientRect = textarea.getBoundingClientRect;
        textarea.originalGetClientRects = textarea.getClientRects;
    }
    textarea.getBoundingClientRect = () => {
        const rect = wrapper.getBoundingClientRect();
        console.log(`[ST-Markdown] getBoundingClientRect: top=${rect.top} left=${rect.left} width=${rect.width} height=${rect.height}`);
        return rect;
    };
    textarea.getClientRects = () => {
        const rects = wrapper.getClientRects();
        console.log(`[ST-Markdown] getClientRects: count=${rects.length}`);
        return rects;
    };

    // Proxy dimension properties
    Object.defineProperty(textarea, 'offsetWidth', { get: () => wrapper.offsetWidth, configurable: true });
    Object.defineProperty(textarea, 'offsetHeight', { get: () => wrapper.offsetHeight, configurable: true });
    Object.defineProperty(textarea, 'offsetTop', { get: () => wrapper.offsetTop, configurable: true });
    Object.defineProperty(textarea, 'offsetLeft', { get: () => wrapper.offsetLeft, configurable: true });
    Object.defineProperty(textarea, 'offsetParent', { get: () => wrapper.offsetParent, configurable: true });

    // Ensure the editor doesn't collapse the flex container
    $(wrapper).css({
        flex: '1',
        minHeight: '40px',
        display: 'flex',
        flexDirection: 'column'
    });

    let isSyncing = false;

    // Sync changes: CodeMirror -> Textarea
    cm.on('change', () => {
        if (isSyncing) return;
        isSyncing = true;
        
        // Direct value sync without cm.save()
        textarea.value = cm.getValue();

        // Trigger ST events for autocomplete and character count
        // Using setTimeout to prevent sync-event loops that might jump the cursor
        setTimeout(() => {
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }, 0);
        
        updateChatSpacer();
        isSyncing = false;
    });
    
    // Mirror keys for ST's slash command autocomplete
    const mirrorEvent = (type, originalEvent) => {
        if (!type.startsWith('key')) return;
        
        const event = new KeyboardEvent(type, {
            key: originalEvent.key,
            code: originalEvent.code,
            ctrlKey: originalEvent.ctrlKey,
            shiftKey: originalEvent.shiftKey,
            altKey: originalEvent.altKey,
            metaKey: originalEvent.metaKey,
            bubbles: true,
            cancelable: true
        });
        
        // Force legacy properties which are often read-only
        Object.defineProperty(event, 'keyCode', { value: originalEvent.keyCode || originalEvent.which });
        Object.defineProperty(event, 'which', { value: originalEvent.which || originalEvent.keyCode });
        Object.defineProperty(event, 'charCode', { value: originalEvent.charCode });
        
        const canceled = !textarea.dispatchEvent(event) || event.defaultPrevented;
        if (canceled) {
            originalEvent.preventDefault();
            originalEvent.stopPropagation();
        }
    };

    cm.on('keydown', (instance, e) => mirrorEvent('keydown', e));
    cm.on('keyup', (instance, e) => mirrorEvent('keyup', e));

    // Mirror focus/blur so ST's AutoComplete knows when to show/hide
    let isMirroringFocus = false;
    
    // Capture original descriptors for safe fallback
    const proto = HTMLTextAreaElement.prototype;
    const descStart = Object.getOwnPropertyDescriptor(proto, 'selectionStart');
    const descEnd = Object.getOwnPropertyDescriptor(proto, 'selectionEnd');

    // Proxy selectionStart/End for ST compatibility (Slash commands)
    const descValue = Object.getOwnPropertyDescriptor(proto, 'value');
    Object.defineProperty(textarea, 'value', {
        get: () => cm ? cm.getValue() : descValue.get.call(textarea),
        set: (v) => {
            if (cm && !isSyncing) {
                isSyncing = true;
                cm.setValue(v);
                isSyncing = false;
            } else {
                descValue.set.call(textarea, v);
            }
        },
        configurable: true
    });

    Object.defineProperty(textarea, 'selectionStart', {
        get: () => cm ? cm.indexFromPos(cm.getCursor('start')) : descStart.get.call(textarea),
        set: (v) => { 
            if (cm && !isSyncing) cm.setCursor(cm.posFromIndex(v)); 
            else descStart.set.call(textarea, v);
        },
        configurable: true
    });

    Object.defineProperty(textarea, 'selectionEnd', {
        get: () => cm ? cm.indexFromPos(cm.getCursor('end')) : descEnd.get.call(textarea),
        set: (v) => { 
            if (cm && !isSyncing) cm.setSelection(cm.getCursor('start'), cm.posFromIndex(v)); 
            else descEnd.set.call(textarea, v);
        },
        configurable: true
    });

    // Bypass AutoComplete focus check
    const setupPatch = async () => {
        try {
            const module = await getAutoCompleteModule();
            if (!module) return;
            const ACClass = module.AutoComplete;
            
            if (ACClass && !ACClass.prototype.isPatched) {
                const originalShow = ACClass.prototype.show;
                ACClass.prototype.show = async function(...args) {
                    const isEditorFocused = cm && cm.hasFocus();
                    const doc = this.textarea.ownerDocument;
                    const originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
                    
                    if (isEditorFocused) {
                        Object.defineProperty(doc, 'activeElement', {
                            get: () => this.textarea,
                            configurable: true
                        });
                    }

                    try {
                        return await originalShow.apply(this, args);
                    } finally {
                        if (isEditorFocused) {
                            Object.defineProperty(doc, 'activeElement', originalDescriptor);
                        }
                    }
                };
                ACClass.prototype.isPatched = true;
            }
        } catch (e) {
            console.error('[ST-Markdown] Failed to patch AutoComplete:', e);
        }
    };
    setupPatch();

    // Capture initial value from textarea
    if (textarea.value) {
        cm.setValue(textarea.value);
    }

    // Capture external jQuery updates (common in ST)
    if (!jQuery.fn.originalVal) {
        jQuery.fn.originalVal = jQuery.fn.val;
        jQuery.fn.val = function (value) {
            const res = jQuery.fn.originalVal.apply(this, arguments);
            if (arguments.length > 0 && this.is('#send_textarea') && cm && !isSyncing) {
                const currentVal = cm.getValue();
                if (currentVal !== value) {
                    isSyncing = true;
                    cm.setValue(value);
                    isSyncing = false;
                }
            }
            return res;
        };
    }

    // Initial sync
    syncCodeMirrorStyles();
    updateChatSpacer();

    // Add overlay for highlighting text in quotes, macros, and slash commands
    cm.addOverlay({
        token: function (stream) {
            // Slash commands (start of line)
            if (stream.sol() && stream.match(/\/\w+/)) return "st-command";

            // Macros {{...}}
            if (stream.match(/{{[^}]+}}/)) return "st-macro";

            // Double quotes "..."
            if (stream.match(/"[^"]*"/)) return "st-quote";

            // Underline __...__ (ST specific)
            if (stream.match(/__[^_]+__/)) return "st-underline";

            // Strikethrough ~~...~~
            if (stream.match(/~~[^~]+~~/)) return "st-strike";

            while (stream.next() != null &&
                !stream.match(/"|{{|\/\w+|__|~~/, false)) { }
            return null;
        }
    });
}

/**
 * Syncs the theme styles to CodeMirror.
 */
function syncCodeMirrorStyles() {
    if (!cm) return;
    const $textarea = $('#send_textarea');
    const styles = window.getComputedStyle($textarea[0]);

    const $cmElement = $(cm.getWrapperElement());
    $cmElement.css({
        fontFamily: styles.fontFamily,
        fontSize: styles.fontSize,
        lineHeight: styles.lineHeight,
        color: styles.color,
        background: 'transparent',
        padding: styles.padding,
        flex: '1',
    });

    // Custom CodeMirror CSS to match ST look and Smart Theme colors
    const styleId = 'st-markdown-cm-styles';
    $('#' + styleId).remove();
    const style = document.createElement('style');
    style.id = styleId;
    style.innerHTML = `
        .CodeMirror { 
            flex: 1 !important;
            order: 2 !important;
            height: auto; 
            min-height: ${$textarea.outerHeight()}px; 
            background: transparent !important; 
            color: inherit !important;
            border: none !important;
            font-family: inherit !important;
        }
        .CodeMirror-scroll { height: auto; overflow: visible; min-height: 100%; }
        .CodeMirror-lines { padding: 0; }
        
        /* Smart Theme Color Mapping */
        .cm-header { font-weight: bold; color: var(--SmartThemeEmColor) !important; }
        .cm-strong { font-weight: bold; color: var(--SmartThemeEmColor) !important; }
        .cm-em { font-style: italic; color: var(--SmartThemeItalicColor, inherit) !important; }
        .cm-strikethrough { text-decoration: line-through; opacity: 0.6; }
        
        /* Underline and Strike overrides */
        .cm-st-underline { text-decoration: underline !important; font-weight: normal !important; }
        .cm-st-strike { text-decoration: line-through !important; opacity: 0.6 !important; }
        
        /* Link and URL styling */
        .cm-link { color: var(--SmartThemeQuoteColor) !important; text-decoration: underline; }
        .cm-url { color: var(--SmartThemeQuoteColor) !important; opacity: 0.7; }
        
        /* Quote styling (Markdown > and ST "quotes") */
        .cm-quote { color: var(--SmartThemeQuoteColor) !important; font-style: italic; }
        .cm-st-quote { color: var(--SmartThemeQuoteColor) !important; }
        
        /* ST specific syntax */
        .cm-st-macro { color: var(--SmartThemeLinkColor, var(--SmartThemeEmColor)) !important; font-weight: bold; }
        .cm-st-command { color: var(--SmartThemeEmColor) !important; font-family: var(--mono-font-family, monospace); }
        
        .cm-comment { background: rgba(255,255,255,0.05); border-radius: 3px; }
        .cm-formatting { opacity: 0.3; }
        
        .CodeMirror-cursor { border-left: 2px solid var(--SmartThemeBodyColor, white) !important; }
        .CodeMirror-selected { background: rgba(66, 133, 244, 0.15) !important; }
        
        /* Placeholder Styling */
        .CodeMirror-placeholder { color: inherit !important; opacity: 0.4 !important; }

        /* Attempt to style native spellcheck underlines (Modern Browsers) */
        .CodeMirror *::spelling-error {
            text-decoration: underline red !important;
            text-decoration-style: solid !important;
            text-underline-offset: 2px;
        }
        .CodeMirror *::grammar-error {
            text-decoration: underline orange !important;
            text-decoration-style: solid !important;
            text-underline-offset: 2px;
        }

        /* Force Flex Order and Alignment */
        #leftSendForm { order: 1 !important; }
        #rightSendForm { order: 3 !important; }
        #nonQRFormItems { display: flex !important; align-items: center !important; }
    `;
    document.head.appendChild(style);

    // Give the browser a moment to layout the flexbox before refreshing CM
    setTimeout(() => cm.refresh(), 10);
}

/**
 * Ensures the spacer element exists at the bottom of the chat.
 */
function ensureChatSpacer() {
    const chat = document.getElementById('chat');
    if (!chat) return;

    let spacer = document.getElementById('st-markdown-preview-spacer');
    if (!spacer) {
        spacer = document.createElement('div');
        spacer.id = 'st-markdown-preview-spacer';
        chat.appendChild(spacer);
    } else if (chat.lastElementChild !== spacer) {
        chat.appendChild(spacer);
    }
}

/**
 * Updates the height of the chat spacer.
 */
function updateChatSpacer() {
    const spacer = document.getElementById('st-markdown-preview-spacer');
    if (!spacer) {
        ensureChatSpacer();
        return;
    }

    let height = 0;

    // Add additional user-configured spacer only if preview is visible or specifically enabled
    if (settings.enabled) {
        if (settings.aboveInput) {
            const container = document.getElementById('st-markdown-preview-container');
            if (container && container.classList.contains('visible')) {
                height += container.offsetHeight;
                height += parseInt(settings.additionalSpacer) || 0;
            }
        } else {
            // In WYSIWYG mode, we usually don't need the extra spacer unless the user really wants it
            // For now, let's keep it 0 to avoid the "extra space" issue reported
            height = 0;
        }
    }

    spacer.style.height = `${height}px`;
}

/**
 * Scrolls the chat container to the bottom.
 */
function scrollToBottom(force = false) {
    const chat = document.getElementById('chat');
    if (!chat) return;

    // Use SillyTavern's native scroll function if available
    if (window.scrollChatToBottom) {
        window.scrollChatToBottom();
    } else {
        chat.scrollTop = chat.scrollHeight;
    }
}

/**
 * Updates the preview content and visibility.
 */
function updatePreview() {
    const $aboveContainer = $('#st-markdown-preview-container');
    const $textarea = $('#send_textarea');

    if (!settings.enabled) {
        if (cm) {
            cm.toTextArea();
            cm = null;
        }
        $aboveContainer.removeClass('visible');

        // Restore native styles and proxies
        const el = $textarea[0];
        if (el) {
            $(el).css({
                position: '',
                top: '',
                left: '',
                width: '',
                height: '',
                opacity: '',
                pointerEvents: '',
                zIndex: '',
                display: ''
            });
            if (el.originalGetBoundingClientRect) {
                el.getBoundingClientRect = el.originalGetBoundingClientRect;
                el.getClientRects = el.originalGetClientRects;
            }
        }

        updateChatSpacer();
        return;
    }

    if (!settings.aboveInput) {
        $aboveContainer.removeClass('visible');
        if (!cm) initCodeMirror();
        updateChatSpacer();
    } else {
        if (cm) {
            cm.toTextArea();
            cm = null;
            // Restore native styles
            $('#send_textarea').css({
                position: '',
                top: '',
                left: '',
                width: '',
                height: '',
                opacity: '',
                pointerEvents: '',
                zIndex: '',
                display: ''
            });

            // Restore native bounding box methods if they were proxied
            const el = $textarea[0];
            if (el && el.originalGetBoundingClientRect) {
                el.getBoundingClientRect = el.originalGetBoundingClientRect;
                el.getClientRects = el.originalGetClientRects;
            }
        }

        const input = $textarea.val();
        if (!input || input.trim() === '') {
            $aboveContainer.removeClass('visible');
            updateChatSpacer();
            return;
        }

        const context = getContext();
        const name1 = context.name1 || 'You';
        let formattedText = context.messageFormatting(input, name1, false, true, -1);
        $('#st-markdown-preview-content').empty().append($('<div class="mes_text"></div>').html(formattedText));
        $aboveContainer.addClass('visible');
        updateChatSpacer();
    }
}

const updatePreviewDebounced = debounce(updatePreview, debounce_timeout.short);

/**
 * Saves settings to SillyTavern's extension storage.
 */
function saveSettings() {
    const context = getContext();
    context.extensionSettings[MODULE_NAME] = settings;
    saveSettingsDebounced();
}

const saveSettingsDebounced = debounce(() => {
    const context = getContext();
    if (typeof context.saveSettings === 'function') {
        context.saveSettings();
    } else if (typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
    } else if (typeof window.saveSettingsApp === 'function') {
        window.saveSettingsApp();
    }
}, 2000);

/**
 * Loads settings from SillyTavern's extension storage.
 */
function loadSettings() {
    const context = getContext();
    if (context.extensionSettings[MODULE_NAME]) {
        settings = Object.assign(settings, context.extensionSettings[MODULE_NAME]);
    }
}

/**
 * Initializes the settings UI.
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

    const previewHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'preview');
    const $preview = $(previewHtml);

    const $previewContainer = $preview.filter('#st-markdown-preview-container');
    const $settings = $preview.filter('#st-markdown-preview-settings');

    $('#send_form').prepend($previewContainer);
    $('#extensions_settings').append($settings);

    initSettingsUI();

    const chat = document.getElementById('chat');
    if (chat) {
        const observer = new MutationObserver(() => ensureChatSpacer());
        observer.observe(chat, { childList: true });
    }

    const context = getContext();
    context.eventSource.on(context.eventTypes.CHAT_LOADED, () => {
        if (cm) {
            const textarea = document.getElementById('send_textarea');
            if (textarea && textarea.value !== cm.getValue()) {
                cm.setValue(textarea.value);
            }
        }
        updateChatSpacer();
        setTimeout(() => scrollToBottom(true), 500);
    });

    context.eventSource.on(context.eventTypes.USER_MESSAGE_RENDERED, () => {
        if (cm) cm.setValue('');
        $('#st-markdown-preview-container').removeClass('visible');
        updateChatSpacer();
    });

    updatePreview();
}

jQuery(init);
