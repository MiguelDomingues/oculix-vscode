import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * On save of a Python file, scans the image folder for *.png files that are not
 * referenced by name in any Python file in the workspace (including comments,
 * unsaved buffers, and across the whole project) and moves them to the trash.
 *
 * The check is a simple substring scan of each .py file's content for the bare
 * filename — quoted or not — so any mention (Pattern("foo.png"), wait("foo.png"),
 * or even "# remember foo.png") is enough to preserve the file.
 */
export async function cleanupUnreferencedImages(savedDoc: vscode.TextDocument): Promise<void> {
  const config = vscode.workspace.getConfiguration('oculix');
  if (!config.get<boolean>('cleanupUnreferencedImagesOnSave', true)) {
    return;
  }

  const imageDir = resolveImageDir(savedDoc.uri);
  if (!imageDir) return;

  let pngFiles: string[];
  try {
    pngFiles = fs.readdirSync(imageDir).filter((f) => f.toLowerCase().endsWith('.png'));
  } catch {
    return;
  }
  if (pngFiles.length === 0) return;

  const combinedText = await collectAllPythonText();
  const toDelete = pngFiles.filter((f) => !combinedText.includes(f));
  if (toDelete.length === 0) return;

  let deleted = 0;
  const failures: string[] = [];
  for (const f of toDelete) {
    const uri = vscode.Uri.file(path.join(imageDir, f));
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
      deleted++;
    } catch (err) {
      failures.push(`${f}: ${String(err)}`);
    }
  }

  if (deleted > 0) {
    vscode.window.setStatusBarMessage(
      `OculiX: cleaned up ${deleted} unreferenced image${deleted === 1 ? '' : 's'}`,
      4000
    );
  }
  if (failures.length > 0) {
    vscode.window.showWarningMessage(
      `OculiX: failed to delete ${failures.length} image(s). See console for details.`
    );
    console.error('OculiX image cleanup failures:', failures.join('\n'));
  }
}

/**
 * Determines the image folder for a Python file, mirroring captureScreen's logic:
 * the configured oculix.imageFolder (relative to the first workspace folder) if
 * set, otherwise the script's own directory.
 */
function resolveImageDir(docUri: vscode.Uri): string | null {
  const config = vscode.workspace.getConfiguration('oculix');
  const configFolder = config.get<string>('imageFolder', '');

  if (configFolder) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return path.join(workspaceFolders[0].uri.fsPath, configFolder);
    }
  }

  const docPath = docUri.fsPath;
  if (docPath && !docPath.startsWith('untitled')) {
    return path.dirname(docPath);
  }
  return null;
}

/**
 * Reads every *.py file in the workspace. For files that are currently open in
 * an editor, uses the in-memory (possibly unsaved) text. For closed files,
 * reads from disk.
 */
async function collectAllPythonText(): Promise<string> {
  const uris = await vscode.workspace.findFiles('**/*.py');
  const openDocs = new Map<string, vscode.TextDocument>();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === 'python') {
      openDocs.set(doc.uri.toString(), doc);
    }
  }

  const chunks: string[] = [];
  for (const uri of uris) {
    const key = uri.toString();
    const open = openDocs.get(key);
    if (open) {
      chunks.push(open.getText());
      openDocs.delete(key);
      continue;
    }
    try {
      const buf = await vscode.workspace.fs.readFile(uri);
      chunks.push(Buffer.from(buf).toString('utf8'));
    } catch {
      // Skip unreadable files.
    }
  }
  // Include any open .py docs that findFiles missed (e.g. unsaved/untitled).
  for (const doc of openDocs.values()) {
    chunks.push(doc.getText());
  }

  return chunks.join('\n');
}
