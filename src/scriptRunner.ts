import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn, spawnSync } from 'child_process';

const GITHUB_API_BASE = 'https://api.github.com/repos/oculix-org/Oculix/releases';
const RUNTIME_DIR_NAME = 'runtime';
const MANIFEST_NAME = 'runtime-manifest.json';
const DEFAULT_INTERVAL_HOURS = 24;

const IMAGE_REF_REGEX = /["']([^"'\n]+\.png)["']/gi;

type RuntimeMode = 'auto' | 'path';
type RunScope = 'script' | 'currentLine' | 'selection';
type RunStatus = 'success' | 'failed' | 'cancelled';

type RuntimeManifest = {
  installed: Record<string, { jarPath: string; sha256: string }>;
  activeVersion?: string;
  lastCheckedAt?: string;
  latestKnownVersion?: string;
};

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type ReleaseResponse = {
  tag_name: string;
  assets: ReleaseAsset[];
};

type ResolvedRuntime = {
  jarPath: string;
  versionLabel: string;
};

type WindowHandle =
  | { platform: 'win32'; hwnd: number }
  | { platform: 'darwin'; appName: string }
  | { platform: 'linux'; windowId: string; tool: 'xdotool' | 'wmctrl' };

export type RunRequest = {
  scope: RunScope;
};

export class OculixScriptRunner {
  private readonly output: vscode.OutputChannel;
  private readonly statusBar: vscode.StatusBarItem;
  private activeProcess: ChildProcess | null = null;
  private activeRunCancelToken = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('OculiX: Run');
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.statusBar.command = 'oculix.stopRun';
    this.statusBar.text = '$(debug-stop) OculiX: Stop';
    this.statusBar.tooltip = 'Stop the active OculiX run';
  }

  dispose(): void {
    this.output.dispose();
    this.statusBar.dispose();
  }

  async run(req: RunRequest): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
      vscode.window.showErrorMessage('Open a Python file to run OculiX scripts.');
      return;
    }

    if (this.activeProcess) {
      const choice = await vscode.window.showWarningMessage(
        'An OculiX run is already active. Stop and start a new run?',
        'Stop and Run',
        'Cancel'
      );
      if (choice !== 'Stop and Run') {
        return;
      }
      this.stop();
    }

    const javaOk = this.validateJava();
    if (!javaOk.ok) {
      vscode.window.showErrorMessage(javaOk.message);
      return;
    }

    const runtime = await this.resolveRuntime();
    if (!runtime) {
      return;
    }

    const materialized = await materializeRunBundle(editor.document, editor.selection, req.scope);
    if (!materialized) {
      return;
    }

    const runId = ++this.activeRunCancelToken;
    this.output.show(true);
    this.output.appendLine(`OculiX run started (${req.scope})`);
    this.output.appendLine(`Runtime: ${runtime.versionLabel}`);
    this.output.appendLine(`Script bundle: ${materialized.bundlePath}`);

    this.statusBar.show();

    await vscode.commands.executeCommand('setContext', 'oculix.isRunning', true);

    const vsCodeWindow = this.minimizeVSCode();

    const javaCommand = process.platform === 'win32' ? javaOk.command.replace(/\bjava$/i, 'javaw') : javaOk.command;
    const args = ['-jar', runtime.jarPath, '-r', materialized.bundlePath];
    const proc = spawn(javaCommand, args, { stdio: 'pipe' });
    this.activeProcess = proc;

    const startedLines = materialized.lineNumbers;
    void vscode.commands.executeCommand('oculix.previewRunEvent', {
      type: 'runStarted',
      lines: startedLines,
    });

    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      this.output.append(chunk.toString());
    });
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      this.output.append(text);
    });

    await new Promise<void>((resolve) => {
      proc.on('close', (code, signal) => {
        const wasReplaced = runId !== this.activeRunCancelToken;
        const status: RunStatus = wasReplaced || signal === 'SIGTERM'
          ? 'cancelled'
          : code === 0
            ? 'success'
            : 'failed';

        if (!wasReplaced) {
          this.activeProcess = null;
          this.statusBar.hide();
          void vscode.commands.executeCommand('setContext', 'oculix.isRunning', false);
        }

        void vscode.commands.executeCommand('oculix.previewRunEvent', {
          type: 'runFinished',
          status,
          lines: startedLines,
        });

      this.restoreVSCode(vsCodeWindow);

        if (status === 'success') {
          this.output.appendLine('\nOculiX run completed successfully.');
        } else if (status === 'cancelled') {
          this.output.appendLine('\nOculiX run cancelled.');
        } else {
          const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
          this.output.appendLine(`\nOculiX run failed (exit ${code ?? 'unknown'}). ${tail}`);
          vscode.window.showErrorMessage('OculiX run failed. See OculiX: Run output for details.');
        }

        resolve();
      });
    });
  }

  stop(): void {
    if (!this.activeProcess) {
      return;
    }
    this.activeRunCancelToken++;
    try {
      this.activeProcess.kill();
    } catch {
      // Process may already be gone.
    }
    this.activeProcess = null;
    this.statusBar.hide();
    void vscode.commands.executeCommand('setContext', 'oculix.isRunning', false);
  }

  async checkForRuntimeUpdatesOnStartup(): Promise<void> {
    const config = vscode.workspace.getConfiguration('oculix');
    const mode = config.get<RuntimeMode>('runtimeMode', 'auto');
    if (mode !== 'auto') {
      return;
    }

    const enabled = config.get<boolean>('runtimeUpdateCheckOnStartup', true);
    if (!enabled) {
      return;
    }

    const hours = Math.max(1, config.get<number>('runtimeUpdateCheckIntervalHours', DEFAULT_INTERVAL_HOURS));
    const manifest = await this.readManifest();

    if (manifest.lastCheckedAt) {
      const last = Date.parse(manifest.lastCheckedAt);
      if (Number.isFinite(last)) {
        const elapsedMs = Date.now() - last;
        if (elapsedMs < hours * 60 * 60 * 1000) {
          return;
        }
      }
    }

    // Fire-and-forget metadata refresh.
    void this.refreshLatestMetadata();
  }

  private detectPython(): string | null {
    for (const cmd of ['python3', 'python']) {
      try {
        const result = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
        if (result.status === 0) {
          return cmd;
        }
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  private minimizeVSCode(): WindowHandle | null {
    if (process.platform === 'win32') {
      return this.minimizeWindows();
    }
    if (process.platform === 'darwin') {
      return this.minimizeMacOS();
    }
    if (process.platform === 'linux') {
      return this.minimizeLinux();
    }
    return null;
  }

  private restoreVSCode(handle: WindowHandle | null): void {
    if (!handle) {
      return;
    }

    if (handle.platform === 'win32') {
      this.restoreWindows(handle.hwnd);
      return;
    }

    if (handle.platform === 'darwin') {
      this.restoreMacOS(handle.appName);
      return;
    }

    this.restoreLinux(handle.windowId, handle.tool);
  }

  private minimizeWindows(): WindowHandle | null {
    const python = this.detectPython();
    if (!python) {
      return null;
    }

    const result = spawnSync(python, [
      '-c',
      'import ctypes; u=ctypes.windll.user32; hwnd=u.GetForegroundWindow(); u.ShowWindow(hwnd,6); print(hwnd)',
    ], { encoding: 'utf8' });
    const hwnd = parseInt((result.stdout || '').trim(), 10);
    return Number.isFinite(hwnd) && hwnd > 0 ? { platform: 'win32', hwnd } : null;
  }

  private restoreWindows(hwnd: number): void {
    const python = this.detectPython();
    if (!python || hwnd === 0) {
      return;
    }

    spawnSync(python, [
      '-c',
      `import ctypes; u=ctypes.windll.user32; u.ShowWindow(${hwnd},9); u.SetForegroundWindow(${hwnd})`,
    ], { encoding: 'utf8' });
  }

  private minimizeMacOS(): WindowHandle | null {
    const appName = this.captureCommandText('osascript', [
      '-e',
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ]);
    if (!appName) {
      return null;
    }

    const minimized = spawnSync('osascript', [
      '-e',
      'tell application "System Events" to keystroke "m" using command down',
    ], { encoding: 'utf8' });

    if (minimized.status !== 0) {
      return null;
    }

    return { platform: 'darwin', appName };
  }

  private restoreMacOS(appName: string): void {
    if (!appName) {
      return;
    }

    spawnSync('osascript', [
      '-e',
      `tell application ${toAppleScriptString(appName)} to activate`,
    ], { encoding: 'utf8' });
  }

  private minimizeLinux(): WindowHandle | null {
    const xdotoolWindowId = this.captureCommandText('xdotool', ['getactivewindow']);
    if (xdotoolWindowId) {
      const result = spawnSync('xdotool', ['windowminimize', xdotoolWindowId], { encoding: 'utf8' });
      if (result.status === 0) {
        return { platform: 'linux', windowId: xdotoolWindowId, tool: 'xdotool' };
      }
    }

    const xpropOutput = this.captureCommandText('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
    const windowId = parseLinuxWindowId(xpropOutput);
    if (!windowId) {
      return null;
    }

    const result = spawnSync('wmctrl', ['-i', '-r', windowId, '-b', 'add,hidden'], { encoding: 'utf8' });
    if (result.status !== 0) {
      return null;
    }

    return { platform: 'linux', windowId, tool: 'wmctrl' };
  }

  private restoreLinux(windowId: string, tool: 'xdotool' | 'wmctrl'): void {
    if (!windowId) {
      return;
    }

    if (tool === 'xdotool') {
      spawnSync('xdotool', ['windowactivate', windowId], { encoding: 'utf8' });
      return;
    }

    spawnSync('wmctrl', ['-i', '-R', windowId], { encoding: 'utf8' });
  }

  private captureCommandText(command: string, args: string[]): string | null {
    try {
      const result = spawnSync(command, args, { encoding: 'utf8' });
      if (result.status !== 0) {
        return null;
      }
      const text = `${result.stdout || ''}`.trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  private validateJava(): { ok: true; command: string } | { ok: false; message: string } {
    const javaCommandCandidates = ['java'];

    for (const command of javaCommandCandidates) {
      try {
        const result = spawnSync(command, ['-version'], { encoding: 'utf8' });
        const out = `${result.stdout || ''}\n${result.stderr || ''}`;
        const major = parseJavaMajor(out);
        if (major >= 11) {
          return { ok: true, command };
        }
        if (major > 0) {
          return {
            ok: false,
            message: `OculiX Run requires Java 11 or newer. Detected Java ${major}. Install Temurin or Zulu and try again.`,
          };
        }
      } catch {
        // Try next candidate.
      }
    }

    return {
      ok: false,
      message: 'Java was not found. Install Java 11+ (Temurin or Zulu) and ensure `java` is on PATH.',
    };
  }

  private async resolveRuntime(): Promise<ResolvedRuntime | null> {
    const config = vscode.workspace.getConfiguration('oculix');
    const mode = config.get<RuntimeMode>('runtimeMode', 'auto');

    if (mode === 'path') {
      const jarPath = (config.get<string>('runtimeJarPath', '') || '').trim();
      if (!jarPath) {
        vscode.window.showErrorMessage('Set oculix.runtimeJarPath when runtime mode is "path".');
        return null;
      }
      if (!fs.existsSync(jarPath)) {
        vscode.window.showErrorMessage(`Configured runtime JAR not found: ${jarPath}`);
        return null;
      }
      return { jarPath, versionLabel: `custom path (${path.basename(jarPath)})` };
    }

    const versionPref = (config.get<string>('runtimeVersion', 'latest') || 'latest').trim();
    if (versionPref.toLowerCase() === 'latest') {
      const manifest = await this.readManifest();
      const knownVersion = manifest.latestKnownVersion;
      if (knownVersion) {
        const installed = manifest.installed[knownVersion];
        if (installed && fs.existsSync(installed.jarPath)) {
          manifest.activeVersion = knownVersion;
          await this.writeManifest(manifest);
          return { jarPath: installed.jarPath, versionLabel: knownVersion };
        }
      }

      const release = await this.fetchRelease('latest');
      if (!release) {
        vscode.window.showErrorMessage('Could not resolve latest OculiX runtime release.');
        return null;
      }
      return this.ensureManagedRuntimeVersion(release);
    }

    const normalized = versionPref.replace(/^v/i, '');
    const manifest = await this.readManifest();
    const installed = manifest.installed[normalized];
    if (installed && fs.existsSync(installed.jarPath)) {
      manifest.activeVersion = normalized;
      await this.writeManifest(manifest);
      return { jarPath: installed.jarPath, versionLabel: normalized };
    }

    const release = await this.fetchRelease(`tags/v${normalized}`);
    if (!release) {
      vscode.window.showErrorMessage(`Could not resolve OculiX release v${normalized}.`);
      return null;
    }
    return this.ensureManagedRuntimeVersion(release);
  }

  private async ensureManagedRuntimeVersion(release: ReleaseResponse): Promise<ResolvedRuntime | null> {
    const version = normalizeTag(release.tag_name);
    const manifest = await this.readManifest();
    const existing = manifest.installed[version];
    if (existing && fs.existsSync(existing.jarPath)) {
      manifest.activeVersion = version;
      manifest.latestKnownVersion = version;
      await this.writeManifest(manifest);
      return { jarPath: existing.jarPath, versionLabel: version };
    }

    const choice = await vscode.window.showInformationMessage(
      `OculiX runtime ${version} is not installed. Download now?`,
      'Download',
      'Cancel'
    );
    if (choice !== 'Download') {
      return null;
    }

    const runtimeDir = await this.getRuntimeDir();
    const osPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
    const jarPattern = new RegExp(`oculixide-.*-${osPlatform}\.jar$`, 'i');
    const shaPattern = new RegExp(`oculixide-.*-${osPlatform}\.jar\.sha256$`, 'i');
    const jarAsset = release.assets.find((asset) => jarPattern.test(asset.name));
    const shaAsset = release.assets.find((asset) => shaPattern.test(asset.name));

    if (!jarAsset) {
      const assetNames = release.assets.length > 0
        ? release.assets.map((a) => a.name).join(', ')
        : '(no assets attached to this release)';
      vscode.window.showErrorMessage(
        `Could not find OculiX runtime JAR for platform "${osPlatform}" in release ${release.tag_name}. ` +
        `Available assets: ${assetNames}`
      );
      return null;
    }

    if (!shaAsset) {
      const unverifiedChoice = await vscode.window.showWarningMessage(
        `Release ${release.tag_name} does not include a SHA256 checksum file for ${jarAsset.name}. ` +
        `The download cannot be verified. Proceed anyway?`,
        'Download anyway',
        'Cancel'
      );
      if (unverifiedChoice !== 'Download anyway') {
        return null;
      }
    }

    if (!isTrustedDownloadUrl(jarAsset.browser_download_url)) {
      vscode.window.showErrorMessage('Blocked runtime download from untrusted host.');
      return null;
    }
    if (shaAsset && !isTrustedDownloadUrl(shaAsset.browser_download_url)) {
      vscode.window.showErrorMessage('Blocked runtime download from untrusted host.');
      return null;
    }

    const jarPath = path.join(runtimeDir, `${version}-${jarAsset.name}`);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `OculiX: Downloading runtime ${version}`,
      },
      async () => {
        await this.downloadFile(jarAsset.browser_download_url, jarPath);
      }
    );

    const actualSha = await sha256File(jarPath);

    if (shaAsset) {
      const expectedSha = (await this.downloadText(shaAsset.browser_download_url)).trim().split(/\s+/)[0].toLowerCase();
      if (actualSha !== expectedSha) {
        try {
          await fsp.unlink(jarPath);
        } catch {
          // Ignore cleanup errors.
        }
        vscode.window.showErrorMessage('Runtime checksum validation failed. Download was discarded.');
        return null;
      }
    }

    manifest.installed[version] = { jarPath, sha256: actualSha };
    manifest.activeVersion = version;
    manifest.latestKnownVersion = version;
    manifest.lastCheckedAt = new Date().toISOString();
    await this.writeManifest(manifest);

    return { jarPath, versionLabel: version };
  }

  private async refreshLatestMetadata(): Promise<void> {
    const release = await this.fetchRelease('latest');
    const manifest = await this.readManifest();

    manifest.lastCheckedAt = new Date().toISOString();
    if (release) {
      const latest = normalizeTag(release.tag_name);
      const previous = manifest.latestKnownVersion;
      manifest.latestKnownVersion = latest;
      await this.writeManifest(manifest);

      if (previous && previous !== latest) {
        this.output.appendLine(`New OculiX runtime available: ${latest} (current known: ${previous})`);
        void vscode.window.showInformationMessage(
          `OculiX runtime ${latest} is available. Update will apply when you run in auto/latest mode and choose download.`
        );
      }
      return;
    }

    await this.writeManifest(manifest);
  }

  private async fetchRelease(suffix: string): Promise<ReleaseResponse | null> {
    const url = `${GITHUB_API_BASE}/${suffix}`;
    try {
      const body = await this.downloadText(url, {
        Accept: 'application/vnd.github+json',
      });
      const parsed = JSON.parse(body) as ReleaseResponse;
      if (!parsed || typeof parsed.tag_name !== 'string' || !Array.isArray(parsed.assets)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async getRuntimeDir(): Promise<string> {
    const dir = path.join(this.context.globalStorageUri.fsPath, RUNTIME_DIR_NAME);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  private async getManifestPath(): Promise<string> {
    const runtimeDir = await this.getRuntimeDir();
    return path.join(runtimeDir, MANIFEST_NAME);
  }

  private async readManifest(): Promise<RuntimeManifest> {
    const manifestPath = await this.getManifestPath();
    try {
      const raw = await fsp.readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as RuntimeManifest;
      if (!parsed.installed) {
        parsed.installed = {};
      }
      return parsed;
    } catch {
      return { installed: {} };
    }
  }

  private async writeManifest(manifest: RuntimeManifest): Promise<void> {
    const manifestPath = await this.getManifestPath();
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  private async downloadFile(url: string, destPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.makeRequest(url, (res) => {
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', reject);
      }, reject);
    });
  }

  private async downloadText(url: string, headers?: Record<string, string>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.makeRequest(
        url,
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer | string) => {
            body += chunk.toString();
          });
          res.on('end', () => resolve(body));
        },
        reject,
        headers
      );
    });
  }

  private makeRequest(
    url: string,
    onSuccess: (res: NodeJS.ReadableStream) => void,
    onError: (err: Error) => void,
    headers?: Record<string, string>,
    redirects = 0
  ): void {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'oculix-vscode-extension',
          ...(headers || {}),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && typeof location === 'string') {
          if (redirects >= 5) {
            onError(new Error(`Too many redirects while fetching ${url}`));
            return;
          }
          const nextUrl = new URL(location, url).toString();
          this.makeRequest(nextUrl, onSuccess, onError, headers, redirects + 1);
          return;
        }
        if (status < 200 || status >= 300) {
          onError(new Error(`HTTP ${status} while fetching ${url}`));
          res.resume();
          return;
        }
        onSuccess(res);
      }
    );
    req.on('error', onError);
  }
}

type MaterializedBundle = {
  bundlePath: string;
  lineNumbers: number[];
};

async function materializeRunBundle(
  doc: vscode.TextDocument,
  selection: vscode.Selection,
  scope: RunScope
): Promise<MaterializedBundle | null> {
  if (doc.isUntitled) {
    vscode.window.showErrorMessage('Save the Python script before running OculiX scripts.');
    return null;
  }

  const sourceText = doc.getText();
  const sourceLines = sourceText.split(/\r?\n/);

  let startLine = 0;
  let endLine = sourceLines.length - 1;

  if (scope === 'currentLine') {
    const expanded = expandStatementAtLine(sourceLines, selection.active.line);
    startLine = expanded.start;
    endLine = expanded.end;
  } else if (scope === 'selection') {
    if (selection.isEmpty) {
      vscode.window.showErrorMessage('Select one or more lines to run selection.');
      return null;
    }
    const first = Math.min(selection.start.line, selection.end.line);
    const last = Math.max(selection.start.line, selection.end.line);
    const expandedStart = expandStatementAtLine(sourceLines, first).start;
    const expandedEnd = expandStatementAtLine(sourceLines, last).end;
    startLine = Math.min(expandedStart, expandedEnd);
    endLine = Math.max(expandedStart, expandedEnd);
  }

  const scopedLines = sourceLines.slice(startLine, endLine + 1);
  const selectedText = scopedLines.join('\n');

  const scriptBaseName = path.basename(doc.fileName, path.extname(doc.fileName));
  const tempParent = await fsp.mkdtemp(path.join(os.tmpdir(), 'oculix-run-'));
  const bundlePath = path.join(tempParent, `${scriptBaseName}.sikuli`);
  await fsp.mkdir(bundlePath, { recursive: true });

  const scriptPath = path.join(bundlePath, `${scriptBaseName}.py`);
  await fsp.writeFile(scriptPath, selectedText, 'utf8');

  // Copy image dependencies used by this scope, if they resolve near the source file.
  const sourceDir = path.dirname(doc.fileName);
  IMAGE_REF_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_REF_REGEX.exec(selectedText)) !== null) {
    const imageName = match[1];
    const sourcePath = path.join(sourceDir, imageName);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    const targetPath = path.join(bundlePath, imageName);
    await fsp.copyFile(sourcePath, targetPath);
  }

  const lineNumbers = scopedLines
    .map((line, idx) => ({ line, absoluteLine: startLine + idx }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ absoluteLine }) => absoluteLine);
  return {
    bundlePath,
    lineNumbers,
  };
}

function expandStatementAtLine(lines: string[], line: number): { start: number; end: number } {
  let start = clampLine(line, lines.length);
  let end = clampLine(line, lines.length);

  while (start > 0 && isLogicalContinuation(lines, start - 1, start)) {
    start -= 1;
  }

  while (end < lines.length - 1 && isLogicalContinuation(lines, end, end + 1)) {
    end += 1;
  }

  return { start, end };
}

function isLogicalContinuation(lines: string[], currentLine: number, nextLine: number): boolean {
  const curr = lines[currentLine] ?? '';
  const next = lines[nextLine] ?? '';

  if (curr.trimEnd().endsWith('\\')) {
    return true;
  }

  const openBalance = countParenDelta(curr);
  if (openBalance > 0) {
    return true;
  }

  if (/^\s/.test(next) && /:\s*(#.*)?$/.test(curr.trimEnd())) {
    return true;
  }

  return false;
}

function countParenDelta(line: string): number {
  let delta = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : '';

    if (ch === "'" && prev !== '\\' && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && prev !== '\\' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) {
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      delta += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      delta -= 1;
    }
  }
  return delta;
}

function clampLine(line: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(total - 1, line));
}

function parseJavaMajor(versionText: string): number {
  const quoted = versionText.match(/"(\d+)(?:\.(\d+))?.*"/);
  if (quoted) {
    const major = Number.parseInt(quoted[1], 10);
    if (major === 1 && quoted[2]) {
      return Number.parseInt(quoted[2], 10);
    }
    return major;
  }

  const direct = versionText.match(/(\d+)\./);
  if (direct) {
    return Number.parseInt(direct[1], 10);
  }

  return 0;
}

function normalizeTag(tag: string): string {
  return tag.replace(/^v/i, '').trim();
}

function parseLinuxWindowId(output: string | null): string | null {
  if (!output) {
    return null;
  }

  const match = output.match(/window id # (0x[0-9a-fA-F]+)/);
  if (!match) {
    return null;
  }

  return match[1];
}

function toAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isTrustedDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === 'github.com'
      || host.endsWith('.github.com')
      || host === 'objects.githubusercontent.com'
      || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  return new Promise<string>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
