import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync, spawn } from 'child_process';

let cachedPythonCommand: string | null | undefined;
const validatedDepsByPython = new Set<string>();
const CAPTURE_HELPER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oculix-capture-'));
const CAPTURE_HELPER_PATH = path.join(CAPTURE_HELPER_DIR, 'oculix_capture_helper.py');
const SHARED_RUNTIME_PATH = path.join(CAPTURE_HELPER_DIR, 'oculix_screen_runtime.py');
const BUNDLED_CAPTURE_HELPER_PATH = path.join(
  __dirname,
  '..',
  'resources',
  'helpers',
  'oculix_capture_helper.py'
);
const BUNDLED_SHARED_RUNTIME_PATH = path.join(
  __dirname,
  '..',
  'resources',
  'helpers',
  'oculix_screen_runtime.py'
);

function resolveOverlayDimAlpha(config: vscode.WorkspaceConfiguration): number {
  const configuredPercent = config.get<number>('overlayDimPercent', 60);
  const pct = Number.isFinite(configuredPercent)
    ? Math.max(0, Math.min(100, Number(configuredPercent)))
    : 60;
  return Math.round((pct / 100) * 255);
}

function resolveOverlayDimColor(config: vscode.WorkspaceConfiguration): string {
  const configuredColor = config.get<string>('overlayDimColor', '#FFFFFF');
  const candidate = typeof configuredColor === 'string' ? configuredColor.trim() : '';
  return /^#[0-9A-Fa-f]{6}$/.test(candidate) ? candidate.toUpperCase() : '#FFFFFF';
}

/**
 * Captures a screen region and saves to imageDir.
 * If `targetFilename` is provided, the existing file at that name is overwritten
 * (used by the preview's right-click recapture). Otherwise a new timestamped
 * file is created. Returns the saved filename or null on failure.
 */
export async function captureScreen(
  imageDir: string,
  targetFilename?: string,
  onStatus?: (message: string) => void
): Promise<string | null> {
  const filename = targetFilename ?? `${Date.now()}.png`;
  const outputPath = path.join(imageDir, filename);
  const config = vscode.workspace.getConfiguration('oculix');
  const configuredDelayMs = config.get<number>('captureMinimizeDelayMs', 125);
  const minimizeDelayMs = Number.isFinite(configuredDelayMs)
    ? Math.max(0, Math.min(2000, Math.round(configuredDelayMs)))
    : 125;
  const overlayDimAlpha = resolveOverlayDimAlpha(config);
  const overlayDimColor = resolveOverlayDimColor(config);

  onStatus?.('Verifying Python 3 installation...');

  // Copy bundled helper script to a stable temp path and pass runtime args.
  onStatus?.('Preparing capture...');
  if (!ensureCaptureHelperScript()) {
    return null;
  }

  const python = detectPythonCached();
  if (!python) {
    vscode.window.showErrorMessage(
      'OculiX for VS Code: Python not found. Please install Python 3 and ensure it is on your PATH.'
    );
    return null;
  }

  onStatus?.('Checking dependencies...');
  const depsReady = await ensureCaptureDependencies(python, onStatus);
  if (!depsReady) {
    return null;
  }

  return new Promise((resolve) => {
    onStatus?.('Launching capture mode...');
    const proc = spawn(python, [
      CAPTURE_HELPER_PATH,
      outputPath,
      String(minimizeDelayMs),
      String(overlayDimAlpha),
      overlayDimColor,
    ]);
    let stderr = '';

    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        onStatus?.('Capture complete.');
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

function ensureCaptureHelperScript(): boolean {
  if (!fs.existsSync(BUNDLED_CAPTURE_HELPER_PATH) || !fs.existsSync(BUNDLED_SHARED_RUNTIME_PATH)) {
    vscode.window.showErrorMessage(
      `OculiX for VS Code: bundled helper missing in resources/helpers.`
    );
    return false;
  }

  try {
    const bundled = fs.readFileSync(BUNDLED_CAPTURE_HELPER_PATH, 'utf8');
    const bundledShared = fs.readFileSync(BUNDLED_SHARED_RUNTIME_PATH, 'utf8');
    const hasCurrentCapture = fs.existsSync(CAPTURE_HELPER_PATH);
    const hasCurrentShared = fs.existsSync(SHARED_RUNTIME_PATH);
    if (hasCurrentCapture && hasCurrentShared) {
      const current = fs.readFileSync(CAPTURE_HELPER_PATH, 'utf8');
      const currentShared = fs.readFileSync(SHARED_RUNTIME_PATH, 'utf8');
      if (current === bundled && currentShared === bundledShared) {
        return true;
      }
    }
    fs.writeFileSync(CAPTURE_HELPER_PATH, bundled, { mode: 0o600 });
    fs.writeFileSync(SHARED_RUNTIME_PATH, bundledShared, { mode: 0o600 });
    fs.chmodSync(CAPTURE_HELPER_PATH, 0o600);
    fs.chmodSync(SHARED_RUNTIME_PATH, 0o600);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`OculiX for VS Code: could not prepare capture helper: ${message}`);
    return false;
  }
}

async function ensureCaptureDependencies(
  python: string,
  onStatus?: (message: string) => void
): Promise<boolean> {
  if (validatedDepsByPython.has(python)) {
    return true;
  }

  const missing = checkPythonDeps(python);
  if (missing.length === 0) {
    validatedDepsByPython.add(python);
    return true;
  }

  onStatus?.('Waiting for dependency install confirmation...');
  const install = await vscode.window.showErrorMessage(
    `OculiX for VS Code: Missing Python packages: ${missing.join(', ')}`,
    'Install automatically',
    'Cancel'
  );
  if (install !== 'Install automatically') {
    return false;
  }

  try {
    onStatus?.(`Installing dependencies: ${missing.join(', ')}...`);
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
