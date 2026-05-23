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
const TEST_HELPER_TEMP_PATH = path.join(os.tmpdir(), 'oculix_test_pattern.py');
const SHARED_RUNTIME_TEMP_PATH = path.join(os.tmpdir(), 'oculix_screen_runtime.py');
const BUNDLED_TEST_HELPER_PATH = path.join(
  __dirname,
  '..',
  'resources',
  'helpers',
  'oculix_test_pattern.py'
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

export async function runPatternTest(
  docUri: vscode.Uri,
  req: TestPatternRequest
): Promise<TestPatternResult> {
  let dismissProgress: () => void = () => { /* assigned below */ };
  let reportProgress: (message: string) => void = () => { /* assigned below */ };
  const progressPromise = new Promise<void>((resolve) => {
    dismissProgress = resolve;
  });
  void vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'OculiX: Preparing test mode...',
      cancellable: false,
    },
    async (progress) => {
      reportProgress = (message: string) => {
        progress.report({ message });
      };
      reportProgress('Initializing...');
      await progressPromise;
    }
  );

  const finish = (result: TestPatternResult): TestPatternResult => {
    dismissProgress();
    return result;
  };

  // Replace any in-flight test overlay so only the latest click wins.
  if (activeProc) {
    try { activeProc.kill(); } catch { /* already exited */ }
    activeProc = null;
  }

  reportProgress('Retrieving image...');
  const imagePath = resolveImagePath(docUri, req.filename);
  if (!imagePath || !fs.existsSync(imagePath)) {
    vscode.window.showErrorMessage(`OculiX Test: image not found — ${req.filename}`);
    return finish({ apply: false });
  }

  reportProgress('Verifying Python 3 installation...');
  const python = detectPython();
  if (!python) {
    vscode.window.showErrorMessage(
      'OculiX Test: Python 3 not found on PATH. Install Python 3 and try again.'
    );
    return finish({ apply: false });
  }

  reportProgress('Checking dependencies...');
  const missing = checkPythonDeps(python, ['mss', 'opencv-python', 'Pillow']);
  if (missing.length > 0) {
    reportProgress('Waiting for dependency install confirmation...');
    const choice = await vscode.window.showInformationMessage(
      `OculiX Test mode needs ${missing.join(', ')}. Install now?`,
      'Install', 'Cancel'
    );
    if (choice !== 'Install') {
      return finish({ apply: false });
    }
    const installed = await installPackages(python, missing, reportProgress);
    if (!installed) {
      vscode.window.showErrorMessage(
        `Failed to install. Run manually: ${python} -m pip install ${missing.join(' ')}`
      );
      return finish({ apply: false });
    }
  }

  reportProgress('Preparing capture...');
  const helperPath = ensureTestPatternHelperScript();
  if (!helperPath) {
    return finish({ apply: false });
  }

  const config = vscode.workspace.getConfiguration('oculix');
  const overlayDimAlpha = resolveOverlayDimAlpha(config);
  const overlayDimColor = resolveOverlayDimColor(config);

  return new Promise((resolve) => {
    reportProgress('Launching test and adjust mode...');
    const proc = spawn(python, [
      helperPath,
      imagePath,
      String(req.similarity),
      String(overlayDimAlpha),
      overlayDimColor,
    ]);
    activeProc = proc;
    reportProgress('Analyzing screen...');

    // Dismiss the progress as soon as the helper finishes analysis and the
    // interactive overlay is ready.
    let readySignalled = false;
    const signalReady = () => {
      if (readySignalled) {
        return;
      }
      readySignalled = true;
      dismissProgress();
    };

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

async function installPackages(
  python: string,
  packages: string[],
  onStatus?: (message: string) => void
): Promise<boolean> {
  try {
    const status = `Installing dependencies: ${packages.join(', ')}...`;
    onStatus?.(status);
    execSync(`${python} -m pip install ${packages.join(' ')}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function ensureTestPatternHelperScript(): string | null {
  if (!fs.existsSync(BUNDLED_TEST_HELPER_PATH) || !fs.existsSync(BUNDLED_SHARED_RUNTIME_PATH)) {
    vscode.window.showErrorMessage(
      'OculiX Test: bundled helper missing in resources/helpers.'
    );
    return null;
  }

  try {
    const bundled = fs.readFileSync(BUNDLED_TEST_HELPER_PATH, 'utf8');
    const bundledShared = fs.readFileSync(BUNDLED_SHARED_RUNTIME_PATH, 'utf8');
    const hasCurrentTest = fs.existsSync(TEST_HELPER_TEMP_PATH);
    const hasCurrentShared = fs.existsSync(SHARED_RUNTIME_TEMP_PATH);
    if (hasCurrentTest && hasCurrentShared) {
      const current = fs.readFileSync(TEST_HELPER_TEMP_PATH, 'utf8');
      const currentShared = fs.readFileSync(SHARED_RUNTIME_TEMP_PATH, 'utf8');
      if (current === bundled && currentShared === bundledShared) {
        return TEST_HELPER_TEMP_PATH;
      }
    }
    fs.writeFileSync(TEST_HELPER_TEMP_PATH, bundled);
    fs.writeFileSync(SHARED_RUNTIME_TEMP_PATH, bundledShared);
    return TEST_HELPER_TEMP_PATH;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`OculiX Test: could not prepare helper: ${message}`);
    return null;
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
