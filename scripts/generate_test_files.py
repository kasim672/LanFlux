"""Generate bounded local experiment fixtures; never fabricates network measurements."""

import argparse
import hashlib
import json
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('experiment-files'))
    parser.add_argument('--sizes', type=int, nargs='+', default=[1, 10, 50], metavar='MIB')
    args = parser.parse_args()
    if any(size < 1 or size > 64 for size in args.sizes) or len(set(args.sizes)) != len(args.sizes):
        parser.error('Use distinct sizes between 1 and 64 MiB.')
    args.output.mkdir(parents=True, exist_ok=True)
    paths = [args.output / f'lanflux-{size}MiB.bin' for size in args.sizes]
    manifest = args.output / 'sha256.json'
    if any(path.exists() for path in [*paths, manifest]):
        parser.error('Output files already exist. Choose a fresh output folder to preserve them.')
    records = []
    for size, path in zip(args.sizes, paths):
        digest = hashlib.sha256()
        with path.open('xb') as file:
            for _ in range(size):
                chunk = os.urandom(1024 * 1024)
                file.write(chunk)
                digest.update(chunk)
        record = {'file': path.name, 'size_bytes': size * 1024 * 1024, 'sha256': digest.hexdigest()}
        records.append(record)
        print(f'{path}: {record["size_bytes"]} bytes, SHA-256 {record["sha256"]}')
    with manifest.open('x', encoding='utf-8') as file:
        json.dump(records, file, indent=2)
        file.write('\n')
    print('Fixtures only: perform real browser transfers and export their observations.')


if __name__ == '__main__':
    main()
