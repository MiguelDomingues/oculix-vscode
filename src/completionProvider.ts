import * as vscode from 'vscode';

const OCLX_CALL_CONTEXT_REGEX =
  /(?:^|[^\w.])(Pattern|click|wait|hover|doubleClick|rightClick|exists|find|dragDrop)\(\s*$/;

export class OculixCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);

    if (!OCLX_CALL_CONTEXT_REGEX.test(linePrefix)) {
      return [];
    }

    const config = vscode.workspace.getConfiguration('oculix', document.uri);
    const configuredDelay = config.get<number>('captureDelaySeconds', 3);
    const delaySeconds = Number.isFinite(configuredDelay)
      ? Math.max(0, Math.min(30, Math.round(configuredDelay)))
      : 3;

    const delayedItem = new vscode.CompletionItem(
      `Capture screenshot (${delaySeconds}s)`,
      vscode.CompletionItemKind.Snippet
    );
    delayedItem.insertText = new vscode.SnippetString('');
    delayedItem.detail = `Capture after ${delaySeconds} seconds`;
    delayedItem.documentation = new vscode.MarkdownString(
      'Captures a screen region and inserts a Pattern("...") reference at the cursor.\n\nSet `oculix.captureDelaySeconds` in settings to control the pre-capture countdown.'
    );
    delayedItem.sortText = '0001_capture_delayed';
    delayedItem.filterText = 'capture screenshot delay countdown oculix';
    delayedItem.command = {
      command: 'oculix.captureRegion',
      title: 'OculiX: Capture Screen Region',
    };

    const instantItem = new vscode.CompletionItem(
      'Capture screenshot',
      vscode.CompletionItemKind.Snippet
    );
    instantItem.insertText = new vscode.SnippetString('');
    instantItem.detail = 'Capture immediately';
    instantItem.documentation = new vscode.MarkdownString(
      'Captures a screen region immediately and inserts a Pattern("...") reference at the cursor.'
    );
    instantItem.sortText = '0000_capture_instant';
    instantItem.filterText = 'capture screenshot no delay instant oculix';
    instantItem.command = {
      command: 'oculix.captureRegion',
      title: 'OculiX: Capture Screen Region',
      arguments: [{ captureDelaySeconds: 0 }],
    };

    return [instantItem, delayedItem];
  }
}
