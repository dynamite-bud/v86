#!/usr/bin/env node

import assert from "node:assert/strict";
import { MouseAdapter } from "../../src/browser/mouse.js";

class TestBus
{
    constructor()
    {
        this.handlers = new Map();
        this.messages = [];
    }

    register(name, handler, context)
    {
        const handlers = this.handlers.get(name) || [];
        handlers.push(handler.bind(context));
        this.handlers.set(name, handlers);
    }

    send(name, data)
    {
        this.messages.push([name, data]);
        for(const handler of this.handlers.get(name) || [])
        {
            handler(data);
        }
    }
}

const original_window = globalThis.window;
const original_document = globalThis.document;
let mouse;

try
{
    const canvas = {
        hidden: false,
        width: 800,
        height: 600,
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 300 }),
    };
    const test_window = new globalThis.EventTarget();
    test_window.parentNode = {};
    test_window.style = {};
    test_window.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 600 });
    test_window.getElementsByTagName = name => name === "canvas" ? [canvas] : [];

    const test_document = new globalThis.EventTarget();
    test_document.pointerLockElement = null;

    globalThis.window = test_window;
    globalThis.document = test_document;

    const bus = new TestBus();
    mouse = new MouseAdapter(bus, test_window);
    bus.send("mouse-enable", true);
    bus.send("emulator-started");

    function move(movement_x, movement_y, client_x, client_y)
    {
        const event = new globalThis.Event("mousemove");
        Object.defineProperties(event, {
            movementX: { value: movement_x },
            movementY: { value: movement_y },
            clientX: { value: client_x },
            clientY: { value: client_y },
        });
        test_window.dispatchEvent(event);
    }

    move(0, 0, 98, 63);
    bus.messages.length = 0;
    move(24, 14, 110, 70);
    assert.deepEqual(
        bus.messages.find(message => message[0] === "mouse-delta"),
        ["mouse-delta", [24, -14]],
        "relative movement is scaled from CSS pixels to guest display pixels");
    assert.deepEqual(
        bus.messages.find(message => message[0] === "mouse-absolute"),
        ["mouse-absolute", [100, 50, 400, 300]],
        "absolute movement uses the visible canvas rather than its taller container");

    bus.send("vmware-absolute-mouse", true);
    bus.messages.length = 0;
    move(12, 7, 110, 70);
    assert.equal(
        bus.messages.some(message => message[0] === "mouse-delta"),
        false,
        "absolute guests do not also receive a PS/2 relative delta");

    bus.send("vmware-absolute-mouse", false);
    test_document.pointerLockElement = test_window;
    bus.messages.length = 0;
    move(4, 3, 110, 70);
    assert.deepEqual(
        bus.messages.find(message => message[0] === "mouse-delta"),
        ["mouse-delta", [8, -6]],
        "pointer lock continues to use unbounded movement deltas");
}
finally
{
    mouse?.destroy();
    if(original_window === undefined)
    {
        delete globalThis.window;
    }
    else
    {
        globalThis.window = original_window;
    }
    if(original_document === undefined)
    {
        delete globalThis.document;
    }
    else
    {
        globalThis.document = original_document;
    }
}

console.log("mouse adapter tests passed");
