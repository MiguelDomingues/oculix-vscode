# Copilot Instructions for This Repository

This repository is a VS Code extension for authoring OculiX Python scripts.

## Working Style

- Keep changes minimal and local to the feature being touched.
- When guidance conflicts, use this precedence: security and safety constraints, runtime/helper contract compatibility, explicit repo constraints, then minimal/local change preferences.
- Preserve existing command IDs, configuration keys, activation events, and webview view types unless the task explicitly requires changing them.
- Prefer the current extension patterns over introducing new abstractions.
- Avoid unrelated refactors while fixing feature behavior.
- Prefer fixing root causes over adding defensive clutter or narrow patches.
- When touching a file, fix new errors or warnings introduced by the change before finishing.
- When fixing diagnostics or warnings, start from current Problems, address one coherent error group at a time, and re-check diagnostics after each focused fix.
- When asked to add repo guidance, prefer facts verified in code over assumptions or vague best practices.
- When expanding repo guidance, place rules in the most specific section and avoid duplicating the same requirement across sections.
- When changing or adding user-facing status text, propose one message at a time and explain the underlying behavior first.
- Treat test-pattern and capture progress as related UX surfaces that should stay aligned when possible.
- Treat documentation as part of the feature: when behavior, UX, commands, settings, requirements, limits, or feature/capability status change, review and update affected repo docs (including `README.md`) in the same change.
- When adding features, avoid hard-coded values. Decide whether each value should be extension-configurable; if yes, ask the user for confirmation before adding a new setting. If user confirmation is unavailable, keep a named constant (not an inline literal) and record a follow-up recommendation instead of adding a setting unilaterally. If no, use a named constant (not an inline literal) and keep it close to the owning feature.
- Prefer plain ASCII punctuation in status strings unless the user asks otherwise.

## Project Shape

- TypeScript in `src/` owns extension activation, commands, preview behavior, hover/completion, and cleanup logic.
- Python helpers in `resources/helpers/` are part of the runtime contract for capture and screen-analysis workflows.
- `package.json` is the source of truth for commands, settings, activation events, and extension metadata.

## Repo-Specific Constraints

- For this repo, treat webview restore, activation behavior, helper execution, and path handling as first-class constraints, not secondary details.
- Treat Windows, macOS, and Linux as first-class supported platforms when designing or changing user-facing workflows.
- Maintain the preview panel as a singleton that updates from the currently active Python editor, and preserve its restorable state across VS Code reloads and restarts.
- Preserve preview restore behavior. The preview panel uses `registerWebviewPanelSerializer`, the `oculixPreview` view type, and the `onWebviewPanel:oculixPreview` activation event.
- When implementing or updating custom webviews, keep their UX aligned with native VS Code previews by using the `Preview <filename>` title pattern and keeping the webview icon aligned with the associated command icon.
- If editing webview options, remember that `retainContextWhenHidden` belongs on `createWebviewPanel` options, not `panel.webview.options`.
- Keep image-folder resolution logic aligned across capture and cleanup flows. `resolveImageDir` behavior in `src/extension.ts` and `src/imageCleanup.ts` should stay consistent.
- If you change capture behavior, check the TypeScript caller and the Python helper contract together. The extension copies bundled helpers from `resources/helpers/` into a temp directory before running them.
- When implementing or modifying desktop-automation features such as capture, input, or screen analysis, use runtime capability detection and platform-specific fallbacks instead of assuming one universal interaction path works on Windows, macOS, and Linux.
- Prefer shared, centralized utilities over reimplementing the same parsing, path-resolution, or workflow logic in multiple features; when similar code appears in more than one place, favor generalizing it into reusable code where that improves consistency and maintainability.
- Keep Python helper CLI arguments and expected outputs backward-compatible unless the caller is updated in the same change.
- Evolve helper contracts additively by default. For breaking helper contract changes, update the TypeScript caller in the same change and document the migration impact in `README.md`.

## Security And Hardening

- Treat all workspace content, file paths, and webview messages as untrusted input.
- Prefer strict validation, normalization, and bounds checks for values crossing the TypeScript/Python boundary.
- Avoid broad filesystem effects. Limit reads, writes, deletes, and helper execution to the minimum scope needed for the feature.
- Be careful with path handling. Preserve workspace-relative behavior and avoid introducing path traversal or accidental writes outside intended directories.
- When invoking Python or other external tools from the extension, prefer argument-based process execution over shell-interpolated command strings so inputs stay constrained and security tooling remains satisfied.
- Do not log raw capture/screen-analysis payloads or other sensitive workspace data. Prefer redacted summaries and scoped diagnostics.
- Do not weaken existing safety behavior for helper execution, dependency checks, temporary-file handling, or webview resource scoping.
- If a change could affect security posture, mention the risk and the hardening choice in the final response.

## VS Code Extension Safety Checks

- Preserve activation behavior and avoid unnecessary startup work in `activate()`.
- Keep disposables, listeners, timers, and panel lifecycle handling correct to avoid leaks or duplicate event registration.
- For webviews, keep `localResourceRoots` tight, preserve serializer support, and avoid adding message flows without clear validation on receipt.
- Prefer VS Code APIs and established extension patterns over ad hoc workarounds that could break across platforms.
- Be cautious with user-visible notifications, progress UI, and editor focus changes; avoid regressions in normal VS Code workflow.

## Validation Expectations

- Check Problems or diagnostics for touched files and fix relevant warnings/errors introduced by the change before finishing.
- If a change affects a high-risk area such as capture, cleanup, preview rendering, or webview messaging, validate that specific behavior, not only the compile step.
- For high-risk changes, run a focused checklist: compile, reload window, verify preview restore after restart, verify singleton preview updates when switching active Python editors, verify helper-failure UX, and verify unsupported-capability fallback UX.

## Validation

- Run `npm run compile` after TypeScript edits.
- When dependency changes are involved, verify that `package.json` and `package-lock.json` stay in sync, and prefer a non-mutating consistency check before making lockfile edits.
- If a change affects preview behavior, serializer behavior, or activation wiring, verify those code paths explicitly instead of relying only on static review.
