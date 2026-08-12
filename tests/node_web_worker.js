import { resolveObjectURL as resolve_object_url } from "node:buffer";
import { Worker as NodeWorker } from "node:worker_threads";

export function install_node_web_worker()
{
    if(typeof globalThis.Worker !== "undefined")
    {
        return;
    }

    globalThis.Worker = class
    {
        constructor(url)
        {
            const blob = resolve_object_url(url);
            if(!blob)
            {
                throw new TypeError(`Unknown worker object URL: ${url}`);
            }
            this.listeners = new Set();
            this.worker = null;
            this.ready = blob.text().then(source => {
                const bridge = `
                    const { parentPort } = require("node:worker_threads");
                    const pending = [];
                    globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
                    parentPort.on("message", data => {
                        if(typeof globalThis.onmessage === "function") globalThis.onmessage({ data });
                        else pending.push(data);
                    });
                    queueMicrotask(() => {
                        while(pending.length) globalThis.onmessage({ data: pending.shift() });
                    });
                `;
                const worker = new NodeWorker(bridge + source, { eval: true });
                worker.on("message", data => {
                    for(const listener of this.listeners) listener({ data });
                });
                worker.on("error", error => {
                    setTimeout(() => { throw error; }, 0);
                });
                worker.unref();
                this.worker = worker;
                return worker;
            });
        }

        postMessage(data, transfer = [])
        {
            this.ready.then(worker => worker.postMessage(data, transfer));
        }

        addEventListener(name, listener)
        {
            if(name === "message") this.listeners.add(listener);
        }

        removeEventListener(name, listener)
        {
            if(name === "message") this.listeners.delete(listener);
        }

        terminate()
        {
            return this.ready.then(worker => worker.terminate());
        }
    };
}
