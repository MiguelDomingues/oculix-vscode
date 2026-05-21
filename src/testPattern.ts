import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChildProcess, execSync, spawn } from 'child_process';
import { resolveImagePath } from './pathResolver';

export type TestPatternRequest = {
  filename: string;
  similarity: number;
};

export type TestPatternResult = { apply: false } | { apply: true; value: number };

// Tracks the currently-running test overlay so a new request can replace it.
let activeProc: ChildProcess | null = null;

export async function runPatternTest(
  docUri: vscode.Uri,
  req: TestPatternRequest
): Promise<TestPatternResult> {
  // Replace any in-flight test overlay so only the latest click wins.
  if (activeProc) {
    try { activeProc.kill(); } catch { /* already exited */ }
    activeProc = null;
  }

  const imagePath = resolveImagePath(docUri, req.filename);
  if (!imagePath || !fs.existsSync(imagePath)) {
    vscode.window.showErrorMessage(`OculiX Test: image not found — ${req.filename}`);
    return { apply: false };
  }

  const python = detectPython();
  if (!python) {
    vscode.window.showErrorMessage(
      'OculiX Test: Python 3 not found on PATH. Install Python 3 and try again.'
    );
    return { apply: false };
  }

  const missing = checkPythonDeps(python, ['mss', 'opencv-python']);
  if (missing.length > 0) {
    const choice = await vscode.window.showInformationMessage(
      `OculiX Test mode needs ${missing.join(', ')}. Install now?`,
      'Install', 'Cancel'
    );
    if (choice !== 'Install') {
      return { apply: false };
    }
    const installed = await installPackages(python, missing);
    if (!installed) {
      vscode.window.showErrorMessage(
        `Failed to install. Run manually: ${python} -m pip install ${missing.join(' ')}`
      );
      return { apply: false };
    }
  }

  const helperPath = path.join(os.tmpdir(), 'oculix_test_pattern.py');
  fs.writeFileSync(helperPath, TEST_PATTERN_HELPER_SCRIPT);

  return new Promise((resolve) => {
    const proc = spawn(python, [helperPath, imagePath, String(req.similarity)]);
    activeProc = proc;

    // Progress notification covers the analysis phase only — the Python helper
    // prints "ready" to stdout once matchTemplate completes, and the overlay
    // takes over from there.
    let resolveReady: () => void = () => { /* set below */ };
    const readyPromise = new Promise<void>((res) => { resolveReady = res; });
    let readySignalled = false;
    const signalReady = () => {
      if (readySignalled) return;
      readySignalled = true;
      resolveReady();
    };
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'OculiX: analyzing screen for pattern…',
        cancellable: false,
      },
      () => readyPromise
    );

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      if (!readySignalled && stdout.includes('ready')) {
        signalReady();
      }
    });
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      // Ensure the progress is dismissed even if the helper died before signalling.
      signalReady();
      // If a newer request has replaced us, activeProc no longer points here.
      // In that case the non-zero exit code is just our own kill signal, not an
      // error — resolve silently as a cancel.
      const wasReplaced = activeProc !== proc;
      if (!wasReplaced) {
        activeProc = null;
      }
      if (wasReplaced) {
        return resolve({ apply: false });
      }

      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-3).join('\n');
        vscode.window.showErrorMessage(`OculiX Test failed (exit ${code}): ${tail.slice(0, 300)}`);
        return resolve({ apply: false });
      }
      // The helper prints "ready" first (loading signal), then "apply <v>" or
      // "cancel" on exit. Parse the LAST non-empty line for the final verdict.
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const last = lines.length > 0 ? lines[lines.length - 1] : '';
      if (last.startsWith('apply ')) {
        const value = parseFloat(last.slice('apply '.length));
        if (Number.isFinite(value)) {
          return resolve({ apply: true, value });
        }
      }
      resolve({ apply: false });
    });
  });
}

async function installPackages(python: string, packages: string[]): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Installing ${packages.join(', ')}...`,
      },
      async () => {
        execSync(`${python} -m pip install ${packages.join(' ')}`, { stdio: 'pipe' });
      }
    );
    return true;
  } catch {
    return false;
  }
}

function detectPython(): string | null {
  for (const cmd of ['python3', 'python']) {
    try {
      const out = execSync(`${cmd} --version`, { stdio: 'pipe' }).toString();
      if (out.includes('Python 3')) {
        return cmd;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function checkPythonDeps(python: string, packages: string[]): string[] {
  const importNames: Record<string, string> = {
    'opencv-python': 'cv2',
    'Pillow': 'PIL',
  };
  const missing: string[] = [];
  for (const pkg of packages) {
    const importName = importNames[pkg] || pkg;
    try {
      execSync(`${python} -c "import ${importName}"`, { stdio: 'pipe' });
    } catch {
      missing.push(pkg);
    }
  }
  return missing;
}

// Embedded Python helper. Captures the full virtual screen, computes a
// cv2.matchTemplate(TM_CCOEFF_NORMED) score map once, then re-filters on each
// scroll-driven threshold change. Writes "apply <value>" or "cancel" to stdout.
const TEST_PATTERN_HELPER_SCRIPT = `
import sys, os, time

if sys.platform == 'win32':
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            windll.user32.SetProcessDPIAware()
        except Exception:
            pass

import tkinter as tk
import mss
import cv2
import numpy as np

PATTERN_PATH = sys.argv[1]
INITIAL_SIM = float(sys.argv[2])

# Get out of the way of the screen capture: minimize whatever window is in the
# foreground at this point (VS Code, since the user just clicked from its
# webview). Restored after the overlay closes.
saved_hwnd = 0
def _user32():
    import ctypes
    return ctypes.windll.user32

def minimize_foreground():
    global saved_hwnd
    if sys.platform != 'win32':
        return
    u = _user32()
    saved_hwnd = u.GetForegroundWindow()
    if saved_hwnd:
        SW_MINIMIZE = 6
        u.ShowWindow(saved_hwnd, SW_MINIMIZE)
        # Brief pause so the minimize animation finishes before we capture.
        time.sleep(0.25)

def restore_foreground():
    if sys.platform != 'win32' or not saved_hwnd:
        return
    u = _user32()
    SW_RESTORE = 9
    u.ShowWindow(saved_hwnd, SW_RESTORE)
    u.SetForegroundWindow(saved_hwnd)

minimize_foreground()

with mss.mss() as sct:
    monitors = sct.monitors
    virtual = monitors[0]
    V_LEFT = virtual['left']
    V_TOP = virtual['top']
    V_WIDTH = virtual['width']
    V_HEIGHT = virtual['height']
    # mss orders individual monitors starting at index 1; the first is the primary.
    primary = monitors[1] if len(monitors) > 1 else virtual
    P_LEFT = primary['left'] - V_LEFT
    P_TOP = primary['top'] - V_TOP
    P_WIDTH = primary['width']
    sct_img = sct.grab(virtual)

screen = np.array(sct_img)
screen_bgr = cv2.cvtColor(screen, cv2.COLOR_BGRA2BGR)

pattern = cv2.imread(PATTERN_PATH, cv2.IMREAD_COLOR)
if pattern is None:
    print("error: could not load pattern", file=sys.stderr)
    sys.exit(2)

PH, PW = pattern.shape[:2]
if PH > V_HEIGHT or PW > V_WIDTH:
    print("error: pattern is larger than the virtual screen", file=sys.stderr)
    sys.exit(2)

result = cv2.matchTemplate(screen_bgr, pattern, cv2.TM_CCOEFF_NORMED)
RH, RW = result.shape

# Signal the extension that the slow analysis phase is done and the overlay
# is about to render. The TS side dismisses its progress notification on this.
print("ready", flush=True)

def find_matches(threshold, max_matches=50):
    work = result.copy()
    matches = []
    while len(matches) < max_matches:
        _, max_val, _, max_loc = cv2.minMaxLoc(work)
        if max_val < threshold:
            break
        x, y = max_loc
        matches.append((x, y, float(max_val)))
        y1 = max(0, y - PH // 2)
        y2 = min(RH, y + PH // 2)
        x1 = max(0, x - PW // 2)
        x2 = min(RW, x + PW // 2)
        work[y1:y2, x1:x2] = -1
    return matches

current_threshold = INITIAL_SIM
applied = False

root = tk.Tk()
root.overrideredirect(True)
root.geometry(f"{V_WIDTH}x{V_HEIGHT}+{V_LEFT}+{V_TOP}")
root.attributes('-topmost', True)
root.attributes('-alpha', 0.35)
root.configure(bg='black')

canvas = tk.Canvas(root, bg='black', highlightthickness=0)
canvas.pack(fill=tk.BOTH, expand=True)

status = tk.Label(root, text='', bg='#222', fg='white', font=('Helvetica', 13), padx=14, pady=5)
# Anchor the status label at the top-center of the primary monitor (not the
# virtual screen), so the helper text stays on one display in multi-monitor setups.
status.place(x=P_LEFT + P_WIDTH // 2, y=P_TOP + 24, anchor='n')

def redraw():
    canvas.delete('match')
    matches = find_matches(current_threshold)
    for x, y, score in matches:
        canvas.create_rectangle(x, y, x + PW, y + PH,
                                outline='#ffcc00', width=3, tags='match')
        # Score badge anchored to the top-right of the match rectangle.
        pct = f"{int(round(score * 100))}%"
        text_id = canvas.create_text(
            x + PW - 6, y + 6, anchor='ne', text=pct,
            fill='#ffffff', font=('Helvetica', 11, 'bold'), tags='match'
        )
        bbox = canvas.bbox(text_id)
        if bbox:
            bg_id = canvas.create_rectangle(
                bbox[0] - 5, bbox[1] - 2, bbox[2] + 5, bbox[3] + 2,
                fill='#000000', outline='', tags='match'
            )
            canvas.tag_raise(text_id, bg_id)
    n = len(matches)
    plural = 'matches' if n != 1 else 'match'
    status.config(text=f"similar: {int(round(current_threshold * 100))}%  |  {n} {plural}  |  Scroll: adjust  ·  Shift: fine  ·  Enter: apply  ·  ESC: cancel")

def step_threshold(direction, fine=False):
    global current_threshold
    step = 0.01 if fine else 0.05
    new_val = max(0.0, min(1.0, current_threshold + direction * step))
    current_threshold = round(new_val * 100) / 100
    redraw()

def on_wheel(e):
    direction = 1 if e.delta > 0 else -1
    step_threshold(direction, fine=bool(e.state & 0x1))

def on_wheel_up(e): step_threshold(1)
def on_wheel_down(e): step_threshold(-1)

def on_escape(e):
    root.quit()

def on_enter(e):
    global applied
    applied = True
    root.quit()

root.bind('<Escape>', on_escape)
root.bind('<Return>', on_enter)
root.bind('<KP_Enter>', on_enter)
root.bind('<MouseWheel>', on_wheel)
root.bind('<Button-4>', on_wheel_up)
root.bind('<Button-5>', on_wheel_down)

redraw()

# Force keyboard focus to the overlay. After we minimize VS Code the OS may move
# focus to whatever sat behind it, so tkinter's focus_force alone isn't enough —
# we also use Win32 BringWindowToTop + SetForegroundWindow on the real toplevel
# HWND, and retry a couple of times to outlast any focus shifts triggered by
# the freshly-realized window.
def force_overlay_focus():
    try:
        root.lift()
        root.attributes('-topmost', True)
        root.focus_force()
        root.focus_set()
    except Exception:
        pass
    if sys.platform == 'win32':
        try:
            import ctypes
            user32 = ctypes.windll.user32
            GA_ROOT = 2
            hwnd = user32.GetAncestor(root.winfo_id(), GA_ROOT)
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
        except Exception:
            pass

root.update_idletasks()
force_overlay_focus()
root.after(60, force_overlay_focus)
root.after(200, force_overlay_focus)
root.mainloop()
root.destroy()
restore_foreground()

if applied:
    print(f"apply {current_threshold}")
else:
    print("cancel")
`;
