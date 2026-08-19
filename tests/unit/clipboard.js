#!/usr/bin/env node

import assert from "node:assert/strict";
import {
    ClipboardAdapter,
    MAX_CLIPBOARD_TEXT_LENGTH,
} from "../../src/browser/clipboard.js";
import { KeyboardAdapter } from "../../src/browser/keyboard.js";

function dispatch_paste(target, text)
{
    const requested_types = [];
    const event = new globalThis.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
        value: {
            getData(type)
            {
                requested_types.push(type);
                return type === "text/plain" ? text : "ignored html";
            },
        },
    });
    target.dispatchEvent(event);
    return { event, requested_types };
}

function dispatch_shortcut(target, modifiers = {})
{
    const event = new globalThis.Event("keydown", { cancelable: true });
    Object.defineProperties(event, {
        code: { value: "KeyV" },
        key: { value: "v" },
        keyCode: { value: 86 },
        ctrlKey: { value: Boolean(modifiers.ctrlKey) },
        metaKey: { value: Boolean(modifiers.metaKey) },
        altKey: { value: false },
        shiftKey: { value: false },
        repeat: { value: false },
    });
    target.dispatchEvent(event);
    return event;
}

const display = new globalThis.EventTarget();
const elsewhere = new globalThis.EventTarget();
const received = [];
const adapter = new ClipboardAdapter(display, text => received.push(text));

const outside = dispatch_paste(elsewhere, "outside");
assert.equal(outside.event.defaultPrevented, false,
    "paste outside the display retains normal browser behavior");
assert.deepEqual(received, []);

const first = dispatch_paste(display, "api key = test-123\nsecond line");
assert.equal(first.event.defaultPrevented, true);
assert.deepEqual(first.requested_types, ["text/plain"]);
assert.deepEqual(received, ["api key = test-123\nsecond line"],
    "display paste sends plain text exactly once");

const empty = dispatch_paste(display, "");
assert.equal(empty.event.defaultPrevented, false,
    "an empty clipboard is not consumed");
assert.equal(received.length, 1);

const oversized = "x".repeat(MAX_CLIPBOARD_TEXT_LENGTH + 17);
const large = dispatch_paste(display, oversized);
assert.equal(large.event.defaultPrevented, true);
assert.equal(received.at(-1).length, MAX_CLIPBOARD_TEXT_LENGTH,
    "clipboard payload is bounded before guest injection");

adapter.destroy();
const after_destroy = dispatch_paste(display, "stale");
assert.equal(after_destroy.event.defaultPrevented, false);
assert.equal(received.length, 2,
    "destroy removes the display listener");

const replacement = new ClipboardAdapter(display, text => received.push(`replacement:${text}`));
const after_replace = dispatch_paste(display, "once");
assert.equal(after_replace.event.defaultPrevented, true);
assert.equal(received.at(-1), "replacement:once",
    "replacement adapter does not accumulate the destroyed listener");
assert.equal(received.length, 3);
replacement.destroy();

const original_navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const shortcut_display = new globalThis.EventTarget();
const shortcut_received = [];
const shortcut_reports = [];
const shortcut_errors = [];
let focus_calls = 0;
shortcut_display.focus = () => focus_calls++;
shortcut_display.addEventListener("v86-clipboard-paste",
    event => shortcut_reports.push(event.detail));
shortcut_display.addEventListener("v86-clipboard-error",
    event => shortcut_errors.push(event.detail.error));
const shortcut_adapter = new ClipboardAdapter(
    shortcut_display, text => shortcut_received.push(text));
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
try
{
    shortcut_display.dispatchEvent(new globalThis.Event("pointerdown"));
    assert.equal(focus_calls, 1,
        "clicking the canvas focuses its display-scoped clipboard target");

    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            clipboard: {
                readText: async () => "shortcut paste",
            },
        },
    });
    dispatch_shortcut(shortcut_display, { metaKey: true });
    await settle();
    assert.deepEqual(shortcut_received, ["shortcut paste"],
        "focused Cmd+V reads and injects Clipboard API text");
    assert.deepEqual(shortcut_reports.at(-1), {
        length: 14,
        source: "clipboard-api",
    });

    let resolve_read;
    globalThis.navigator.clipboard.readText =
        () => new Promise(resolve => resolve_read = resolve);
    dispatch_shortcut(shortcut_display, { ctrlKey: true });
    const native = dispatch_paste(shortcut_display, "native paste");
    resolve_read("duplicate API paste");
    await settle();
    assert.equal(native.event.defaultPrevented, true);
    assert.deepEqual(shortcut_received, ["shortcut paste", "native paste"],
        "a native paste event cancels the pending Clipboard API fallback");
    assert.deepEqual(shortcut_reports.at(-1), {
        length: 12,
        source: "paste-event",
    });

    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    globalThis.navigator.clipboard.readText = async () => { throw denied; };
    dispatch_shortcut(shortcut_display, { metaKey: true });
    await settle();
    assert.deepEqual(shortcut_errors, [denied],
        "Clipboard API denial is reported without guest injection");
    assert.deepEqual(shortcut_received, ["shortcut paste", "native paste"]);
}
finally
{
    shortcut_adapter.destroy();
    if(original_navigator)
    {
        Object.defineProperty(globalThis, "navigator", original_navigator);
    }
    else
    {
        delete globalThis.navigator;
    }
}

console.log("clipboard adapter tests passed");

const original_window = globalThis.window;
let keyboard;
try
{
    const keyboard_window = new globalThis.EventTarget();
    keyboard_window.nodeName = "DIV";
    keyboard_window.classList = { contains: () => false };
    keyboard_window.contains = target => target === keyboard_window;
    globalThis.window = keyboard_window;

    const keyboard_codes = [];
    keyboard = new KeyboardAdapter({
        send(name, code)
        {
            if(name === "keyboard-code") keyboard_codes.push(code);
        },
    }, keyboard_window);

    function dispatch_key(type, code, key_code, modifiers = {})
    {
        const event = new globalThis.Event(type, { cancelable: true });
        Object.defineProperties(event, {
            code: { value: code },
            key: { value: code },
            keyCode: { value: key_code },
            ctrlKey: { value: Boolean(modifiers.ctrlKey) },
            metaKey: { value: Boolean(modifiers.metaKey) },
            altKey: { value: false },
            shiftKey: { value: false },
            repeat: { value: false },
        });
        keyboard_window.dispatchEvent(event);
        return event;
    }

    const control_down = dispatch_key("keydown", "ControlLeft", 17, { ctrlKey: true });
    assert.equal(control_down.defaultPrevented, true);
    const paste_down = dispatch_key("keydown", "KeyV", 86, { ctrlKey: true });
    assert.equal(paste_down.defaultPrevented, false,
        "display Ctrl+V remains available to the browser clipboard");
    assert.deepEqual(keyboard_codes, [0x1D],
        "the paste shortcut does not send KeyV to the guest");

    keyboard.release_keys();
    assert.deepEqual(keyboard_codes, [0x1D, 0x9D],
        "clipboard injection releases the held guest modifier");
    const paste_up = dispatch_key("keyup", "KeyV", 86, { ctrlKey: true });
    assert.equal(paste_up.defaultPrevented, false);
    assert.deepEqual(keyboard_codes, [0x1D, 0x9D]);

    const normal_key = dispatch_key("keydown", "KeyA", 65);
    assert.equal(normal_key.defaultPrevented, true,
        "ordinary display keys still belong to the emulator");
    assert.equal(keyboard_codes.at(-1), 0x1E);
}
finally
{
    keyboard?.destroy();
    if(original_window === undefined)
    {
        delete globalThis.window;
    }
    else
    {
        globalThis.window = original_window;
    }
}
