#!/usr/bin/env python3

# Serves the repository root like `make run`, but with the COOP/COEP headers
# required for a cross-origin isolated context (SharedArrayBuffer).
# See `make run-isolated`.

import argparse
import functools
import http.server
import os


class COIRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(
        description="Serve the repository root with cross-origin isolation headers")
    parser.add_argument("port", nargs="?", type=int, default=8000,
                        help="port to listen on (default: 8000)")
    args = parser.parse_args()

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(COIRequestHandler, directory=repo_root)
    server = http.server.ThreadingHTTPServer(("", args.port), handler)

    print("Serving %s on http://localhost:%d/ (cross-origin isolated)" % (repo_root, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
