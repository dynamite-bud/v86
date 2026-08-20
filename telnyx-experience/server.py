#!/usr/bin/env python3

import argparse
import functools
import http.server
import mimetypes
import os
import ssl
from pathlib import Path
from urllib.parse import urlsplit


PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXPERIENCE_PATH = "/telnyx-experience/index.html"
IMMUTABLE_SUFFIXES = (".bin.zst", ".wasm")

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/zstd", ".zst")


class ExperienceRequestHandler(http.server.SimpleHTTPRequestHandler):
    server_version = "TelnyxExperience"

    def do_GET(self):
        if urlsplit(self.path).path == "/":
            query = urlsplit(self.path).query
            self.path = EXPERIENCE_PATH + ("?" + query if query else "")
        super().do_GET()

    def end_headers(self):
        path = urlsplit(self.path).path
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if path == EXPERIENCE_PATH or path.endswith(".html") or path.endswith(".json"):
            self.send_header("Cache-Control", "no-cache")
        elif path.endswith(IMMUTABLE_SUFFIXES) or "-rootfs-flat/" in path:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "public, max-age=3600")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404, "Not found")
        return None


class ExperienceServer(http.server.ThreadingHTTPServer):
    daemon_threads = True


def parse_args():
    parser = argparse.ArgumentParser(description="Serve The Telnyx Experience")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8082")))
    parser.add_argument("--certfile")
    parser.add_argument("--keyfile")
    args = parser.parse_args()
    if bool(args.certfile) != bool(args.keyfile):
        parser.error("--certfile and --keyfile must be supplied together")
    return args


def main():
    args = parse_args()
    handler = functools.partial(ExperienceRequestHandler, directory=PROJECT_ROOT)
    server = ExperienceServer((args.host, args.port), handler)
    scheme = "http"
    if args.certfile:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(args.certfile, args.keyfile)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"

    print(
        "Serving The Telnyx Experience on %s://%s:%d/ (cross-origin isolated)"
        % (scheme, args.host, args.port),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
