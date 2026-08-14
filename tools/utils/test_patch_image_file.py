#!/usr/bin/env python3

import json
import os
import tempfile
import unittest
from pathlib import Path

from patch_image_file import _decode_chunk, _zstd_module, patch_image_file


class PatchImageFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.manifest_path = self.root / "test-fs.json"
        self.chunks_path = self.root / "test-rootfs-flat"
        self.chunks_path.mkdir()
        self.source_path = self.root / "replacement"
        self.manifest = {
            "fsroot": [
                [
                    "etc",
                    0,
                    0,
                    0x4000 | 0o755,
                    0,
                    0,
                    [["config", 3, 0, 0x8000 | 0o644, 0, 0, "old.bin.zst"]],
                ]
            ],
            "version": 3,
            "size": 3,
        }
        self.manifest_path.write_text(
            json.dumps(self.manifest, separators=(",", ":")),
            encoding="utf-8",
        )
        (self.chunks_path / "old.bin.zst").write_bytes(b"old chunk")

    def tearDown(self):
        self.temporary.cleanup()

    def test_patches_compressed_file_and_manifest_size(self):
        self.source_path.write_bytes(b"replacement bytes")

        result = patch_image_file(
            self.manifest_path,
            self.chunks_path,
            "/etc/config",
            self.source_path,
        )

        updated = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        node = updated["fsroot"][0][6][0]
        self.assertEqual(node[1], len(b"replacement bytes"))
        self.assertEqual(node[6], result["new_chunk"])
        self.assertEqual(updated["size"], len(b"replacement bytes"))
        self.assertEqual(
            _decode_chunk((self.chunks_path / result["new_chunk"]).read_bytes(), ".bin.zst"),
            b"replacement bytes",
        )
        self.assertTrue((self.chunks_path / "old.bin.zst").exists())

    def test_reuses_existing_content_addressed_chunk(self):
        self.source_path.write_bytes(b"same bytes")
        first = patch_image_file(
            self.manifest_path,
            self.chunks_path,
            "/etc/config",
            self.source_path,
        )
        second = patch_image_file(
            self.manifest_path,
            self.chunks_path,
            "/etc/config",
            self.source_path,
        )

        self.assertTrue(first["chunk_created"])
        self.assertFalse(second["chunk_created"])

    def test_decodes_frame_without_content_size(self):
        implementation, module = _zstd_module()
        if implementation != "zstandard":
            self.skipTest("zstandard package is not active")
        encoded = module.ZstdCompressor(write_content_size=False).compress(b"same bytes")

        self.assertEqual(_decode_chunk(encoded, ".bin.zst"), b"same bytes")

    def test_rejects_non_regular_image_path(self):
        self.source_path.write_bytes(b"replacement")

        with self.assertRaisesRegex(ValueError, "not a regular file"):
            patch_image_file(
                self.manifest_path,
                self.chunks_path,
                "/etc",
                self.source_path,
            )


if __name__ == "__main__":
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    unittest.main()
