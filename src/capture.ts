import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync, spawn } from 'child_process';

let cachedPythonCommand: string | null | undefined;
const validatedDepsByPython = new Set<string>();
const CAPTURE_HELPER_PATH = path.join(os.tmpdir(), 'oculix_capture_helper.py');

/**
 * Captures a screen region and saves to imageDir.
 * If `targetFilename` is provided, the existing file at that name is overwritten
 * (used by the preview's right-click recapture). Otherwise a new timestamped
 * file is created. Returns the saved filename or null on failure.
 */
export async function captureScreen(
  imageDir: string,
  targetFilename?: string
): Promise<string | null> {
  const filename = targetFilename ?? `${Date.now()}.png`;
  const outputPath = path.join(imageDir, filename);
  const config = vscode.workspace.getConfiguration('oculix');
  const configuredDelayMs = config.get<number>('captureMinimizeDelayMs', 125);
  const minimizeDelayMs = Number.isFinite(configuredDelayMs)
    ? Math.max(0, Math.min(2000, Math.round(configuredDelayMs)))
    : 125;

  // Keep a stable helper script on disk and pass output path as argv.
  ensureCaptureHelperScript();

  const python = detectPythonCached();
  if (!python) {
    vscode.window.showErrorMessage(
      'OculiX for VS Code: Python not found. Please install Python 3 and ensure it is on your PATH.'
    );
    return null;
  }

  const depsReady = await ensureCaptureDependencies(python);
  if (!depsReady) {
    return null;
  }

  return new Promise((resolve) => {
    const proc = spawn(python, [CAPTURE_HELPER_PATH, outputPath, String(minimizeDelayMs)]);
    let stderr = '';

    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(filename);
      } else {
        vscode.window.showErrorMessage(
          `OculiX capture failed (exit ${code}): ${stderr.slice(0, 200)}`
        );
        resolve(null);
      }
    });
  });
}

/**
 * Builds the Python capture helper script content.
 * Opens a transparent fullscreen overlay using tkinter so the user can drag
 * to select a region across any monitor.
 */
function buildPythonHelper(): string {
  return `
import sys, time

if len(sys.argv) < 2:
    print("missing output path", file=sys.stderr)
    exit(2)

OUTPUT_PATH = sys.argv[1]
try:
  MINIMIZE_DELAY_MS = float(sys.argv[2]) if len(sys.argv) >= 3 else 125.0
except Exception:
  MINIMIZE_DELAY_MS = 125.0
if MINIMIZE_DELAY_MS < 0:
  MINIMIZE_DELAY_MS = 0.0
if MINIMIZE_DELAY_MS > 2000:
  MINIMIZE_DELAY_MS = 2000.0

# On Windows, opt into per-monitor DPI awareness BEFORE importing tkinter so the
# overlay window and mss share the same pixel coordinate space.
if sys.platform == 'win32':
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            windll.user32.SetProcessDPIAware()
        except Exception:
            pass

# Get VS Code out of the way of the selection overlay and the screenshot.
# Restored at the end so the user lands back in VS Code after capture.
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
        u.ShowWindow(saved_hwnd, 6)  # SW_MINIMIZE
    # Delay is configurable from VS Code settings.
    time.sleep(MINIMIZE_DELAY_MS / 1000.0)

def restore_foreground():
    if sys.platform != 'win32' or not saved_hwnd:
        return
    u = _user32()
    u.ShowWindow(saved_hwnd, 9)  # SW_RESTORE
    u.SetForegroundWindow(saved_hwnd)

minimize_foreground()

import tkinter as tk
import mss
import mss.tools

# Discover the virtual screen — union bounding box across all monitors.
# mss.monitors[0] is that union; monitors[1..] are individual displays.
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

start_x = start_y = end_x = end_y = 0
selecting = False
rect_id = None

root = tk.Tk()
# overrideredirect + explicit geometry positions a borderless window across all
# monitors. The -fullscreen attribute, by contrast, snaps to the primary display.
root.overrideredirect(True)
root.geometry(f"{V_WIDTH}x{V_HEIGHT}+{V_LEFT}+{V_TOP}")
root.attributes('-alpha', 0.25)
root.attributes('-topmost', True)
root.configure(bg='black')

canvas = tk.Canvas(root, cursor='crosshair', bg='black', highlightthickness=0)
canvas.pack(fill=tk.BOTH, expand=True)

label = tk.Label(
    root,
    text='Drag to select region  |  ESC to cancel',
    bg='#222',
    fg='white',
    font=('Helvetica', 14)
)
# Anchor at the primary monitor's top-center (in canvas-local coords), so the
# helper text stays on one display in multi-monitor setups.
label.place(x=P_LEFT + P_WIDTH // 2, y=P_TOP + 24, anchor='n')

def on_press(e):
    global start_x, start_y, selecting, rect_id
    start_x, start_y = e.x, e.y
    selecting = True
    if rect_id:
        canvas.delete(rect_id)
    rect_id = canvas.create_rectangle(start_x, start_y, start_x, start_y,
                                       outline='#00ff00', width=2)

def on_drag(e):
    global rect_id
    if selecting and rect_id:
        canvas.coords(rect_id, start_x, start_y, e.x, e.y)

def on_release(e):
    global end_x, end_y
    end_x, end_y = e.x, e.y
    root.quit()

def on_escape(e):
    global start_x, start_y, end_x, end_y
    start_x = start_y = end_x = end_y = 0
    root.quit()

canvas.bind('<ButtonPress-1>', on_press)
canvas.bind('<B1-Motion>', on_drag)
canvas.bind('<ButtonRelease-1>', on_release)
root.bind('<Escape>', on_escape)

root.focus_force()
root.mainloop()
root.destroy()

if end_x == 0 and end_y == 0:
    restore_foreground()
    print("cancelled")
    exit(1)

x1, x2 = sorted([start_x, end_x])
y1, y2 = sorted([start_y, end_y])

if x2 - x1 < 5 or y2 - y1 < 5:
    restore_foreground()
    print("selection too small")
    exit(1)

# Translate canvas-local coordinates to absolute virtual-screen coordinates.
abs_left = V_LEFT + x1
abs_top = V_TOP + y1
width = x2 - x1
height = y2 - y1

with mss.mss() as sct:
    region = {'top': abs_top, 'left': abs_left, 'width': width, 'height': height}
    sct_img = sct.grab(region)
    mss.tools.to_png(sct_img.rgb, sct_img.size, output=OUTPUT_PATH)

restore_foreground()
print("ok")
`;
}

function ensureCaptureHelperScript(): void {
  const script = buildPythonHelper();
  if (fs.existsSync(CAPTURE_HELPER_PATH)) {
    try {
      const current = fs.readFileSync(CAPTURE_HELPER_PATH, 'utf8');
      if (current === script) {
        return;
      }
    } catch {
      // Fall through and rewrite.
    }
  }
  fs.writeFileSync(CAPTURE_HELPER_PATH, script);
}

async function ensureCaptureDependencies(python: string): Promise<boolean> {
  if (validatedDepsByPython.has(python)) {
    return true;
  }

  const missing = checkPythonDeps(python);
  if (missing.length === 0) {
    validatedDepsByPython.add(python);
    return true;
  }

  const install = await vscode.window.showErrorMessage(
    `OculiX for VS Code: Missing Python packages: ${missing.join(', ')}`,
    'Install automatically',
    'Cancel'
  );
  if (install !== 'Install automatically') {
    return false;
  }

  try {
    execSync(`${python} -m pip install ${missing.join(' ')}`, { stdio: 'pipe' });
    validatedDepsByPython.add(python);
    return true;
  } catch {
    vscode.window.showErrorMessage(`Failed to install packages. Run: pip install ${missing.join(' ')}`);
    return false;
  }
}

function detectPythonCached(): string | null {
  if (cachedPythonCommand !== undefined) {
    return cachedPythonCommand;
  }

  for (const cmd of ['python3', 'python']) {
    try {
      const out = execSync(`${cmd} --version`, { stdio: 'pipe' }).toString();
      if (out.includes('Python 3')) {
        cachedPythonCommand = cmd;
        return cachedPythonCommand;
      }
    } catch {
      // try next
    }
  }
  cachedPythonCommand = null;
  return cachedPythonCommand;
}

function checkPythonDeps(python: string): string[] {
  const packages = ['mss', 'Pillow'];
  const missing: string[] = [];
  for (const pkg of packages) {
    try {
      execSync(`${python} -c "import ${pkg === 'Pillow' ? 'PIL' : pkg}"`, { stdio: 'pipe' });
    } catch {
      missing.push(pkg);
    }
  }
  return missing;
}
