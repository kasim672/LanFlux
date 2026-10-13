"""Audit tracked/indexed release files without echoing credential values.

This is a small publication guard, not a comprehensive secret scanner or a
license grant. It excludes private configuration, generated data and preserved
unlicensed upstream source from the public tree. Text/binary blobs are checked
for high-confidence token/private-key patterns; screenshots still need review.
"""

import argparse
from pathlib import Path, PurePosixPath
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MAX_BLOB_BYTES = 8 * 1024 * 1024
PRIVATE_PARTS = {".git", ".aws", ".ssh", ".codex", ".agents", ".venv", "venv", "node_modules", "__pycache__"}
GENERATED_PARTS = {"output", "uploads", "experiment-files", ".pytest_cache", ".playwright-cli", "htmlcov"}
LEGACY_ROOTS = {"app.py", "templates", "legacy", "Pipfile", "Pipfile.lock"}
SECRET_PATTERNS = (
    ("private key", re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----")),
    ("GitHub token", re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b")),
    ("cloud access key", re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("API token", re.compile(rb"\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{32,}\b")),
    ("local user path", re.compile(rb"/(?:home|Users)/[^/\s]+/|[A-Za-z]:\\Users\\[^\\\s]+\\")),
)


def audit_blob(name: str, mode: str, data: bytes) -> set[str]:
    path = PurePosixPath(name)
    issues = set()
    if path.is_absolute() or ".." in path.parts or mode not in {"100644", "100755"}:
        issues.add("unsupported path or Git file mode")
    if set(path.parts) & PRIVATE_PARTS:
        issues.add("private/dependency directory")
    if set(path.parts) & GENERATED_PARTS:
        issues.add("generated/upload data")
    if path.parts and path.parts[0] in LEGACY_ROOTS:
        issues.add("preserved upstream source")
    if path.name != ".env.example" and (path.name == ".env" or path.name.startswith(".env.")):
        issues.add("private environment file")
    if path.suffix.lower() in {".pem", ".key", ".p12", ".pfx", ".log", ".pyc", ".pkl", ".pickle", ".joblib"}:
        issues.add("private/generated file extension")
    for label, pattern in SECRET_PATTERNS:
        if pattern.search(data) or pattern.search(name.encode("utf-8")):
            issues.add(label)
    if path.name == ".env.example":
        for line in data.decode("utf-8", errors="replace").splitlines():
            if "=" not in line or line.lstrip().startswith("#"):
                continue
            key, value = line.split("=", 1)
            if re.search(r"(?:CREDENTIAL|PASSWORD|SECRET|TOKEN)$", key.strip(), re.I) and value.strip().strip("\"'"):
                issues.add("nonempty credential in environment example")
    return issues


def git(*args: str) -> bytes:
    return subprocess.run(["git", *args], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout


def safe_name(name: str) -> str:
    encoded = name.encode("utf-8")
    for _, pattern in SECRET_PATTERNS:
        encoded = pattern.sub(b"[redacted]", encoded)
    return encoded.decode("utf-8", errors="replace")


def audit() -> tuple[int, list[tuple[str, set[str]]]]:
    records = git("ls-files", "--stage", "-z").split(b"\0")
    checked, failures = 0, []
    for record in records:
        if not record:
            continue
        metadata, encoded_name = record.split(b"\t", 1)
        mode, object_id, stage = metadata.decode("ascii").split()
        name = encoded_name.decode("utf-8", errors="replace")
        if stage != "0":
            failures.append((name, {"unresolved Git conflict"}))
            continue
        checked += 1
        if mode not in {"100644", "100755"}:
            issues = {"unsupported Git file mode"}
        elif int(git("cat-file", "-s", object_id)) > MAX_BLOB_BYTES:
            issues = {"oversized publication blob"}
        else:
            issues = audit_blob(name, mode, git("cat-file", "blob", object_id))
        working = ROOT / name
        if working.is_symlink():
            issues.add("working tree symbolic link")
        elif working.is_file() and working.resolve().is_relative_to(ROOT):
            if working.stat().st_size > MAX_BLOB_BYTES:
                issues.add("oversized working tree file")
            else:
                issues |= audit_blob(name, mode, working.read_bytes())
        if issues:
            failures.append((name, issues))
    return checked, failures


def self_test() -> None:
    assert not audit_blob("lanflux/config.py", "100644", b"credential = os.getenv('VALUE', '')")
    assert not audit_blob(".env.example", "100644", b"LANFLUX_TURN_CREDENTIAL=\n")
    assert "nonempty credential in environment example" in audit_blob(".env.example", "100644", b"LANFLUX_TURN_CREDENTIAL=example\n")
    assert "GitHub token" in audit_blob("sample.py", "100644", b"ghp_" + b"a" * 40)
    assert "private key" in audit_blob("sample.txt", "100644", b"-----BEGIN " + b"PRIVATE KEY-----")
    assert "local user path" in audit_blob("sample.md", "100644", b"/home/" + b"person/private")
    assert "preserved upstream source" in audit_blob("templates/index.html", "100644", b"")
    assert "private environment file" in audit_blob(".env.production", "100644", b"")
    assert "private/dependency directory" in audit_blob(".aws/credentials", "100644", b"")
    assert "generated/upload data" in audit_blob("output/playwright/export.csv", "100644", b"")
    assert "unsupported path or Git file mode" in audit_blob("external-link", "120000", b"target")
    hidden_name = "ghp_" + "a" * 40
    assert "GitHub token" in audit_blob(hidden_name, "100644", b"")
    assert safe_name(hidden_name) == "[redacted]"
    print("Release audit self-checks passed.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="Verify guard rules with local in-memory fixtures")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    try:
        checked, failures = audit()
    except (OSError, subprocess.CalledProcessError, ValueError):
        print("Release audit failed: unable to read a valid Git index.")
        return 1
    for name, issues in failures:
        # Only path/category: matching bytes and credential values never leave the scanner.
        print(f"Blocked release file {safe_name(name)!r}: {', '.join(sorted(issues))}")
    if not checked:
        print("Release audit failed: no indexed files. Stage the intended public tree first.")
        return 1
    if failures:
        print(f"Release audit blocked {len(failures)} of {checked} indexed files.")
        return 1
    print(f"Release audit passed: {checked} indexed files; private/legacy/generated paths and high-confidence secret patterns checked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
