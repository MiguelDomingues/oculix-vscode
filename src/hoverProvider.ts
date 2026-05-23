import * as vscode from 'vscode';
import * as fs from 'fs';
import { IMAGE_REF_REGEX, resolveImagePath } from './pathResolver';

export class PatternHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | null {
    const line = document.lineAt(position.line).text;

    let match: RegExpExecArray | null;
    IMAGE_REF_REGEX.lastIndex = 0;

    while ((match = IMAGE_REF_REGEX.exec(line)) !== null) {
      const matchStart = match.index;
      const matchEnd = match.index + match[0].length;

      if (position.character < matchStart || position.character > matchEnd) {
        continue;
      }

      const filename = match[1];
      const imagePath = resolveImagePath(document.uri, filename);

      if (!imagePath || !fs.existsSync(imagePath)) {
        return new vscode.Hover(
          new vscode.MarkdownString(`⚠️ Image not found: \`${filename}\``)
        );
      }

      const imageUri = vscode.Uri.file(imagePath);
      const md = new vscode.MarkdownString();
      md.isTrusted = false;

      const stats = fs.statSync(imagePath);
      const sizeKb = (stats.size / 1024).toFixed(1);

      md.appendText(`${filename} (${sizeKb} KB)`);
      md.appendMarkdown('\n\n');
      md.appendMarkdown(`![](${imageUri.toString()})`);
      md.appendMarkdown('\n\n');
      md.appendText(`Path: ${imagePath}`);

      const range = new vscode.Range(
        position.line, matchStart,
        position.line, matchEnd
      );

      return new vscode.Hover(md, range);
    }

    return null;
  }
}
