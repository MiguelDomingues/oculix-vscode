import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Matches any quoted string literal ending in .png, regardless of surrounding
// function name. Covers Pattern("..."), wait("..."), click("..."), exists("..."),
// dragDrop("...", "..."), etc.
export const IMAGE_REF_REGEX = /["']([^"'\n]+\.png)["']/gi;

/**
 * Resolves a Pattern() image filename to an absolute path on disk.
 * Search order: same directory as the script → configured imageFolder → workspace root.
 * Returns null if the file isn't found.
 */
export function resolveImagePath(docUri: vscode.Uri, filename: string): string | null {
  const scriptDir = path.dirname(docUri.fsPath);
  const localPath = path.join(scriptDir, filename);
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  const config = vscode.workspace.getConfiguration('oculix');
  const configFolder = config.get<string>('imageFolder', '');
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (configFolder && workspaceFolders) {
    for (const wf of workspaceFolders) {
      const p = path.join(wf.uri.fsPath, configFolder, filename);
      if (fs.existsSync(p)) {
        return p;
      }
    }
  }

  if (workspaceFolders) {
    for (const wf of workspaceFolders) {
      const p = path.join(wf.uri.fsPath, filename);
      if (fs.existsSync(p)) {
        return p;
      }
    }
  }

  return null;
}
