# Markdown Input Preview

This extension provides a real-time Markdown preview for the SillyTavern input bar using CodeMirror.

## Settings

- **Enabled**: Toggles the extension on or off.
- **Preview Above Input**: 
  - **Off (Default)**: Replaces the standard textarea with a WYSIWYG CodeMirror editor that renders styles (bold, italics, etc.) directly as you type.
  - **On**: Restores the default textarea and displays a rendered Markdown preview box above it.
- **Additional Spacer**: Customizes the extra vertical padding at the bottom of the chat, which is used to prevent the chat from being obscured by the preview box.

## Installation

### Via SillyTavern Extension Installer (Recommended)

1. Open SillyTavern.
2. Go to **Extensions** (puzzle icon) → **Install Extension**.
3. Paste this repository URL: `https://github.com/nialyn-mid/st-markdown-preview`
4. Click **Install**.
5. Refresh the page.

### Manual Installation

1. Navigate to your SillyTavern installation's `public/scripts/extensions` folder.
2. Clone this repository or download the ZIP into a folder named `st-markdown-preview`.
3. Restart SillyTavern or refresh your browser.
