# Workbench v2 verification

## Exercised
- Related backend suites: 188 passed, 2 skipped (workbench, evidence/search, harness, trends, persona).
- Frontend: 199 passed; production build succeeded (bundle-size warning remains).
- Real local browser: selected BK Skill and an authorized local excerpt; saved brief and viewed actual citation text.
- Real Codex turn: completed a spoken draft and a separate internal evidence table; correctly treated the selected philosophical text as insufficient evidence for psychological claims.
- Browser retrieved only the marked public body, saved an immutable version and loaded that version back. Version evidence SHA matched the selected excerpt snapshot.
- A subsequent real turn kept the same native Codex thread and proposed a specific wording correction without losing evidence boundaries.

## Review regressions fixed
- A web-search event no longer validates arbitrary model-proposed URLs or dates. Each URL requires structured tool provenance or an independent public HTTP read; private/credential URLs and private redirects are rejected. Unknown dates remain unknown.
- Direct version save pins its task, so refreshing recommendations cannot orphan history.
- Task storage is a list; web-tool policy lookup iterates the actual storage shape.

## Scope and limitations
No account login, message sending, formal publication or WeChat draft delivery was performed. These require the user's account and approval. This release does not claim independent expert review of generated claims.

The entire repository test suite is not green in this local environment: two media modules could not collect because Python 3.11 cannot load the system Python 3.14 NumPy binary. After excluding those modules, 2054 passed, 40 failed, 28 skipped. Failures include QR/media dependencies, installation checks and publishing tests affected by local manual-publish configuration. Dependencies were not installed and publishing safeguards were not loosened to make tests pass. The related suites above were run separately and passed.

## Correct local startup
Run from the personal repository root, reusing the installed environment:

    EASEL_PORT=7860 /Users/51pp/Easel/.venv/bin/python -m web.app

Using the module entrypoint ensures the personal checkout is first on Python's import path, rather than an older editable installation. Local outputs, profiles, environment secrets and browser state are not part of the commit.
