import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { captureScreen } from './capture';
import { PatternHoverProvider } from './hoverProvider';
import { OculixCompletionProvider } from './completionProvider';
import { OculixPreviewPanel } from './previewPanel';
import { cleanupUnreferencedImages } from './imageCleanup';
import { OculixScriptRunner } from './scriptRunner';

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
    saveListener
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

export function deactivate() {}
