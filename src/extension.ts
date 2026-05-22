import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { captureScreen } from './capture';
import { PatternHoverProvider } from './hoverProvider';
import { OculixCompletionProvider } from './completionProvider';
import { OculixPreviewPanel } from './previewPanel';
import { cleanupUnreferencedImages } from './imageCleanup';

export function activate(context: vscode.ExtensionContext) {
  console.log('OculiX for VS Code activated');

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
    async () => {
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
          const filename = await captureScreen(imageDir, undefined, reportStatus);
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
      OculixPreviewPanel.createOrShow(editor.document);
    }
  );

  // ── Clean up unreferenced images on save ──
  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.languageId === 'python') {
      void cleanupUnreferencedImages(doc);
    }
  });

  context.subscriptions.push(
    hoverProvider,
    completionProvider,
    captureRegionCmd,
    openPreviewCmd,
    saveListener
  );
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
