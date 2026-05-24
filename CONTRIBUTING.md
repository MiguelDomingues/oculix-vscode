# Contributing to OculiX for VS Code

Thanks for taking the time to contribute. This project is vibe-coded and provided as-is — contributions that fix real problems or add clearly useful things are welcome.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Python](https://www.python.org/) 3.8+ (for the capture helper)
- VS Code 1.85+

## Setup

```bash
git clone https://github.com/MiguelDomingues/oculix-vscode.git
cd oculix-vscode
npm install
pip install mss Pillow
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## Workflow

1. Fork the repo and create a branch off `main`.
2. Make your changes.
3. Keep changes focused (one fix or feature) and avoid unrelated work.
4. Link related issues in the PR description: bug fixes should use `Fixes #...` / `Closes #...`; features should link the discussion issue.
5. Add a documentation impact note in the PR description, and update affected docs (for example `README.md`) in the same PR when behavior/capability changes.
6. Run `npm run compile` and verify there are no TypeScript errors.
7. Verify manually in the Extension Development Host (`F5`).
8. Open a PR against `main` — the `Build` CI check must pass before merge.

## Guidelines

- Use the PR template and complete its checklist before requesting review.
- Keep `README.md` and related docs aligned with the shipped behavior. If a feature/capability changed status (added, removed, limited, or no longer working), update docs to match the current code.
- There is no test suite currently — manual verification in the Extension Development Host is expected.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) when opening an issue.
