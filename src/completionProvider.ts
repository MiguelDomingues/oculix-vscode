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

    const item = new vscode.CompletionItem(
      'Capture screenshot',
      vscode.CompletionItemKind.Snippet
    );
    item.insertText = new vscode.SnippetString('');
    item.detail = 'TAB to insert screenshot';
    item.documentation = new vscode.MarkdownString(
      'Captures a screen region and inserts a Pattern("...") reference at the cursor.'
    );
    item.sortText = '0000_capture';
    item.filterText = 'capture screenshot oculix';
    item.command = {
      command: 'oculix.captureRegion',
      title: 'OculiX: Capture Screen Region',
    };

    return [item];
  }
}
