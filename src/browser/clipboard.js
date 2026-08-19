export const MAX_CLIPBOARD_TEXT_LENGTH = 64 * 1024;

/**
 * Routes plain-text clipboard input from one emulator display to guest
 * keyboard input. Native paste events remain the first choice. A focused
 * Cmd/Ctrl+V also reads the Clipboard API while the trusted key event still
 * owns user activation, which covers non-editable canvas displays where
 * Chromium does not emit a paste event.
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
    this.pending_shortcut = null;

    /** @param {!Event} event */
    this.pointerdown_handler = event => {
        const element = /** @type {!HTMLElement} */ (this.target);
        if(typeof element.focus === "function")
        {
            element.focus({ preventScroll: true });
        }
    };

    /** @param {!Event} event */
    this.keydown_handler = event => {
        const keyboard_event = /** @type {!KeyboardEvent} */ (event);
        const is_v = keyboard_event.code === "KeyV" ||
            keyboard_event.keyCode === 86;
        if(!is_v || keyboard_event.repeat || keyboard_event.altKey ||
           !keyboard_event.ctrlKey && !keyboard_event.metaKey)
        {
            return;
        }

        const clipboard = globalThis.navigator &&
            globalThis.navigator.clipboard;
        if(!clipboard || typeof clipboard.readText !== "function")
        {
            return;
        }

        const pending = {};
        this.pending_shortcut = pending;
        let read;
        try
        {
            read = clipboard.readText();
        }
        catch(error)
        {
            this.pending_shortcut = null;
            this.report("v86-clipboard-error", { error });
            return;
        }

        Promise.resolve(read).then(text => {
            setTimeout(() => {
                if(this.destroyed || this.pending_shortcut !== pending)
                {
                    return;
                }
                this.pending_shortcut = null;
                const length = this.send(text);
                if(length)
                {
                    this.report("v86-clipboard-paste", {
                        length,
                        source: "clipboard-api",
                    });
                }
            }, 0);
        }, error => {
            if(this.destroyed || this.pending_shortcut !== pending)
            {
                return;
            }
            this.pending_shortcut = null;
            this.report("v86-clipboard-error", { error });
        });
    };

    /** @param {!Event} event */
    this.paste_handler = event => {
        const clipboard_event = /** @type {!ClipboardEvent} */ (event);
        const text = clipboard_event.clipboardData &&
            clipboard_event.clipboardData.getData("text/plain");
        if(text)
        {
            this.pending_shortcut = null;
            const length = this.send(text);
            if(length)
            {
                clipboard_event.preventDefault();
                this.report("v86-clipboard-paste", {
                    length,
                    source: "paste-event",
                });
            }
        }
    };

    target.addEventListener("pointerdown", this.pointerdown_handler, false);
    target.addEventListener("keydown", this.keydown_handler, false);
    target.addEventListener("paste", this.paste_handler, false);
}

ClipboardAdapter.prototype.report = function(type, detail)
{
    let event;
    if(typeof globalThis.CustomEvent === "function")
    {
        event = new globalThis.CustomEvent(type, { detail });
    }
    else
    {
        event = new globalThis.Event(type);
        Object.defineProperty(event, "detail", { value: detail });
    }
    this.target.dispatchEvent(event);
};

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
    this.pending_shortcut = null;
    this.target.removeEventListener("pointerdown", this.pointerdown_handler, false);
    this.target.removeEventListener("keydown", this.keydown_handler, false);
    this.target.removeEventListener("paste", this.paste_handler, false);
};
