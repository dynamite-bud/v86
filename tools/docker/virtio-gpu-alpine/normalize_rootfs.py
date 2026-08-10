#!/usr/bin/env python3

import argparse
import tarfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("output")
    args = parser.parse_args()

    with tarfile.open(args.source, "r:*") as source:
        members = sorted(
            (member for member in source.getmembers()
             if member.name not in {".dockerenv", "./.dockerenv"}),
            key=lambda member: member.name,
        )
        with tarfile.open(args.output, "w", format=tarfile.GNU_FORMAT) as output:
            for member in members:
                member.mtime = 0
                member.uid = 0
                member.gid = 0
                member.uname = ""
                member.gname = ""
                member.pax_headers = {}
                fileobj = source.extractfile(
                    member) if member.isfile() else None
                output.addfile(member, fileobj)


if __name__ == "__main__":
    main()
