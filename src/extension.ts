import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { captureScreen } from './capture';
import { PatternHoverProvider } from './hoverProvider';
import { OculixCompletionProvider } from './completionProvider';
import { OculixPreviewPanel } from './previewPanel';
import { cleanupUnreferencedImages } from './imageCleanup';
import { OculixScriptRunner } from './scriptRunner';

let suppressRenamePromptsDepth = 0;
const AUTO_PAIR_RENAMES_SETTING = 'autoPairSikuliRenames';

type PairedRenameDecision = {
  shouldRename: boolean;
  showAutoSuccessMessage: boolean;
};

export function activate(context: vscode.ExtensionContext) {
  console.log('OculiX for VS Code activated');
  void vscode.commands.executeCommand('setContext', 'oculix.isRunning', false);

  const runner = new OculixScriptRunner(context);

  const previewSerializer = vscode.window.registerWebviewPanelSerializer(
    OculixPreviewPanel.viewType,
    {
      async deserializeWebviewPanel(webviewPanel, state) {
        OculixPreviewPanel.revive(webviewPanel, context.extensionUri, state);
      },
    }
  );

  // ── Register hover provider for Pattern("...") references ──
  const hoverProvider = vscode.languages.registerHoverProvider(
    { language: 'python' },
    new PatternHoverProvider()
  );

  // ── Register completion item for capture workflow in OculiX calls ──
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    { language: 'python' },
    new OculixCompletionProvider(),
    '('
  );

  // ── Capture region command ──
  const captureRegionCmd = vscode.commands.registerCommand(
    'oculix.captureRegion',
    async (options?: { captureDelaySeconds?: number }) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor.');
        return;
      }

      const imageDir = resolveImageDir(editor.document.uri);
      if (!imageDir) {
        vscode.window.showErrorMessage('Could not determine image save location. Save your script file first.');
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'OculiX: Preparing capture...' },
        async (progress) => {
          const reportStatus = (message: string) => progress.report({ message });
          const filename = await captureScreen(
            imageDir,
            undefined,
            reportStatus,
            options?.captureDelaySeconds
          );
          if (filename) {
            insertPatternReference(editor, filename);
            vscode.window.showInformationMessage(`Captured: ${filename}`);
          }
        }
      );
    }
  );

  // ── Open preview command ──
  const openPreviewCmd = vscode.commands.registerCommand(
    'oculix.openPreview',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'python') {
        vscode.window.showErrorMessage('Open a Python file to preview it.');
        return;
      }
      OculixPreviewPanel.createOrShow(editor.document, context.extensionUri);
    }
  );

  // ── Run commands ──
  const runScriptCmd = vscode.commands.registerCommand('oculix.runScript', async () => {
    await runner.run({ scope: 'script' });
  });

  const runCurrentLineCmd = vscode.commands.registerCommand('oculix.runCurrentLine', async () => {
    await runner.run({ scope: 'currentLine' });
  });

  const runSelectionCmd = vscode.commands.registerCommand('oculix.runSelection', async () => {
    await runner.run({ scope: 'selection' });
  });

  const stopRunCmd = vscode.commands.registerCommand('oculix.stopRun', () => {
    runner.stop();
  });

  const previewRunEventCmd = vscode.commands.registerCommand(
    'oculix.previewRunEvent',
    (event: unknown) => {
      OculixPreviewPanel.postRunEvent(event);
    }
  );

  // ── Clean up unreferenced images on save ──
  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.languageId === 'python') {
      void cleanupUnreferencedImages(doc);
    }
  });

  const renameListener = vscode.workspace.onDidRenameFiles((event) => {
    void handleWorkspaceRenameEvent(event);
  });

  context.subscriptions.push(
    runner,
    previewSerializer,
    hoverProvider,
    completionProvider,
    captureRegionCmd,
    openPreviewCmd,
    runScriptCmd,
    runCurrentLineCmd,
    runSelectionCmd,
    stopRunCmd,
    previewRunEventCmd,
    saveListener,
    renameListener
  );

  // Run periodic metadata checks for latest runtime in the background.
  void runner.checkForRuntimeUpdatesOnStartup();
}

/**
 * Resolves where to save images.
 * Uses oculix.imageFolder config if set, otherwise same dir as the script.
 */
function resolveImageDir(docUri: vscode.Uri): string | null {
  const config = vscode.workspace.getConfiguration('oculix');
  const configFolder = config.get<string>('imageFolder', '');

  if (configFolder) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const dir = path.join(workspaceFolders[0].uri.fsPath, configFolder);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
  }

  // Fall back to the directory of the currently open file
  const docPath = docUri.fsPath;
  if (docPath && !docPath.startsWith('untitled')) {
    return path.dirname(docPath);
  }

  return null;
}

/**
 * Inserts Pattern("filename.png") at the current cursor position,
 * or replaces selected text.
 */
function insertPatternReference(editor: vscode.TextEditor, filename: string) {
  const snippet = new vscode.SnippetString(`Pattern("${filename}").targetOffset(\${1:0},\${2:0})`);
  editor.insertSnippet(snippet);
}

async function handleWorkspaceRenameEvent(event: vscode.FileRenameEvent): Promise<void> {
  if (suppressRenamePromptsDepth > 0) {
    return;
  }

  for (const change of event.files) {
    if (change.oldUri.scheme !== 'file' || change.newUri.scheme !== 'file') {
      continue;
    }

    await maybePromptToRenamePairedPyFile(change.oldUri, change.newUri);
    await maybePromptToRenamePairedSikuliFolder(change.oldUri, change.newUri);
  }
}

async function maybePromptToRenamePairedPyFile(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
  if (!isSikuliFolderPath(newUri.fsPath)) {
    return;
  }

  const oldBaseName = getSikuliBaseName(oldUri.fsPath);
  const newBaseName = getSikuliBaseName(newUri.fsPath);
  if (!oldBaseName || !newBaseName || oldBaseName === newBaseName) {
    return;
  }

  const currentScriptUri = vscode.Uri.joinPath(newUri, `${oldBaseName}.py`);
  const renamedScriptUri = vscode.Uri.joinPath(newUri, `${newBaseName}.py`);

  if (!(await pathExists(currentScriptUri)) || (await pathExists(renamedScriptUri))) {
    return;
  }

  const decision = await shouldProceedWithPairedRename(
    `Folder renamed to ${path.basename(newUri.fsPath)}. Rename ${oldBaseName}.py to ${newBaseName}.py as well?`,
    'Rename .py'
  );
  if (!decision.shouldRename) {
    return;
  }

  try {
    await runWithoutRenamePrompts(async () => {
      await vscode.workspace.fs.rename(currentScriptUri, renamedScriptUri, { overwrite: false });
    });
    if (decision.showAutoSuccessMessage) {
      vscode.window.showInformationMessage(`Automatically renamed ${oldBaseName}.py to ${newBaseName}.py.`);
    }
  } catch {
    vscode.window.showWarningMessage(`Could not rename ${oldBaseName}.py to ${newBaseName}.py.`);
  }
}

async function maybePromptToRenamePairedSikuliFolder(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
  if (!isPythonFilePath(oldUri.fsPath) || !isPythonFilePath(newUri.fsPath)) {
    return;
  }

  const currentFolderPath = path.dirname(newUri.fsPath);
  const currentFolderName = path.basename(currentFolderPath);
  if (!isSikuliFolderPath(currentFolderName)) {
    return;
  }

  const oldScriptBaseName = path.basename(oldUri.fsPath, path.extname(oldUri.fsPath));
  const newScriptBaseName = path.basename(newUri.fsPath, path.extname(newUri.fsPath));
  const folderBaseName = getSikuliBaseName(currentFolderName);
  if (!folderBaseName || oldScriptBaseName !== folderBaseName || newScriptBaseName === folderBaseName) {
    return;
  }

  const parentDir = path.dirname(currentFolderPath);
  const renamedFolderUri = vscode.Uri.file(path.join(parentDir, `${newScriptBaseName}.sikuli`));
  if (await pathExists(renamedFolderUri)) {
    return;
  }

  const decision = await shouldProceedWithPairedRename(
    `${path.basename(newUri.fsPath)} was renamed inside ${currentFolderName}. Rename folder to ${newScriptBaseName}.sikuli?`,
    'Rename .sikuli folder'
  );
  if (!decision.shouldRename) {
    return;
  }

  try {
    await runWithoutRenamePrompts(async () => {
      await vscode.workspace.fs.rename(vscode.Uri.file(currentFolderPath), renamedFolderUri, { overwrite: false });
    });
    if (decision.showAutoSuccessMessage) {
      vscode.window.showInformationMessage(
        `Automatically renamed ${currentFolderName} to ${newScriptBaseName}.sikuli.`
      );
    }
  } catch {
    vscode.window.showWarningMessage(
      `Could not rename ${currentFolderName} to ${newScriptBaseName}.sikuli.`
    );
  }
}

async function runWithoutRenamePrompts<T>(operation: () => Promise<T>): Promise<T> {
  suppressRenamePromptsDepth += 1;
  try {
    return await operation();
  } finally {
    suppressRenamePromptsDepth -= 1;
  }
}

async function shouldProceedWithPairedRename(
  message: string,
  renameActionLabel: string
): Promise<PairedRenameDecision> {
  if (isAutoPairRenamesEnabled()) {
    return {
      shouldRename: true,
      showAutoSuccessMessage: true,
    };
  }

  const alwaysAction = 'Always';
  const action = await vscode.window.showInformationMessage(
    message,
    renameActionLabel,
    alwaysAction,
    'Not now'
  );

  if (action === renameActionLabel) {
    return {
      shouldRename: true,
      showAutoSuccessMessage: false,
    };
  }

  if (action === alwaysAction) {
    const enabled = await enableAutoPairRenames();
    return {
      shouldRename: enabled,
      showAutoSuccessMessage: false,
    };
  }

  return {
    shouldRename: false,
    showAutoSuccessMessage: false,
  };
}

function isAutoPairRenamesEnabled(): boolean {
  const config = vscode.workspace.getConfiguration('oculix');
  return config.get<boolean>(AUTO_PAIR_RENAMES_SETTING, false);
}

async function enableAutoPairRenames(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('oculix');
  try {
    await config.update(AUTO_PAIR_RENAMES_SETTING, true, vscode.ConfigurationTarget.Global);
    return true;
  } catch {
    vscode.window.showWarningMessage('Could not enable automatic paired .sikuli/.py renames.');
    return false;
  }
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function isPythonFilePath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.py';
}

function isSikuliFolderPath(folderPath: string): boolean {
  return path.basename(folderPath).toLowerCase().endsWith('.sikuli');
}

function getSikuliBaseName(folderPath: string): string | null {
  const folderName = path.basename(folderPath);
  if (!folderName.toLowerCase().endsWith('.sikuli')) {
    return null;
  }

  return folderName.slice(0, folderName.length - '.sikuli'.length);
}

export function deactivate() {}
