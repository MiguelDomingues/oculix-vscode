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
3. Run `npm run compile` and verify there are no TypeScript errors.
4. Open a PR against `main` — the `Build` CI check must pass before merge.

## Guidelines

- Keep changes focused — one fix or feature per PR.
- If you're fixing a bug, link the related issue in the PR description.
- If you're adding a feature, open an issue first to discuss it before investing time in an implementation.
- There is no test suite currently — manual verification in the Extension Development Host is expected.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) when opening an issue.
