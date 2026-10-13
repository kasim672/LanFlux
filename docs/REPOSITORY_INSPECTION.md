# Repository inspection

Inspected before implementation on 2026-10-13: `README.md`, `app.py`, `templates/index.html`, `requirements.txt`, `Pipfile`, `Pipfile.lock`, `.gitignore`, and the local Git directory.

The original application uses FastAPI HTTP upload/download/delete endpoints. `POST /uploadfile/` copies bytes into `uploads/{filename}` on the server; downloads use `FileResponse`. The HTML submits a multipart upload form. There is no WebRTC, WebSocket signaling, RTCPeerConnection, RTCDataChannel, or WebTorrent implementation. The README's P2P/WebTorrent description does not match the implementation. The original filename handling also does not provide a safe foundation for the requested application.

The original root requirements contain many unrelated packages and omit the main FastAPI/Uvicorn packages declared in Pipfile. LANFLUX has separate, minimal runtime requirements and does not use the original Pipenv environment.

Initially, `git status --short` reported “not a git repository”; the supplied `.git` directory appeared empty. No usable branch, commit, remote, or working-tree baseline was available before implementation. During final verification, Git metadata became available: branch `main` had no commits, a LANFLUX remote was configured, and all project files were untracked. The agent did not initialize Git, change its remote, stage files, commit, or push. There is no upstream commit baseline for a normal diff.

No LICENSE/COPYING file was found locally, and no license was displayed in the inspected upstream repository. Original attribution: [alwaz-shahid/P2P-File-Sharing-on-Local-Network](https://github.com/alwaz-shahid/P2P-File-Sharing-on-Local-Network). Do not assume the original source is licensed for public redistribution. No new license was assigned to that source.

`app.py`, `templates/index.html`, `Pipfile`, and `Pipfile.lock` remain in their original locations. Original README and requirements are preserved in `legacy/`. LANFLUX is independently implemented under `lanflux/` and never imports the original `app.py`. Original source/archives are ignored for new commits to prevent accidental redistribution into a new public project; existing tracked upstream files would not be affected by these ignore rules. These originals are excluded from the publication subsequently requested by the user.

Original SHA-256 checksums:

```text
app.py                    4268053319c2774feef0fb8b4538a2bd451b23aebe1732bdf2e289a14ff4786f
templates/index.html      1319dde81faa01c1fc7c3d878cf65f5c0102552e2f2eee45d23bc6c16498b0d1
README.md (preserved)     0e9ef1d4f9ee83c61c57a2fb89114466b091260f5bd43d2a4995de69c1021093
requirements (preserved)  2bbe6da58022cf7828fc4e929b796b65158cff835c6a350020ce9ec283481e3e
```

## v0.2 upgrade safeguard

Before the upgrade, Git was available on unborn `main` with no commits and all LANFLUX files untracked. The working v0.1 implementation was audited and its standard baseline checks passed: 25 Python tests, 10 protocol tests and eight real Chromium scenarios plus their parent test. A source snapshot was saved to `/tmp/lanflux-v01-before-upgrade-20261013.tar.gz`, and work continued on `upgrade/lanflux-v0.2` without staging, resetting, committing, pushing or discarding files.

The upgrade modifies the existing independent LANFLUX implementation. The preserved original `app.py`, template and archives (`legacy/README.original.md`, `legacy/requirements.original.txt`) still match the checksums above. Upstream attribution/licensing limitations remain unchanged. No new public project or general repository license was created.
