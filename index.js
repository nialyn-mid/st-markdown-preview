import { getContext, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { debounce } from '/scripts/utils.js';
import { getAutoCompleteModule } from './js/compat.js';
import { logger } from './js/logger.js';

// Dynamically determine the module name/path for template loading
const getModuleName = () => {
    try {
        const url = import.meta.url;
        const match = url.match(/scripts\/extensions\/(.+)\/index\.js/);
        if (match) return match[1];
    } catch (e) {
        // Fallback
    }
    return 'st-markdown-preview';
};

const MODULE_NAME = getModuleName();
const debounce_timeout = {
    short: 50,
};

const defaultSettings = {
    enabled: true,
    aboveInput: false,
    autocorrect: true,
    blurOnSend: true,
    additionalSpacer: 0,
    enterAction: 0, // 0: Send, 1: New Line, 2: None
    logLevel: 2, // Default to WARN
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
    if (!textarea) {
        logger.error('Required element #send_textarea not found. Initialization aborted.');
        return;
    }

    logger.info('Initializing CodeMirror for chat input...');

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
        spellcheck: settings.autocorrect,
        inputStyle: 'contenteditable',
        placeholder: textarea.placeholder || 'Type a message...',
    });

    // Apply mobile-friendly attributes to the input field
    const applyInputAttributes = () => {
        const inputField = cm.getInputField();
        if (inputField) {
            inputField.setAttribute('autocorrect', settings.autocorrect ? 'on' : 'off');
            inputField.setAttribute('autocapitalize', settings.autocorrect ? 'sentences' : 'none');
            inputField.setAttribute('spellcheck', settings.autocorrect ? 'true' : 'false');
        }
    };
    applyInputAttributes();
    cm.on('refresh', applyInputAttributes);

    logger.info('CodeMirror instance created successfully.');

    const wrapper = cm.getWrapperElement();
    const sendForm = document.getElementById('send_form') || wrapper;

    // Proxy bounding box methods so ST's AutoComplete finds the entire input bar's position
    // instead of the hidden textarea's position.
    if (!textarea.originalGetBoundingClientRect) {
        textarea.originalGetBoundingClientRect = textarea.getBoundingClientRect;
        textarea.originalGetClientRects = textarea.getClientRects;
    }
    textarea.getBoundingClientRect = () => {
        const rect = sendForm.getBoundingClientRect();
        logger.debug('getBoundingClientRect proxy (sendForm):', rect);
        return rect;
    };
    textarea.getClientRects = () => {
        const rects = sendForm.getClientRects();
        logger.debug('getClientRects proxy count (sendForm):', rects.length);
        return rects;
    };

    // Proxy dimension properties
    Object.defineProperty(textarea, 'offsetWidth', { get: () => sendForm.offsetWidth, configurable: true });
    Object.defineProperty(textarea, 'offsetHeight', { get: () => sendForm.offsetHeight, configurable: true });
    Object.defineProperty(textarea, 'offsetTop', { get: () => sendForm.offsetTop, configurable: true });
    Object.defineProperty(textarea, 'offsetLeft', { get: () => sendForm.offsetLeft, configurable: true });
    Object.defineProperty(textarea, 'offsetParent', { get: () => sendForm.offsetParent, configurable: true });

    const dispatchResize = debounce(() => {
        window.dispatchEvent(new Event('resize'));
    }, 10);

    // Monitor input bar height changes to force ST's AutoComplete to reposition
    const resizeObserver = new ResizeObserver(() => {
        // Trigger window resize event which ST's AutoComplete listens to for repositioning
        dispatchResize();
        updateChatSpacer();
    });
    resizeObserver.observe(sendForm);

    // Ensure the editor doesn't collapse
    $(wrapper).css({
        flex: '1 1 0%',
        display: 'block'
    });

    let isSyncing = false;

    // Sync changes: CodeMirror -> Textarea
    cm.on('change', () => {
        if (isSyncing) return;
        isSyncing = true;

        // Direct value sync without cm.save()
        textarea.value = cm.getValue();

        // Trigger ST events for autocomplete and character count
        // Using requestAnimationFrame to ensure layout has settled before ST measures the position
        requestAnimationFrame(() => {
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });

        updateChatSpacer();
        isSyncing = false;
    });

    // Mirror keys for ST's slash command autocomplete and global hotkeys
    const mirrorEvent = (type, originalEvent) => {
        if (!type.startsWith('key')) return;

        // Handle Enter action settings
        const isEnter = originalEvent.key === 'Enter';
        const hasModifiers = originalEvent.ctrlKey || originalEvent.shiftKey || originalEvent.altKey || originalEvent.metaKey;

        if (isEnter && !hasModifiers) {
            if (settings.enterAction === 1) { // New Line (Skip Mirroring)
                return;
            }
            if (settings.enterAction === 3) { // Block (Full Suppression)
                originalEvent.preventDefault();
                originalEvent.stopPropagation();
                return;
            }
            // Send (0) and None (2) proceed to mirroring
        }

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

        // Proxy activeElement so global listeners (like Enter to send) think the native textarea is focused
        const doc = textarea.ownerDocument;
        const originalActiveElementDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
        
        // Only proxy for Enter if "Send" action is selected. Otherwise, proxy for all other keys (Slash commands).
        const shouldProxyActiveElement = (isEnter && !hasModifiers) ? (settings.enterAction === 0) : true;

        if (shouldProxyActiveElement) {
            Object.defineProperty(doc, 'activeElement', {
                get: () => textarea,
                configurable: true
            });
        }

        try {
            const canceled = !textarea.dispatchEvent(event) || event.defaultPrevented;
            if (canceled) {
                originalEvent.preventDefault();
                originalEvent.stopPropagation();
            }
        } finally {
            if (shouldProxyActiveElement) {
                // Restore original activeElement behavior
                if (originalActiveElementDescriptor) {
                    Object.defineProperty(doc, 'activeElement', originalActiveElementDescriptor);
                } else {
                    delete doc.activeElement;
                }
            }
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
    const descValue = Object.getOwnPropertyDescriptor(proto, 'value');
    const descPlaceholder = Object.getOwnPropertyDescriptor(proto, 'placeholder');

    // Proxy selectionStart/End for ST compatibility (Slash commands)
    Object.defineProperty(textarea, 'value', {
        get: () => cm ? cm.getValue() : descValue.get.call(textarea),
        set: (v) => {
            const isClearing = (v === '' || v === null || v === undefined);
            if (cm && !isSyncing) {
                isSyncing = true;
                cm.setValue(v || '');
                isSyncing = false;

                if (isClearing && settings.blurOnSend) {
                    logger.debug('Input cleared via value setter, blurring CodeMirror.');
                    cm.getInputField().blur();
                }
            } else {
                descValue.set.call(textarea, v);
                if (isClearing && settings.blurOnSend && !isSyncing) {
                    logger.debug('Input cleared via value setter, blurring textarea.');
                    textarea.blur();
                }
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

    Object.defineProperty(textarea, 'placeholder', {
        get: () => cm ? cm.getOption('placeholder') : (descPlaceholder ? descPlaceholder.get.call(textarea) : textarea.getAttribute('placeholder')),
        set: (v) => {
            if (cm) {
                cm.setOption('placeholder', v || 'Type a message...');
            }
            if (descPlaceholder) {
                descPlaceholder.set.call(textarea, v);
            } else {
                textarea.setAttribute('placeholder', v);
            }
        },
        configurable: true
    });

    // Sync placeholder changes via MutationObserver (for attribute changes)
    const placeholderObserver = new MutationObserver((mutations) => {
        if (!cm) return;
        for (const mutation of mutations) {
            if (mutation.type === 'attributes' && mutation.attributeName === 'placeholder') {
                const newPlaceholder = textarea.getAttribute('placeholder');
                if (cm.getOption('placeholder') !== newPlaceholder) {
                    cm.setOption('placeholder', newPlaceholder || 'Type a message...');
                }
            }
        }
    });
    placeholderObserver.observe(textarea, { attributes: true, attributeFilter: ['placeholder'] });

    // Bypass AutoComplete focus check
    const setupPatch = async () => {
        try {
            const module = await getAutoCompleteModule();
            if (!module) return;
            const ACClass = module.AutoComplete;

            if (ACClass && !ACClass.prototype.isPatched) {
                const originalShow = ACClass.prototype.show;
                ACClass.prototype.show = async function (...args) {
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
                const originalUpdatePosition = ACClass.prototype.updatePosition;
                ACClass.prototype.updatePosition = function (...args) {
                    if (!this.textarea || !this.textarea.isConnected) return;
                    return originalUpdatePosition.apply(this, args);
                };

                ACClass.prototype.isPatched = true;
                logger.info('Successfully patched AutoComplete for CodeMirror compatibility.');
            }
        } catch (e) {
            logger.error('Failed to patch AutoComplete:', e);
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
            const isClearing = arguments.length > 0 && (value === '' || value === null || value === undefined);

            if (arguments.length > 0 && this.is('#send_textarea') && cm && !isSyncing) {
                const currentVal = cm.getValue();
                if (currentVal !== value) {
                    isSyncing = true;
                    cm.setValue(value || '');
                    isSyncing = false;
                }
                if (isClearing && settings.blurOnSend) {
                    logger.debug('Input cleared via jQuery.val(), blurring CodeMirror.');
                    cm.getInputField().blur();
                }
            } else if (isClearing && this.is('#send_textarea') && settings.blurOnSend && !isSyncing) {
                logger.debug('Input cleared via jQuery.val(), blurring textarea.');
                this.blur();
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

            // Italics (matching ST style)
            if (stream.match(/\*[^* \n][^*]*\*|\_[^_ \n][^_]*\_/)) return "st-italic";

            // Underline __...__ (ST specific)
            if (stream.match(/__[^_]+__/)) return "st-underline";

            // Strikethrough ~~...~~
            if (stream.match(/~~[^~]+~~/)) return "st-strike";

            while (stream.next() != null &&
                !stream.match(/"|{{|\/\w+|__|~~|\*|_/, false)) { }
            return null;
        }
    });
}

/**
 * Syncs the theme styles to CodeMirror.
 */
function syncCodeMirrorStyles() {
    try {
        if (!cm) return;
        const $textarea = $('#send_textarea');
        const styles = window.getComputedStyle($textarea[0]);

        const $cmElement = $(cm.getWrapperElement());

        // Base height on the original textarea, with an 18px minimum for a sleeker look
        const barHeight = Math.min(60, Math.max(18, $textarea.outerHeight() || 18));
        const fontSize = parseFloat(styles.fontSize) || 15;
        let lh = parseFloat(styles.lineHeight);
        if (isNaN(lh)) lh = fontSize * 1.1;
        const vPadding = Math.max(0, Math.floor((barHeight - lh) / 2));

        $cmElement.css({
            fontFamily: styles.fontFamily,
            fontSize: styles.fontSize,
            lineHeight: styles.lineHeight,
            color: styles.color,
            background: 'transparent',
            padding: '0',
            flex: '1 1 0%',
        });

        // Patch jump-to-start behavior when clicking in the top padding
        const $wrapper = $(cm.getWrapperElement());
        $wrapper.off('mousedown.st_markdown_fix');
        $wrapper.on('mousedown.st_markdown_fix', function (e) {
            const rect = this.getBoundingClientRect();
            const y = e.clientY - rect.top;

            // If clicking in the vertical padding area, manually place the cursor
            if (y < vPadding || y > rect.height - vPadding) {
                e.preventDefault();
                cm.focus();
                const coords = cm.coordsChar({
                    left: e.clientX,
                    top: rect.top + vPadding + (lh / 2)
                }, 'window');
                cm.setCursor(coords);
            }
        });

        // Custom CodeMirror CSS to match ST look and Smart Theme colors
        const styleId = 'st-markdown-cm-styles';
        $('#' + styleId).remove();
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = `
        .CodeMirror { 
            flex: 1 1 0% !important;
            order: 2 !important;
            height: auto !important; 
            min-height: ${barHeight}px !important; 
            background: transparent !important; 
            color: inherit !important;
            border: none !important;
            font-family: inherit !important;
        }
        /* Allow the parent bar to grow with the editor */
        #nonQRFormItems {
            height: auto !important;
            min-height: ${barHeight}px !important;
        }
        .CodeMirror-scroll { 
            height: auto !important; 
            min-height: ${barHeight}px !important;
            overflow: hidden !important; 
            scrollbar-width: none !important;
            -ms-overflow-style: none !important;
        }
        .CodeMirror-scroll::-webkit-scrollbar { display: none !important; }
        
        .CodeMirror-lines { 
            padding: ${vPadding}px ${styles.paddingRight} ${vPadding}px ${styles.paddingLeft} !important; 
            overflow: visible !important;
        }
        
        /* Smart Theme Color Mapping */
        .cm-header { font-weight: bold; color: var(--SmartThemeEmColor) !important; }
        .cm-strong { font-weight: bold; color: var(--SmartThemeEmColor) !important; }
        .cm-em { font-style: italic; color: var(--SmartThemeEmColor, inherit) !important; }
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
        
        /* Italics styling */
        .cm-st-italic { color: var(--SmartThemeEmColor) !important; font-style: italic; }
        
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
        setTimeout(() => {
            if (cm) {
                cm.refresh();
                logger.debug('CodeMirror styles synchronized with theme.');
            }
        }, 10);
    } catch (e) {
        logger.error('Failed to synchronize CodeMirror styles:', e);
    }
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

    let height = parseInt(settings.additionalSpacer) || 0;

    const $container = $('#st-markdown-preview-container');
    if ($container.hasClass('visible')) {
        height += $container.outerHeight() || 0;
    }

    spacer.style.height = height + 'px';
    spacer.style.minHeight = height + 'px';
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
    const $container = $('#st-markdown-preview-container');
    const $textarea = $('#send_textarea');

    if (!settings.enabled) {
        if (cm) {
            cm.toTextArea();
            cm = null;
        }
        $container.removeClass('visible');

        // Restore native styles
        const el = $textarea[0];
        if (el) {
            $(el).css({
                position: '', top: '', left: '', width: '', height: '',
                opacity: '', pointerEvents: '', zIndex: '', display: ''
            });
            if (el.originalGetBoundingClientRect) {
                el.getBoundingClientRect = el.originalGetBoundingClientRect;
                el.getClientRects = el.originalGetClientRects;
            }
        }
        updateChatSpacer();
        return;
    }

    // Handle Mode Switching
    if (settings.aboveInput) {
        // PREVIEW BOX MODE: Use native textarea, show box above
        if (cm) {
            cm.toTextArea();
            cm = null;
            // Restore native styles
            const el = $textarea[0];
            if (el) {
                $(el).css({
                    position: '', top: '', left: '', width: '', height: '',
                    opacity: '', pointerEvents: '', zIndex: '', display: ''
                });
                if (el.originalGetBoundingClientRect) {
                    el.getBoundingClientRect = el.originalGetBoundingClientRect;
                    el.getClientRects = el.originalGetClientRects;
                }
            }
        }

        const input = $textarea.val();
        if (input && input.trim() !== '') {
            const context = getContext();
            const name1 = context.name1 || 'You';
            const formattedText = context.messageFormatting(input, name1, false, true, -1);
            $('#st-markdown-preview-content').empty().append($('<div class="mes_text"></div>').html(formattedText));
            $container.addClass('visible');
        } else {
            $container.removeClass('visible');
        }
    } else {
        // OVERLAY MODE: Use CodeMirror on the input bar
        $container.removeClass('visible');
        if (!cm) {
            initCodeMirror();
        }
    }

    updateChatSpacer();
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

    $('#st-markdown-preview-autocorrect').prop('checked', settings.autocorrect).on('change', function () {
        settings.autocorrect = !!$(this).prop('checked');
        saveSettings();
        if (cm) {
            const inputField = cm.getInputField();
            if (inputField) {
                inputField.setAttribute('autocorrect', settings.autocorrect ? 'on' : 'off');
                inputField.setAttribute('autocapitalize', settings.autocorrect ? 'sentences' : 'none');
                inputField.setAttribute('spellcheck', settings.autocorrect ? 'true' : 'false');
            }
            cm.setOption('spellcheck', settings.autocorrect);
        }
    });

    $('#st-markdown-preview-blur-on-send').prop('checked', settings.blurOnSend).on('change', function () {
        settings.blurOnSend = !!$(this).prop('checked');
        saveSettings();
    });
    
    $('#st-markdown-preview-enter-action').val(settings.enterAction || 0).on('change', function () {
        settings.enterAction = parseInt($(this).val());
        saveSettings();
    });

    // Bind additional spacer events
    const $spacerSlider = $('#st-markdown-preview-spacer-slider');
    const $spacerInput = $('#st-markdown-preview-spacer-slider_value');

    // Initialize values
    $spacerSlider.val(settings.additionalSpacer || 0);
    $spacerInput.val(settings.additionalSpacer || 0);

    $spacerSlider.on('input', function () {
        const val = parseInt($(this).val());
        $spacerInput.val(val);
        settings.additionalSpacer = val;
        saveSettings();
        updateChatSpacer();
    });

    $spacerInput.on('input', function () {
        const val = parseInt($(this).val()) || 0;
        $spacerSlider.val(val);
        settings.additionalSpacer = val;
        saveSettings();
        updateChatSpacer();
    });

    // Bind log level
    const $logLevel = $('#st-markdown-preview-log-level');
    $logLevel.val(settings.logLevel);
    $logLevel.on('change', function () {
        const val = parseInt($(this).val());
        settings.logLevel = val;
        import('./js/logger.js').then(m => m.setLogLevel(val));
        saveSettings();
    });
}

/**
 * Entry point for the extension.
 */
async function init() {
    try {
        loadSettings();

        // Robust template loading
        let previewHtml;
        try {
            previewHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'preview');
        } catch (e) {
            logger.warn('renderExtensionTemplateAsync failed, trying fallback fetch...', e);
            try {
                const response = await fetch(`/scripts/extensions/${MODULE_NAME}/preview.html`);
                if (response.ok) {
                    previewHtml = await response.text();
                } else {
                    throw new Error(`Fallback fetch failed with status ${response.status}`);
                }
            } catch (fallbackError) {
                logger.error('Critical: Failed to load settings template.', fallbackError);
                previewHtml = `<div id="st-markdown-preview-settings" class="extension_container">
                    <div class="inline-drawer">
                        <div class="inline-drawer-header"><b>Markdown Preview (Error)</b></div>
                        <div class="inline-drawer-content">Failed to load settings template. See console for details.</div>
                    </div>
                </div>`;
            }
        }

        const $preview = $(previewHtml);

        const $previewContainer = $preview.find('#st-markdown-preview-container').addBack('#st-markdown-preview-container');
        const $settings = $preview.find('#st-markdown-preview-settings').addBack('#st-markdown-preview-settings');

        if ($previewContainer.length) {
            $('#send_form').prepend($previewContainer);
        }
        if ($settings.length) {
            $('#extensions_settings').append($settings);
            initSettingsUI();
            logger.info('Settings UI initialized.');
        } else {
            logger.warn('Settings container not found in template.');
        }

        // Add listener to native textarea for when CodeMirror is disabled (Above Input mode)
        $('#send_textarea').on('input.st_markdown_preview', () => {
            if (!cm) updatePreviewDebounced();
        });

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
        logger.info('Markdown Preview extension fully initialized.');
    } catch (e) {
        logger.error('Critical initialization error:', e);
    }
}

jQuery(init);
