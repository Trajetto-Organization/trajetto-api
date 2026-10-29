"""
Build-time only: downloads the weights of the two profiles and checks them
against models.sha256 (ADR 0010: weights fetched in the build, verified by
SHA-256, never on the first boot).

  python fetch_models.py           download + verify (the Dockerfile)
  python fetch_models.py --print   download + print the sha256sum lines,
                                   to (re)write models.sha256 after a
                                   deliberate model change

The check is exact: a file missing, a hash changed or a file nobody listed
(RapidOCR deciding to fetch another model) fails the build.
"""

import hashlib
import sys
from pathlib import Path

import rapidocr

from server import PROFILES, build_engine

MODELS_DIR = Path(rapidocr.__file__).resolve().parent / "models"
MANIFEST = Path(__file__).resolve().parent / "models.sha256"


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            sha.update(chunk)
    return sha.hexdigest()


def model_files():
    # Every file in the folder (the wheel ships the PP-OCRv6 pair and the
    # direction classifier, the build downloads the PP-OCRv5 pair); only
    # the wheel's empty .gitkeep is not a model.
    return sorted(path for path in MODELS_DIR.iterdir() if path.is_file() and not path.name.startswith("."))


def main():
    for profile in PROFILES:
        build_engine(profile, threads=1)

    found = {path.name: digest(path) for path in model_files()}

    if "--print" in sys.argv:
        print(f"# models dir: {MODELS_DIR}")
        for name, sha in sorted(found.items()):
            print(f"{sha}  {name}")
        return

    expected = {}
    for line in MANIFEST.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        sha, name = line.split()
        expected[name] = sha

    problems = []
    for name, sha in expected.items():
        if name not in found:
            problems.append(f"missing: {name}")
        elif found[name] != sha:
            problems.append(f"hash mismatch: {name}")
    for name in found:
        if name not in expected:
            problems.append(f"not in models.sha256: {name}")

    if problems:
        sys.exit("model check failed:\n" + "\n".join(problems))

    print(f"{len(expected)} model files verified in {MODELS_DIR}")


if __name__ == "__main__":
    main()
