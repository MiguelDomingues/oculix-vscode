# OculiX for VS Code

A VS Code extension that brings part of the [OculiX](https://github.com/oculix-org/Oculix) (the rebranded SikuliX) authoring workflow into the editor — region capture, inline image previews, and click-to-set target offsets — for people who write OculiX automation scripts in Python and prefer staying in VS Code.

> ⚠️ **This is not a full replacement for the OculiX IDE.** It focuses on authoring workflows and now includes a basic script runner in VS Code. Advanced IDE-only capabilities (full debugger UX, recorder-first flows, rich image editing) still belong to the OculiX IDE.
>
> 🤖 **Vibe-coded, provided as-is.** This extension was built collaboratively with an AI coding assistant. It works for the workflows it was designed for, but it has not been broadly tested, security-reviewed, or hardened. No warranty, no SLA, no support promises. If something breaks or feels rough, please open an issue, but don't assume it will be fixed quickly.

---

## What it does

OculiX scripts are normally authored in the OculiX IDE, which shows pattern images inline next to the code. But for many teams the rest of the development workflow lives in VS Code: pull-request review, git diffs, branch management, multi-file searches, sharing snippets, jumping in to fix a typo. A script like this:

```python
hover(Pattern("1625708569739.png").similar(.85).targetOffset(-179, 18))
wait("1641594720892.png", 20).click()
```

...is painful to read in a plain text editor because the filenames are opaque hashes. This extension makes OculiX scripts approachable inside VS Code so the existing tooling around your repository — git, code review, search-and-replace, linting workflows — keeps working without losing the visual pattern context. It does so by:

1. **Previewing scripts** in a side panel (like Markdown preview) that replaces image-filename literals with the actual thumbnails — so you can see what each pattern looks like while reviewing a PR or skimming a diff. `Pattern("foo.png").targetOffset(x, y)` collapses to just the image with a crosshair where the target offset lands.
2. **Testing patterns interactively** — click a thumbnail, the extension scans your screen for matches using the same `cv2.matchTemplate` algorithm OculiX uses internally, and lets you adjust the similarity threshold with the scroll wheel. Useful for verifying that a teammate's threshold still holds, or for debugging why a step has stopped matching.
3. **Capturing screen regions** as a convenience for the ad-hoc case where you want to add or replace a pattern without bouncing into the OculiX IDE. The result is a timestamped PNG + a matching `Pattern(...)` snippet at your cursor.

Plus the small things: hover image previews directly in the editor, syntax highlighting for OculiX vocabulary, and an opt-out cleanup of unreferenced PNGs on save.

It also includes run commands for:

1. full script
2. current logical statement from cursor line
3. selected logical statement range

During script execution, you can also use OculiX's default abort key combination to stop the run; the background runtime process captures it (`Alt+Shift+C` on Windows/Linux, `Cmd+Shift+C` on macOS).

---

## Features

### Capture

- **Capture a screen region** (`Ctrl+Shift+S` / `Cmd+Shift+S`) — VS Code minimizes so it isn't part of the screenshot, then a selection overlay spans **all monitors** (DPI-aware). Drag to select; the result is saved as `<timestamp>.png` and inserted as `Pattern("<timestamp>.png").targetOffset(${1:0},${2:0})` at the cursor as a snippet (tab to the offset values). VS Code comes back focused when the capture finishes (or is cancelled with `ESC`).

### Preview panel (the main feature)

- Open with `Ctrl+Shift+V` / `Cmd+Shift+V`, the **preview icon** in the editor title bar, or right-click → `OculiX: Open Preview to the Side`.
- Renders your `.py` as syntax-highlighted code, replacing any `"*.png"` string literal with an actual thumbnail of the image.
  - When wrapped in `Pattern("...")`, the wrapper is hidden so the image stands alone.
  - Outside of `Pattern(...)` (e.g. `wait("foo.png")`, `click("foo.png")`), the image renders inline next to the surrounding code.
- **Live updates** as you edit (250 ms debounce).
- **Cursor sync** — moving the cursor in the editor highlights the corresponding line in the preview and scrolls it into view if off-screen.
- **Click a line** (off-image) to jump the editor cursor to that line.
- **Right-click a thumbnail** to recapture it — replaces the existing PNG on disk in place, keeping all references in your source intact. The preview refreshes automatically.

### Setting target offsets visually

- **Hold `Ctrl` / `⌘` and click on a thumbnail** — the click position becomes the new `.targetOffset(x, y)`, measured in source-image pixels relative to the image center. The crosshair cursor confirms the mode.
- Existing `.targetOffset(...)` calls are replaced in place; missing ones are inserted; bare `"foo.png"` references are wrapped in `Pattern(...)` automatically.
- A red crosshair overlay on the thumbnail shows the current target position. `targetOffset(0, 0)` (the default) is not drawn.

### Setting similarity visually

- A small `XX%` badge in the top-right corner of each thumbnail shows the current `.similar(value)` (rendered as a percentage). It's hidden by default and appears on hover — **except when the value differs from the default `0.7`**, in which case it stays pinned to make non-default thresholds obvious.
- **Scroll wheel over a thumbnail** to adjust similarity (±5% per tick, hold `Shift` for ±1%, `Alt` to snap to nearest 10%). Changes are written to source ~500 ms after the last scroll tick.
- **Click the badge** for a popover with a slider and preset chips (50%, 70%, 80%, 90%, 95%).
- If `.similar(...)` doesn't exist yet, it's inserted; otherwise replaced in place.

### Test mode (cv2.matchTemplate)

- **Click a thumbnail** (no modifier) to enter test mode.
- VS Code minimizes (so it doesn't pollute the screenshot), the extension captures the full virtual screen, runs `cv2.matchTemplate(TM_CCOEFF_NORMED)` — the same OpenCV method OculiX uses internally — and draws yellow rectangles around every match above the current similarity threshold across all monitors.
- **Scroll** to adjust threshold live (same modifiers as the badge). **Enter** writes the new similarity back into your source; **ESC** discards.
- A help bar in the top-center of your primary monitor shows the current threshold and match count.
- First use prompts to `pip install opencv-python` (auto-installed if you agree).

### Editor extras

- **Hover preview** — hover any `"*.png"` literal in the editor to see a tooltip with the image, file size, and resolved path. Detects images even in `wait(...)` / `click(...)` / comments, not just `Pattern(...)`.
- **Syntax highlighting** — TextMate grammar injected into Python adds colors for `Pattern`, `.targetOffset`, `.similar`, `Key.ENTER`, etc. Works alongside your existing Python language support.

### Image hygiene

- **Cleanup unreferenced PNGs on save** (opt-out via setting) — when you save a `.py`, any PNG in the image folder that isn't mentioned **anywhere** in **any** `.py` in the workspace (including comments) is moved to the trash. The reference check is a simple substring scan, so `# the foo.png pattern` keeps it alive. Multi-script project folders are handled correctly because we scan all `.py` files, not just the one being saved.

---

## What this extension does **not** do (vs the OculiX IDE)

This is the honest list of features the official IDE has that this extension intentionally or accidentally lacks:

| Capability | OculiX IDE | This extension |
| --- | --- | --- |
| **Run / debug scripts** | Yes | **Run only** (full script/current line/selection). Full IDE debugger UX remains IDE-first. |
| **In-line images directly in the editor** | Yes | No — VS Code's decoration API can't grow line heights. Inline image rendering happens in a side webview panel instead. |
| **OCR / text recognition (`Text(...)`)** | Yes | Not handled. |
| **App / window management primitives** (`App("...")`, focus/spawn) | Yes | Not handled. |
| **Region drawing on captured images** (`r1`, `r2`, sub-region UI) | Yes | Only target offset + similarity are editable. |
| **Pattern image editing** (crop, mask, scale) | Yes | No editor — you'd recapture from the source. |
| **Image gallery / library panel** | Yes | No |
| **Recapture into an existing pattern slot** | Yes | Yes — right-click a thumbnail in the preview to overwrite the underlying PNG. |
| **`Pattern("...").targetOffset(0,0)` snippet expansion at insert** | n/a | Yes, via the capture flow. |
| **Multi-monitor region capture** | Yes | Yes, on Windows/Linux (DPI aware). macOS: requires screen recording permission for the terminal that launches VS Code. |
| **Side-by-side preview of code with images** | n/a (different model) | Yes — this is the main contribution. |

### Known caveats

- **Test mode minimizes only the foreground VS Code window.** If you have multiple VS Code windows open, the others will appear in the screenshot.
- **Templated patterns** (e.g. `Pattern(some_var)` where the filename is a variable, or f-strings) are not rendered as images — only literal `"*.png"` strings are.
- **Triple-quoted strings** are not tokenized across lines by the preview's syntax highlighter (each line is tokenized independently). Single-line docstrings work; multi-line ones may colorize oddly.
- **Theme matching is approximate.** The preview uses VS Code's CSS variables and Dark+ / Light+ default token colors, not the user's actual TextMate theme tokens (which aren't exposed to webviews). Colors will look "VS Code–like" but not pixel-perfect to a custom theme.
- **Performance.** `cv2.matchTemplate` on a multi-4K virtual screen is typically 50–300 ms. We compute the score map once per test run and re-filter on threshold changes, so adjusting similarity is instant after the initial analysis.

---

## Requirements

- **VS Code** 1.85 or newer.
- **Python 3** on your `PATH`.
- **Java 11+** on your `PATH` (required for script execution).
- **Python packages** — the extension offers to `pip install` these on first use of each feature:
  - `mss` and `Pillow` — region capture.
  - `opencv-python` — test mode (large download; only installed if you actually use test mode).

---

## Quick start

1. Install the extension (build from source for now, see below).
2. Open an existing OculiX `.py` script in VS Code.
3. Press `Ctrl+Shift+V` (or use the preview icon in the editor title bar) — the side panel renders each pattern filename as an actual thumbnail.
4. **Click** a thumbnail to test where it matches on your screen, or **Ctrl+Click** (⌘+Click on Mac) to set its target offset visually.
5. Need to add a brand-new pattern? `Ctrl+Shift+S` captures a region and inserts the `Pattern(...)` snippet — no need to leave for the OculiX IDE.

---

## Usage reference

| Action | Where | Gesture |
| --- | --- | --- |
| Capture a screen region | Editor | `Ctrl+Shift+S` / `Cmd+Shift+S` |
| Run full script | Editor | `Ctrl+Shift+R` / `Cmd+Shift+R` |
| Run current logical statement | Editor | Command Palette / context menu |
| Run selected logical statement range | Editor | Select text + context menu |
| Stop active run | Editor | Status bar `OculiX: Stop` / command palette |
| Recapture an existing pattern (overwrites the PNG in place) | Preview panel | **Right-click** the thumbnail |
| Open preview to the side | Editor | `Ctrl+Shift+V` / `Cmd+Shift+V` (or title-bar icon) |
| Jump editor cursor to a preview line | Preview panel | Click anywhere on the line (off the image) |
| Test where a pattern matches on screen | Preview panel | **Click** the image |
| Set target offset visually | Preview panel | **Ctrl/⌘ + Click** the image |
| Adjust similarity (rough) | Preview panel | Scroll wheel over the image (±5% / tick) |
| Adjust similarity (fine) | Preview panel | `Shift` + scroll (±1% / tick) |
| Snap similarity to 10% | Preview panel | `Alt` + scroll |
| Open similarity slider/presets | Preview panel | Click the `XX%` badge |
| Apply new similarity from test mode | Test overlay | `Enter` |
| Exit test mode without changes | Test overlay | `ESC` |

---

## Configuration

All settings live under **Settings → Extensions → OculiX for VS Code**.

| Setting | Default | Description |
| --- | --- | --- |
| `oculix.imageFolder` | `""` | Folder for saved images, relative to the first workspace folder. Leave empty to save in the same folder as the active script. |
| `oculix.captureHelper` | `"auto"` | Which capture helper to use. Reserved for future native helpers; today `"auto"` and `"python"` are equivalent. |
| `oculix.captureMinimizeDelayMs` | `125` | Delay (ms) after minimizing VS Code before showing the capture overlay. Lower is faster; higher can avoid minimize-animation artifacts in screenshots. Range: 0–2000. |
| `oculix.captureDelaySeconds` | `3` | Countdown duration (seconds) shown at the top-center before the screen is frozen for region selection. Range: 0–30. |
| `oculix.overlayDimPercent` | `60` | Overlay dim amount used during capture and test modes. Higher values dim more. Range: 0–100. |
| `oculix.overlayDimColor` | `"#FFFFFF"` | Overlay tint color used during capture and test modes. |
| `oculix.previewImageHeight` | `200` | Maximum height (px) of each thumbnail in the preview panel. Aspect ratio is preserved. Range: 24–1200. |
| `oculix.cleanupUnreferencedImagesOnSave` | `true` | Move PNGs in the image folder that aren't referenced in any `.py` to the OS trash when you save. Disable if you keep manual images alongside captured ones. |
| `oculix.runtimeMode` | `"auto"` | Runtime resolution mode: `auto` manages runtime versions/downloads, `path` uses a user-provided JAR path. |
| `oculix.runtimeJarPath` | `""` | Path to OculiX runtime JAR when `runtimeMode` is `path`. |
| `oculix.runtimeVersion` | `"latest"` | Runtime version in `auto` mode: `latest` or an explicit version such as `3.0.4`. |
| `oculix.runtimeUpdateCheckOnStartup` | `true` | In `auto + latest`, checks for updates in the background when the extension loads. |
| `oculix.runtimeUpdateCheckIntervalHours` | `24` | Minimum interval between background runtime update checks. |

---

## Running from source

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ (provides `npm`).
- [Python 3](https://www.python.org/downloads/) on your `PATH`.
- VS Code 1.85 or newer.

### First-time setup

**Option A — from VS Code:** open the Command Palette (`Ctrl+Shift+P`) → **Tasks: Run Task** → **Setup**. This runs `npm install`, `pip install mss Pillow`, and `npm run compile` in sequence.

**Option B — from a terminal:**

```bash
npm install
pip install mss Pillow
npm run compile
```

(`opencv-python` is only needed if you use test mode; the extension will prompt to install it on first use.)

### Launching

1. Open this folder in VS Code.
2. Press **F5** (or Run → Start Debugging). A second VS Code window (the Extension Development Host) opens with the extension loaded.
3. In that window, open a `.py` file and try the features.

While developing, run the **`npm: watch`** task (or `npm run watch`) to auto-recompile on save. Reload the Extension Development Host with `Ctrl+R` to pick up changes.

### Bumping the version

Use the included script to update `package.json` and `package-lock.json` in one step:

```bash
npm run bump patch    # 0.1.2 → 0.1.3
npm run bump minor    # 0.1.2 → 0.2.0
npm run bump major    # 0.1.2 → 1.0.0
npm run bump 0.2.1    # explicit version
```

After bumping, commit and tag:

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to 0.1.3"
git tag v0.1.3
git push && git push --tags
```

### Packaging a `.vsix`

```bash
npx @vscode/vsce package --no-dependencies
```

CI builds a `.vsix` on every PR and publishes one as a release asset when a `v*` tag is pushed; see [.github/workflows](.github/workflows).

---

## How it works (architecture)

- **Capture:** a small Python helper script is written to `os.tmpdir()` and executed. On startup the helper grabs the foreground window's HWND, minimizes it (`user32.ShowWindow(SW_MINIMIZE)`), waits ~250 ms for the animation, then opens a borderless `tkinter` overlay spanning the virtual screen across all monitors; on Windows the script opts into per-monitor DPI awareness so `mss` and `tkinter` pixels match. The image is saved with `mss.tools.to_png`, the window is restored (`SW_RESTORE` + `SetForegroundWindow`), and the TS side inserts the snippet. The right-click "recapture" gesture in the preview reuses the same helper with the existing filename, overwriting in place.
- **Preview panel:** a `WebviewPanel` with `localResourceRoots` pointing at the script directory + workspace roots. The webview renders code as `<div class="line">` blocks; a tiny TS-side tokenizer (no Prism/Shiki) categorizes Python tokens for highlighting. Image references are detected at the token level, sized via `webview.asWebviewUri()`, and crosshair positions are computed client-side after each `<img>` fires `load` (using `naturalWidth/Height` vs `clientWidth/Height` to scale source-image offsets into rendered CSS pixels).
- **Source edits** from preview gestures are applied with `vscode.WorkspaceEdit` using exact source-column ranges that are emitted as `data-*` attributes on each rendered image — so clicking image #2 on a line edits only image #2's `.targetOffset` / `.similar` / `Pattern(...)` wrapper, even if the same filename appears multiple times on the same line.
- **Test mode:** a separate Python helper minimizes VS Code via `user32.ShowWindow`, captures the virtual screen with `mss`, runs `cv2.matchTemplate(TM_CCOEFF_NORMED)` once, then opens a borderless tkinter overlay with `-alpha 0.35` background and yellow match rectangles. Scroll/Enter/ESC are handled by tkinter event bindings; final state is printed on stdout for the TS side to apply.
- **Cleanup:** on `onDidSaveTextDocument` for `.py` files, `findFiles('**/*.py')` returns every Python file in the workspace; the extension concatenates their contents (open buffers preferred over disk) and checks substring presence of every `.png` filename in the image folder. Unreferenced ones go to `vscode.workspace.fs.delete(..., { useTrash: true })`.

---

## Contributing

This is an as-is hobby project, but issues and PRs are welcome. Please be patient — review may be slow or non-existent. If you fork it and run with it in a different direction, that's encouraged.

## License

[MIT](LICENSE) — fork it, modify it, ship it commercially, do whatever you like. Just keep the copyright notice.
