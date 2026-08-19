export const MAX_CLIPBOARD_TEXT_LENGTH = 64 * 1024;

/**
 * Routes plain-text paste events from one emulator display to guest keyboard
 * input. The listener belongs to this adapter and is removed by destroy().
 *
 * @constructor
 * @param {!EventTarget} target
 * @param {function(string): *} send_text
 */
export function ClipboardAdapter(target, send_text)
{
    this.target = target;
    this.send_text_callback = send_text;
    this.destroyed = false;

    /** @param {!Event} event */
    this.paste_handler = event => {
        const clipboard_event = /** @type {!ClipboardEvent} */ (event);
        const text = clipboard_event.clipboardData &&
            clipboard_event.clipboardData.getData("text/plain");
        if(text && this.send(text))
        {
            clipboard_event.preventDefault();
        }
    };

    target.addEventListener("paste", this.paste_handler, false);
}

/**
 * Send bounded clipboard text to the guest.
 *
 * @param {string} text
 * @returns {number} Number of UTF-16 code units sent
 */
ClipboardAdapter.prototype.send = function(text)
{
    if(this.destroyed || typeof text !== "string" || !text.length)
    {
        return 0;
    }

    const bounded_text = text.length > MAX_CLIPBOARD_TEXT_LENGTH ?
        text.slice(0, MAX_CLIPBOARD_TEXT_LENGTH) : text;
    this.send_text_callback(bounded_text);
    return bounded_text.length;
};

ClipboardAdapter.prototype.destroy = function()
{
    if(this.destroyed)
    {
        return;
    }

    this.destroyed = true;
    this.target.removeEventListener("paste", this.paste_handler, false);
};
