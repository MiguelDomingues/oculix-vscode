import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveImagePath } from './pathResolver';
import { runPatternTest } from './testPattern';
import { captureScreen } from './capture';

const UPDATE_DEBOUNCE_MS = 250;
const DEFAULT_IMAGE_HEIGHT = 200;
const MIN_IMAGE_HEIGHT = 24;
const MAX_IMAGE_HEIGHT = 1200;

export class OculixPreviewPanel {
  private static currentPanel: OculixPreviewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private docUri: vscode.Uri | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private debounceTimer?: NodeJS.Timeout;

  static createOrShow(doc: vscode.TextDocument): void {
    const existing = OculixPreviewPanel.currentPanel;
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      existing.setDocument(doc);
      return;
    }
    new OculixPreviewPanel(doc);
  }

  private constructor(doc: vscode.TextDocument) {
    this.docUri = doc.uri;
    const localResourceRoots = this.getLocalResourceRoots(doc.uri);

    this.panel = vscode.window.createWebviewPanel(
      'oculixPreview',
      this.getTitleForDoc(doc.uri),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots,
      }
    );

    OculixPreviewPanel.currentPanel = this;

    this.panel.onDidDispose(() => this.dispose(false), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === 'jumpToLine' && typeof msg.line === 'number') {
          this.revealLineInEditor(msg.line);
        } else if (msg?.type === 'updateTargetOffset') {
          this.applyTargetOffsetUpdate(msg);
        } else if (msg?.type === 'updateSimilarity') {
          this.applySimilarityUpdate(msg);
        } else if (msg?.type === 'testPattern') {
          this.handleTestPattern(msg);
        } else if (msg?.type === 'recapturePattern') {
          this.handleRecapture(msg);
        }
      },
      null,
      this.disposables
    );

    vscode.workspace.onDidChangeTextDocument(
      (event) => {
        if (this.isCurrentDocument(event.document.uri)) {
          this.scheduleUpdate();
        }
      },
      null,
      this.disposables
    );

    vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration('oculix')) {
          this.update();
        }
      },
      null,
      this.disposables
    );

    vscode.window.onDidChangeTextEditorSelection(
      (event) => {
        if (this.isCurrentDocument(event.textEditor.document.uri)) {
          this.sendActiveLine(event.selections[0].active.line);
        }
      },
      null,
      this.disposables
    );

    vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (!editor || editor.document.languageId !== 'python') {
          this.setDocument(undefined);
          return;
        }
        this.setDocument(editor.document);
      },
      null,
      this.disposables
    );

    vscode.workspace.onDidCloseTextDocument(
      (closedDoc) => {
        if (!this.isCurrentDocument(closedDoc.uri)) {
          return;
        }
        const replacement = vscode.window.activeTextEditor?.document;
        if (replacement && replacement.languageId === 'python') {
          this.setDocument(replacement);
        } else {
          this.setDocument(undefined);
        }
      },
      null,
      this.disposables
    );

    this.update();
    this.sendInitialActiveLine();
  }

  private getTitleForDoc(docUri: vscode.Uri | undefined): string {
    if (!docUri) {
      return 'OculiX Preview';
    }
    return `OculiX Preview: ${path.basename(docUri.fsPath)}`;
  }

  private getLocalResourceRoots(docUri: vscode.Uri | undefined): vscode.Uri[] {
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
    if (!docUri) {
      return workspaceRoots;
    }
    const scriptDir = path.dirname(docUri.fsPath);
    return [vscode.Uri.file(scriptDir), ...workspaceRoots];
  }

  private setDocument(doc: vscode.TextDocument | undefined): void {
    if (doc && doc.languageId !== 'python') {
      return;
    }

    const nextUri = doc?.uri;
    const current = this.docUri?.toString();
    const next = nextUri?.toString();
    if (current === next) {
      this.sendInitialActiveLine();
      return;
    }

    this.docUri = nextUri;
    this.panel.title = this.getTitleForDoc(nextUri);
    this.panel.webview.options = {
      ...this.panel.webview.options,
      localResourceRoots: this.getLocalResourceRoots(nextUri),
    };
    this.update();
    this.sendInitialActiveLine();
  }

  private isCurrentDocument(uri: vscode.Uri): boolean {
    return !!this.docUri && this.docUri.toString() === uri.toString();
  }

  private sendActiveLine(line: number): void {
    this.panel.webview.postMessage({ type: 'activeLine', line });
  }

  private sendInitialActiveLine(): void {
    if (!this.docUri) {
      return;
    }
    const docKey = this.docUri.toString();
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === docKey
    );
    if (editor) {
      this.sendActiveLine(editor.selection.active.line);
    }
  }

  dispose(disposePanel = true): void {
    if (OculixPreviewPanel.currentPanel === this) {
      OculixPreviewPanel.currentPanel = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.disposables.forEach((d) => d.dispose());
    if (disposePanel) {
      this.panel.dispose();
    }
  }

  private scheduleUpdate(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => this.update(), UPDATE_DEBOUNCE_MS);
  }

  private update(): void {
    if (!this.docUri) {
      this.panel.webview.html = this.renderNoActiveDocHtml();
      return;
    }
    const docUri = this.docUri;

    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === docUri.toString()
    );
    if (!doc) {
      this.panel.webview.html = this.renderClosedDocHtml();
      return;
    }
    this.panel.webview.html = this.renderHtml(doc);
    this.sendInitialActiveLine();
  }

  private async applyTargetOffsetUpdate(msg: {
    line: number;
    name: string;
    strCol: number;
    strEnd: number;
    wrapEnd: number | null;
    offCol: number | null;
    offEnd: number | null;
    offsetX: number;
    offsetY: number;
  }): Promise<void> {
    if (!this.docUri) {
      return;
    }

    const newOffsetCall = `.targetOffset(${msg.offsetX},${msg.offsetY})`;
    const edit = new vscode.WorkspaceEdit();

    if (msg.offCol !== null && msg.offEnd !== null) {
      // Line already has `.targetOffset(...)` — replace it in place.
      const range = new vscode.Range(msg.line, msg.offCol, msg.line, msg.offEnd);
      edit.replace(this.docUri, range, newOffsetCall);
    } else if (msg.wrapEnd !== null) {
      // Pattern(...) wrapper present, no targetOffset yet — insert right after `)`.
      const pos = new vscode.Position(msg.line, msg.wrapEnd);
      edit.insert(this.docUri, pos, newOffsetCall);
    } else {
      // Bare "foo.png" — wrap with Pattern(...) and append .targetOffset(...).
      const range = new vscode.Range(msg.line, msg.strCol, msg.line, msg.strEnd);
      edit.replace(this.docUri, range, `Pattern("${msg.name}")${newOffsetCall}`);
    }

    await vscode.workspace.applyEdit(edit);
  }

  private async handleRecapture(msg: { name: string }): Promise<void> {
    if (!this.docUri) {
      return;
    }

    const imagePath = resolveImagePath(this.docUri, msg.name);
    if (!imagePath) {
      vscode.window.showErrorMessage(`OculiX: cannot find image to replace — ${msg.name}`);
      return;
    }
    const imageDir = path.dirname(imagePath);
    const filename = path.basename(imagePath);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `OculiX: recapture ${filename}…`,
      },
      async () => {
        const result = await captureScreen(imageDir, filename);
        if (result) {
          vscode.window.showInformationMessage(`OculiX: replaced ${filename}`);
          // Re-render so the new image (with bumped mtime cache-bust) shows immediately.
          this.update();
        }
      }
    );
  }

  private async handleTestPattern(msg: {
    line: number;
    name: string;
    strCol: number;
    strEnd: number;
    wrapEnd: number | null;
    simCol: number | null;
    simEnd: number | null;
    similarity: number;
  }): Promise<void> {
    if (!this.docUri) {
      return;
    }

    const result = await runPatternTest(this.docUri, {
      filename: msg.name,
      similarity: msg.similarity,
    });
    if (result.apply) {
      await this.applySimilarityUpdate({
        line: msg.line,
        name: msg.name,
        strCol: msg.strCol,
        strEnd: msg.strEnd,
        wrapEnd: msg.wrapEnd,
        simCol: msg.simCol,
        simEnd: msg.simEnd,
        value: result.value,
      });
    }
  }

  private async applySimilarityUpdate(msg: {
    line: number;
    name: string;
    strCol: number;
    strEnd: number;
    wrapEnd: number | null;
    simCol: number | null;
    simEnd: number | null;
    value: number;
  }): Promise<void> {
    if (!this.docUri) {
      return;
    }

    const formatted = formatSimilarValue(msg.value);
    const newCall = `.similar(${formatted})`;
    const edit = new vscode.WorkspaceEdit();

    if (msg.simCol !== null && msg.simEnd !== null) {
      // Replace existing `.similar(...)` in place.
      const range = new vscode.Range(msg.line, msg.simCol, msg.line, msg.simEnd);
      edit.replace(this.docUri, range, newCall);
    } else if (msg.wrapEnd !== null) {
      // Pattern(...) wrapper present, no similar yet — insert immediately after `)`.
      const pos = new vscode.Position(msg.line, msg.wrapEnd);
      edit.insert(this.docUri, pos, newCall);
    } else {
      // Bare "foo.png" — wrap with Pattern(...) and append .similar(...).
      const range = new vscode.Range(msg.line, msg.strCol, msg.line, msg.strEnd);
      edit.replace(this.docUri, range, `Pattern("${msg.name}")${newCall}`);
    }

    await vscode.workspace.applyEdit(edit);
  }

  private revealLineInEditor(line: number): void {
    if (!this.docUri) {
      return;
    }

    const docKey = this.docUri.toString();
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === docKey
    );
    const target = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === docKey
    );

    const focus = (e: vscode.TextEditor) => {
      const pos = new vscode.Position(line, 0);
      e.selection = new vscode.Selection(pos, pos);
      e.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    };

    if (editor) {
      vscode.window.showTextDocument(editor.document, editor.viewColumn).then(focus);
    } else if (target) {
      vscode.window.showTextDocument(target, vscode.ViewColumn.One).then(focus);
    }
  }

  private renderHtml(doc: vscode.TextDocument): string {
    const config = vscode.workspace.getConfiguration('oculix');
    const maxImageHeight = clamp(
      config.get<number>('previewImageHeight', DEFAULT_IMAGE_HEIGHT),
      MIN_IMAGE_HEIGHT,
      MAX_IMAGE_HEIGHT
    );

    const webview = this.panel.webview;
    const nonce = generateNonce();
    const lines = doc.getText().split(/\r?\n/);

    const renderedLines = lines
      .map((line, idx) => {
        const rendered = renderLine(line, idx, doc.uri, webview);
        return `<div class="line" data-line="${idx}"><span class="lineno">${idx + 1}</span><span class="content">${rendered}</span></div>`;
      })
      .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>OculiX Preview</title>
  <style>
    body {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 12px 16px;
    }
    .line {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 2px 4px;
      border-radius: 3px;
      cursor: pointer;
    }
    .line:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .line.active {
      background: var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,0.06));
      box-shadow: inset 3px 0 0 0 var(--vscode-editorCursor-foreground, #aeafad);
    }
    .line.active .lineno {
      color: var(--vscode-editorLineNumber-activeForeground, var(--vscode-foreground));
      font-weight: 600;
    }
    .lineno {
      color: var(--vscode-editorLineNumber-foreground, #858585);
      min-width: 3em;
      text-align: right;
      user-select: none;
      flex-shrink: 0;
    }
    .content {
      white-space: pre-wrap;
      flex: 1;
      word-break: break-word;
    }
    .pattern-img {
      max-height: ${maxImageHeight}px;
      max-width: 100%;
      vertical-align: middle;
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 4px;
      margin: 2px 4px;
      display: block;
      cursor: pointer;
    }
    body.ctrl-held .pattern-img {
      cursor: crosshair;
    }
    .pattern-img:hover {
      outline: 2px solid var(--vscode-focusBorder, #007acc);
      outline-offset: -1px;
    }
    .pattern-wrap {
      position: relative;
      display: inline-block;
      vertical-align: middle;
    }
    .similarity-badge {
      position: absolute;
      top: 6px;
      right: 8px;
      background: rgba(0, 0, 0, 0.72);
      color: #fff;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
      cursor: pointer;
      user-select: none;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.25);
      letter-spacing: 0.02em;
      display: none;
    }
    .pattern-wrap:hover .similarity-badge,
    .similarity-badge.is-set {
      display: block;
    }
    .similarity-badge.default {
      opacity: 0.7;
      background: rgba(0, 0, 0, 0.55);
      box-shadow: 0 0 0 1px rgba(255,255,255,0.35);
      font-style: italic;
    }
    .similarity-badge:hover {
      outline: 1px solid var(--vscode-focusBorder, #007acc);
      outline-offset: 1px;
    }
    .similar-popover {
      position: absolute;
      z-index: 1000;
      background: var(--vscode-editorWidget-background, #252526);
      color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 4px;
      padding: 10px;
      box-shadow: 0 6px 14px rgba(0,0,0,0.45);
      font-size: 12px;
      min-width: 240px;
    }
    .sp-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .sp-slider { flex: 1; cursor: pointer; }
    .sp-readout { font-weight: 600; min-width: 42px; text-align: right; }
    .sp-presets { display: flex; gap: 4px; flex-wrap: wrap; }
    .sp-preset {
      flex: 1;
      padding: 4px 6px;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: 1px solid transparent;
      border-radius: 3px;
      cursor: pointer;
      font: inherit;
    }
    .sp-preset:hover {
      background: var(--vscode-button-secondaryHoverBackground, #494b50);
    }
    .sp-preset.is-default {
      border-color: var(--vscode-focusBorder, #007acc);
    }
    .crosshair {
      position: absolute;
      width: 0;
      height: 0;
      pointer-events: none;
      display: none;
    }
    .crosshair::before,
    .crosshair::after {
      content: '';
      position: absolute;
      background: #ff4d4d;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.9);
    }
    .crosshair::before {
      width: 2px;
      height: 18px;
      left: -1px;
      top: -9px;
    }
    .crosshair::after {
      height: 2px;
      width: 18px;
      top: -1px;
      left: -9px;
    }
    .pattern-missing {
      color: var(--vscode-errorForeground, #f48771);
      font-style: italic;
      padding: 0 4px;
      border: 1px dashed currentColor;
      border-radius: 3px;
    }
    /* Syntax tokens — dark-theme defaults, overridden for light/high-contrast below */
    .tok-comment { color: #6a9955; font-style: italic; }
    .tok-string  { color: #ce9178; }
    .tok-number  { color: #b5cea8; }
    .tok-keyword { color: #c586c0; }
    .tok-builtin { color: #4ec9b0; }
    .tok-function { color: #dcdcaa; }
    .tok-decorator { color: #dcdcaa; }
    body.vscode-light .tok-comment  { color: #008000; }
    body.vscode-light .tok-string   { color: #a31515; }
    body.vscode-light .tok-number   { color: #098658; }
    body.vscode-light .tok-keyword  { color: #af00db; }
    body.vscode-light .tok-builtin  { color: #267f99; }
    body.vscode-light .tok-function { color: #795e26; }
    body.vscode-light .tok-decorator { color: #795e26; }
  </style>
</head>
<body>
${renderedLines}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let activeEl = null;

  // Track Ctrl/Cmd held state via mousemove so .pattern-img can flip between
  // pointer (default — test mode) and crosshair (Ctrl held — set targetOffset).
  // mousemove is the most reliable trigger because it covers cases where the
  // user enters the webview already holding the key.
  document.addEventListener('mousemove', (e) => {
    document.body.classList.toggle('ctrl-held', e.ctrlKey || e.metaKey);
  });
  window.addEventListener('blur', () => {
    document.body.classList.remove('ctrl-held');
  });

  document.addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('similarity-badge')) {
      e.stopPropagation();
      openSimilarityPopover(e.target.closest('.pattern-wrap'), e.target);
      return;
    }
    if (e.target.closest('.similar-popover')) {
      e.stopPropagation();
      return;
    }
    const wrap = e.target.closest('.pattern-wrap');
    if (wrap && (e.ctrlKey || e.metaKey)) {
      e.stopPropagation();
      e.preventDefault();
      handleImageClick(wrap, e);
      return;
    }
    if (wrap) {
      // Plain click on an image: launch the on-screen pattern test overlay.
      e.stopPropagation();
      e.preventDefault();
      handleTestClick(wrap);
      return;
    }
    const lineEl = e.target.closest('.line');
    if (!lineEl) return;
    const line = parseInt(lineEl.dataset.line, 10);
    if (!Number.isNaN(line)) {
      vscode.postMessage({ type: 'jumpToLine', line });
    }
  });

  // ── Similarity: wheel adjust + popover ──
  const SIMILAR_PRESETS = [0.5, 0.7, 0.8, 0.9, 0.95];
  const SIMILAR_DEFAULT = 0.7;
  let wheelTimer = null;

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function roundTo(v, step) { return Math.round(v / step) * step; }
  function formatSim(v) { return Math.round(clamp01(v) * 100) + '%'; }

  function setBadgeVisual(wrap, value) {
    const badge = wrap.querySelector('.similarity-badge');
    if (badge) {
      badge.textContent = formatSim(value);
      badge.classList.remove('default');
      // Always-visible when value differs from the implicit default (0.7).
      const isDefault = Math.abs(value - SIMILAR_DEFAULT) < 1e-6;
      badge.classList.toggle('is-set', !isDefault);
    }
    wrap.dataset.similar = String(value);
  }

  function commitSimilar(wrap, value) {
    const d = wrap.dataset;
    const intOrNull = (v) => (v === undefined ? null : parseInt(v, 10));
    vscode.postMessage({
      type: 'updateSimilarity',
      line: parseInt(d.line, 10),
      name: d.name,
      strCol: parseInt(d.strCol, 10),
      strEnd: parseInt(d.strEnd, 10),
      wrapEnd: intOrNull(d.wrapEnd),
      simCol: intOrNull(d.simCol),
      simEnd: intOrNull(d.simEnd),
      value: clamp01(value),
    });
  }

  document.addEventListener('wheel', (e) => {
    const wrap = e.target.closest('.pattern-wrap');
    if (!wrap) return;
    e.preventDefault();
    const current = parseFloat(wrap.dataset.similar || String(SIMILAR_DEFAULT));
    let step = 0.05;
    if (e.shiftKey) step = 0.01;
    if (e.altKey) step = 0.10;
    const dir = e.deltaY < 0 ? 1 : -1;
    let next = clamp01(current + dir * step);
    next = e.altKey ? roundTo(next, 0.1) : roundTo(next, step >= 0.05 ? 0.05 : 0.01);
    next = Math.round(next * 100) / 100;
    setBadgeVisual(wrap, next);
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => commitSimilar(wrap, parseFloat(wrap.dataset.similar)), 500);
  }, { passive: false });

  let activePopover = null;

  function closeSimilarityPopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
    document.removeEventListener('keydown', popoverKeyHandler);
  }

  function popoverKeyHandler(e) {
    if (e.key === 'Escape') closeSimilarityPopover();
  }

  function openSimilarityPopover(wrap, badge) {
    closeSimilarityPopover();
    if (!wrap || !badge) return;
    const initial = parseFloat(wrap.dataset.similar || String(SIMILAR_DEFAULT));
    const pct = Math.round(clamp01(initial) * 100);

    const presetsHtml = SIMILAR_PRESETS.map((v) => {
      const isDef = v === SIMILAR_DEFAULT;
      return '<button class="sp-preset' + (isDef ? ' is-default' : '') + '" data-val="' + v + '">' + Math.round(v * 100) + '%' + (isDef ? ' ·' : '') + '</button>';
    }).join('');

    const pop = document.createElement('div');
    pop.className = 'similar-popover';
    pop.innerHTML =
      '<div class="sp-row">' +
        '<input type="range" class="sp-slider" min="0" max="100" step="1" value="' + pct + '">' +
        '<span class="sp-readout">' + pct + '%</span>' +
      '</div>' +
      '<div class="sp-presets">' + presetsHtml + '</div>';
    document.body.appendChild(pop);
    activePopover = pop;

    const rect = badge.getBoundingClientRect();
    pop.style.left = Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - 260) + 'px';
    pop.style.top = (rect.bottom + window.scrollY + 6) + 'px';

    const slider = pop.querySelector('.sp-slider');
    const readout = pop.querySelector('.sp-readout');
    slider.addEventListener('input', () => {
      const v = parseInt(slider.value, 10) / 100;
      readout.textContent = Math.round(v * 100) + '%';
      setBadgeVisual(wrap, v);
    });
    slider.addEventListener('change', () => {
      commitSimilar(wrap, parseInt(slider.value, 10) / 100);
    });
    pop.querySelectorAll('.sp-preset').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const v = parseFloat(btn.dataset.val);
        setBadgeVisual(wrap, v);
        commitSimilar(wrap, v);
        closeSimilarityPopover();
      });
    });

    document.addEventListener('keydown', popoverKeyHandler);
    // Outside-click closes; bound after this tick so the opening click doesn't close it.
    setTimeout(() => {
      document.addEventListener('click', (ev) => {
        if (!ev.target.closest('.similar-popover') && !ev.target.classList.contains('similarity-badge')) {
          closeSimilarityPopover();
        }
      }, { once: true, capture: true });
    }, 0);
  }

  function handleImageClick(wrap, evt) {
    const img = wrap.querySelector('.pattern-img');
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const rect = img.getBoundingClientRect();
    const localX = evt.clientX - rect.left;
    const localY = evt.clientY - rect.top;
    const dxCss = localX - rect.width / 2;
    const dyCss = localY - rect.height / 2;
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const offsetX = Math.round(dxCss * scaleX);
    const offsetY = Math.round(dyCss * scaleY);

    const d = wrap.dataset;
    const intOrNull = (v) => (v === undefined ? null : parseInt(v, 10));
    vscode.postMessage({
      type: 'updateTargetOffset',
      line: parseInt(d.line, 10),
      name: d.name,
      strCol: parseInt(d.strCol, 10),
      strEnd: parseInt(d.strEnd, 10),
      wrapEnd: intOrNull(d.wrapEnd),
      offCol: intOrNull(d.offCol),
      offEnd: intOrNull(d.offEnd),
      offsetX,
      offsetY,
    });
  }

  function handleTestClick(wrap) {
    const d = wrap.dataset;
    const intOrNull = (v) => (v === undefined ? null : parseInt(v, 10));
    vscode.postMessage({
      type: 'testPattern',
      line: parseInt(d.line, 10),
      name: d.name,
      strCol: parseInt(d.strCol, 10),
      strEnd: parseInt(d.strEnd, 10),
      wrapEnd: intOrNull(d.wrapEnd),
      simCol: intOrNull(d.simCol),
      simEnd: intOrNull(d.simEnd),
      similarity: parseFloat(d.similar || '0.7'),
    });
  }

  // Right-click on a thumbnail → recapture (overwrite the underlying PNG).
  document.addEventListener('contextmenu', (e) => {
    const wrap = e.target.closest('.pattern-wrap');
    if (!wrap) return;
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'recapturePattern', name: wrap.dataset.name });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'activeLine' && typeof msg.line === 'number') {
      const next = document.querySelector('.line[data-line="' + msg.line + '"]');
      if (activeEl && activeEl !== next) activeEl.classList.remove('active');
      if (next) {
        next.classList.add('active');
        activeEl = next;
        // Only scroll if the line is not already visible.
        const rect = next.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
          next.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    }
  });

  function positionCrosshair(wrap) {
    const img = wrap.querySelector('.pattern-img');
    const ch = wrap.querySelector('.crosshair');
    if (!img || !ch) return;
    const ox = parseFloat(wrap.dataset.offsetX);
    const oy = parseFloat(wrap.dataset.offsetY);
    if (Number.isNaN(ox) || Number.isNaN(oy)) return;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const scaleX = img.clientWidth / img.naturalWidth;
    const scaleY = img.clientHeight / img.naturalHeight;
    const x = img.offsetLeft + img.clientWidth / 2 + ox * scaleX;
    const y = img.offsetTop + img.clientHeight / 2 + oy * scaleY;
    ch.style.left = x + 'px';
    ch.style.top = y + 'px';
    ch.style.display = 'block';
  }

  function setupCrosshairs() {
    document.querySelectorAll('.pattern-wrap').forEach((wrap) => {
      const img = wrap.querySelector('.pattern-img');
      if (!img) return;
      const place = () => positionCrosshair(wrap);
      if (img.complete && img.naturalWidth) place();
      else img.addEventListener('load', place);
    });
  }

  setupCrosshairs();
  window.addEventListener('resize', () => {
    document.querySelectorAll('.pattern-wrap').forEach(positionCrosshair);
  });
</script>
</body>
</html>`;
  }

  private renderClosedDocHtml(): string {
    return `<!DOCTYPE html>
<html><body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px;">
<p>The source document is no longer open. Close this preview and reopen it from the source file.</p>
</body></html>`;
  }

  private renderNoActiveDocHtml(): string {
    return `<!DOCTYPE html>
<html><body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px;">
<p>Focus a Python editor tab to update this shared preview.</p>
</body></html>`;
  }
}

type TokenType =
  | 'comment' | 'string' | 'number' | 'keyword' | 'builtin'
  | 'function' | 'decorator' | 'identifier' | 'punctuation'
  | 'whitespace' | 'other';

type Token = { type: TokenType; text: string; col: number };

const PY_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from',
  'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
  'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  'None', 'True', 'False', 'self',
]);

// OculiX vocabulary + common Python builtins users see frequently.
const SIKULI_BUILTINS = new Set([
  'Pattern', 'Region', 'Screen', 'App', 'Key', 'Mouse', 'Env',
  'wait', 'waitVanish', 'click', 'doubleClick', 'rightClick', 'hover',
  'find', 'findAll', 'exists', 'dragDrop', 'drag', 'dropAt', 'type', 'paste',
  'press', 'keyDown', 'keyUp', 'mouseDown', 'mouseUp',
  'targetOffset', 'similar', 'highlight', 'highlightOn', 'highlightOff',
  'print', 'sleep', 'len', 'range', 'str', 'int', 'float', 'bool', 'list', 'dict',
]);

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    const ch = line[i];

    if (ch === '#') {
      tokens.push({ type: 'comment', text: line.slice(i), col: i });
      break;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\' && j + 1 < n) { j += 2; continue; }
        if (line[j] === ch) { j++; break; }
        j++;
      }
      tokens.push({ type: 'string', text: line.slice(i, j), col: i });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9._]/.test(line[j])) j++;
      tokens.push({ type: 'number', text: line.slice(i, j), col: i });
      i = j;
      continue;
    }

    // Float starting with `.` (e.g., `.50`). Only when followed by a digit —
    // `.foo` stays as `.` punctuation + `foo` identifier (attribute access).
    if (ch === '.' && i + 1 < n && /[0-9]/.test(line[i + 1])) {
      let j = i + 1;
      while (j < n && /[0-9_]/.test(line[j])) j++;
      tokens.push({ type: 'number', text: line.slice(i, j), col: i });
      i = j;
      continue;
    }

    if (ch === '@' && i + 1 < n && /[A-Za-z_]/.test(line[i + 1])) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.]/.test(line[j])) j++;
      tokens.push({ type: 'decorator', text: line.slice(i, j), col: i });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++;
      const word = line.slice(i, j);
      let type: TokenType = 'identifier';
      if (PY_KEYWORDS.has(word)) {
        type = 'keyword';
      } else if (SIKULI_BUILTINS.has(word)) {
        type = 'builtin';
      } else {
        let k = j;
        while (k < n && /\s/.test(line[k])) k++;
        if (line[k] === '(') type = 'function';
      }
      tokens.push({ type, text: word, col: i });
      i = j;
      continue;
    }

    if (/\s/.test(ch)) {
      let j = i;
      while (j < n && /\s/.test(line[j])) j++;
      tokens.push({ type: 'whitespace', text: line.slice(i, j), col: i });
      i = j;
      continue;
    }

    tokens.push({ type: 'punctuation', text: ch, col: i });
    i++;
  }
  return tokens;
}

function renderLine(
  line: string,
  lineIdx: number,
  docUri: vscode.Uri,
  webview: vscode.Webview
): string {
  const tokens = tokenize(line);
  const hidden = new Set<number>();
  const imageHtml = new Map<number, string>();

  // First pass: find image-reference string tokens, optionally hide their `Pattern(...)` wrapper.
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== 'string') continue;
    const imgMatch = tok.text.match(/^["']([^"'\n]+\.png)["']$/i);
    if (!imgMatch) continue;

    const filename = imgMatch[1];
    const imagePath = resolveImagePath(docUri, filename);
    if (!imagePath) {
      imageHtml.set(i, `<span class="pattern-missing" title="Image not found">${escapeHtml(tok.text)}</span>`);
      continue;
    }

    // Wrapper detection: previous non-whitespace must be `(`, the one before it `Pattern`.
    let isPatternWrapped = false;
    let patternTok = -1;
    let closeParen = -1;
    {
      let left = i - 1;
      while (left >= 0 && tokens[left].type === 'whitespace') left--;
      if (left >= 0 && tokens[left].text === '(') {
        const innerLeft = left - 1;
        let pl = innerLeft;
        while (pl >= 0 && tokens[pl].type === 'whitespace') pl--;
        if (pl >= 0 && tokens[pl].text === 'Pattern') {
          let right = i + 1;
          while (right < tokens.length && tokens[right].type === 'whitespace') right++;
          if (right < tokens.length && tokens[right].text === ')') {
            isPatternWrapped = true;
            patternTok = pl;
            closeParen = right;
          }
        }
      }
    }

    // If wrapped, parse any chained `.targetOffset(x, y)` and/or `.similar(value)`
    // after the closing paren (either order). Both are hidden in the preview;
    // targetOffset drives the crosshair, similar drives the percentage badge.
    let offset: { x: number; y: number } | null = null;
    let similarity: number | null = null;
    let chainEndIdx = -1;
    let offsetStartIdx = -1;
    let offsetEndIdx = -1;
    let similarStartIdx = -1;
    let similarEndIdx = -1;
    if (isPatternWrapped) {
      const chain = parseChain(tokens, closeParen + 1);
      if (chain) {
        chainEndIdx = chain.endIdx;
        if (chain.targetOffset) {
          offset = { x: chain.targetOffset.x, y: chain.targetOffset.y };
          offsetStartIdx = chain.targetOffset.startIdx;
          offsetEndIdx = chain.targetOffset.endIdx;
        }
        if (chain.similar) {
          similarity = chain.similar.value;
          similarStartIdx = chain.similar.startIdx;
          similarEndIdx = chain.similar.endIdx;
        }
      }
    }

    const source: ImageSourceInfo = {
      lineIdx,
      strCol: tok.col,
      strEnd: tok.col + tok.text.length,
    };
    if (isPatternWrapped) {
      source.wrapEnd = tokens[closeParen].col + 1;
    }
    if (offset && offsetStartIdx >= 0 && offsetEndIdx >= 0) {
      source.offCol = tokens[offsetStartIdx].col;
      source.offEnd = tokens[offsetEndIdx].col + 1;
    }
    if (similarity !== null && similarStartIdx >= 0 && similarEndIdx >= 0) {
      source.simCol = tokens[similarStartIdx].col;
      source.simEnd = tokens[similarEndIdx].col + 1;
    }

    imageHtml.set(i, buildImageHtml(filename, imagePath, webview, source, offset, similarity));

    if (isPatternWrapped) {
      for (let k = patternTok; k <= closeParen; k++) {
        if (k !== i) hidden.add(k);
      }
      if (chainEndIdx >= 0) {
        for (let k = closeParen + 1; k <= chainEndIdx; k++) hidden.add(k);
      }
    }
  }

  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    if (hidden.has(i)) continue;
    if (imageHtml.has(i)) {
      out += imageHtml.get(i);
      continue;
    }
    const tok = tokens[i];
    if (tok.type === 'whitespace') {
      out += escapeHtml(tok.text);
    } else if (tok.type === 'punctuation' || tok.type === 'identifier' || tok.type === 'other') {
      out += escapeHtml(tok.text);
    } else {
      out += `<span class="tok-${tok.type}">${escapeHtml(tok.text)}</span>`;
    }
  }
  return out || '&nbsp;';
}

function parseSimilar(
  tokens: Token[],
  startIdx: number
): { startIdx: number; endIdx: number; value: number } | null {
  let i = startIdx;
  const skipWs = () => {
    while (i < tokens.length && tokens[i].type === 'whitespace') i++;
  };

  skipWs();
  if (i >= tokens.length || tokens[i].text !== '.') return null;
  const dotIdx = i;
  i++;
  skipWs();
  if (i >= tokens.length || tokens[i].text !== 'similar') return null;
  i++;
  skipWs();
  if (i >= tokens.length || tokens[i].text !== '(') return null;
  i++;
  skipWs();

  let sign = 1;
  if (i < tokens.length && tokens[i].text === '-') { sign = -1; i++; }
  else if (i < tokens.length && tokens[i].text === '+') { i++; }
  if (i >= tokens.length || tokens[i].type !== 'number') return null;
  const value = sign * parseFloat(tokens[i].text);
  if (!Number.isFinite(value)) return null;
  i++;
  skipWs();
  if (i >= tokens.length || tokens[i].text !== ')') return null;

  return { startIdx: dotIdx, endIdx: i, value };
}

type ChainResult = {
  endIdx: number;
  targetOffset: { startIdx: number; endIdx: number; x: number; y: number } | null;
  similar: { startIdx: number; endIdx: number; value: number } | null;
};

function parseChain(tokens: Token[], startIdx: number): ChainResult | null {
  let i = startIdx;
  let endIdx = -1;
  let targetOffset: ChainResult['targetOffset'] = null;
  let similar: ChainResult['similar'] = null;

  while (true) {
    const o = parseTargetOffset(tokens, i);
    if (o && !targetOffset) {
      targetOffset = o;
      i = o.endIdx + 1;
      endIdx = o.endIdx;
      continue;
    }
    const s = parseSimilar(tokens, i);
    if (s && !similar) {
      similar = s;
      i = s.endIdx + 1;
      endIdx = s.endIdx;
      continue;
    }
    break;
  }

  if (!targetOffset && !similar) return null;
  return { endIdx, targetOffset, similar };
}

function parseTargetOffset(
  tokens: Token[],
  startIdx: number
): { startIdx: number; endIdx: number; x: number; y: number } | null {
  let i = startIdx;
  const skipWs = () => {
    while (i < tokens.length && tokens[i].type === 'whitespace') i++;
  };

  const readSignedNumber = (): number | null => {
    let sign = 1;
    if (i < tokens.length && tokens[i].text === '-') {
      sign = -1;
      i++;
    } else if (i < tokens.length && tokens[i].text === '+') {
      i++;
    }
    if (i >= tokens.length || tokens[i].type !== 'number') return null;
    const value = sign * parseFloat(tokens[i].text);
    i++;
    return Number.isFinite(value) ? value : null;
  };

  skipWs();
  if (i >= tokens.length || tokens[i].text !== '.') return null;
  const dotIdx = i;
  i++;
  skipWs();
  if (i >= tokens.length || tokens[i].text !== 'targetOffset') return null;
  i++;
  skipWs();
  if (i >= tokens.length || tokens[i].text !== '(') return null;
  i++;
  skipWs();

  const x = readSignedNumber();
  if (x === null) return null;
  skipWs();
  if (i >= tokens.length || tokens[i].text !== ',') return null;
  i++;
  skipWs();

  const y = readSignedNumber();
  if (y === null) return null;
  skipWs();
  if (i >= tokens.length || tokens[i].text !== ')') return null;

  return { startIdx: dotIdx, endIdx: i, x, y };
}

type ImageSourceInfo = {
  lineIdx: number;
  strCol: number;         // column of opening quote of "*.png" literal
  strEnd: number;         // column right after closing quote
  wrapEnd?: number;       // column right after `)` of Pattern(...) — present only if wrapped
  offCol?: number;        // column of `.` of `.targetOffset(...)` — present only if matched
  offEnd?: number;        // column right after `)` of `.targetOffset(...)`
  simCol?: number;        // column of `.` of `.similar(...)` — present only if explicit
  simEnd?: number;        // column right after `)` of `.similar(...)`
};

const DEFAULT_SIMILARITY = 0.7;

function buildImageHtml(
  filename: string,
  imagePath: string,
  webview: vscode.Webview,
  source: ImageSourceInfo,
  offset: { x: number; y: number } | null,
  similarity: number | null
): string {
  const webUri = webview.asWebviewUri(vscode.Uri.file(imagePath));
  // Append the file's mtime so the browser cache reloads the image after a
  // recapture (the URL changes even though the path is the same).
  let imgSrc = webUri.toString();
  try {
    imgSrc = `${imgSrc}?v=${fs.statSync(imagePath).mtimeMs}`;
  } catch { /* stat may fail; use unversioned URL */ }
  const safeName = escapeHtml(filename);
  const parts: string[] = [filename];
  if (offset) parts.push(`targetOffset(${offset.x}, ${offset.y})`);
  if (similarity !== null) parts.push(`similar(${similarity})`);
  parts.push('Click: test pattern  ·  Ctrl/⌘+Click: set targetOffset  ·  Right-click: recapture');
  const titleText = parts.join(' — ');
  const img = `<img class="pattern-img" src="${imgSrc}" alt="${safeName}" title="${escapeHtml(titleText)}">`;

  const effectiveSimilarity = similarity !== null ? similarity : DEFAULT_SIMILARITY;
  const isDefaultSim = similarity === null;

  const attrs: string[] = [
    `data-line="${source.lineIdx}"`,
    `data-name="${safeName}"`,
    `data-str-col="${source.strCol}"`,
    `data-str-end="${source.strEnd}"`,
    `data-similar="${effectiveSimilarity}"`,
  ];
  if (source.wrapEnd !== undefined) attrs.push(`data-wrap-end="${source.wrapEnd}"`);
  if (source.offCol !== undefined) attrs.push(`data-off-col="${source.offCol}"`);
  if (source.offEnd !== undefined) attrs.push(`data-off-end="${source.offEnd}"`);
  if (source.simCol !== undefined) attrs.push(`data-sim-col="${source.simCol}"`);
  if (source.simEnd !== undefined) attrs.push(`data-sim-end="${source.simEnd}"`);
  if (offset) {
    attrs.push(`data-offset-x="${offset.x}"`);
    attrs.push(`data-offset-y="${offset.y}"`);
  }

  const hasMeaningfulOffset = offset !== null && (offset.x !== 0 || offset.y !== 0);
  const crosshair = hasMeaningfulOffset ? `<span class="crosshair"></span>` : '';
  const badgeTitle = isDefaultSim
    ? `similar: ${effectiveSimilarity} (default — click or scroll to set)`
    : `similar: ${effectiveSimilarity} — click or scroll to change`;
  // Pin the badge as always-visible when an explicit value differs from the default.
  const isPinned = !isDefaultSim && Math.abs(effectiveSimilarity - DEFAULT_SIMILARITY) > 1e-6;
  const badgeClasses = ['similarity-badge'];
  if (isDefaultSim) badgeClasses.push('default');
  if (isPinned) badgeClasses.push('is-set');
  const badge = `<span class="${badgeClasses.join(' ')}" title="${escapeHtml(badgeTitle)}">${Math.round(effectiveSimilarity * 100)}%</span>`;

  return `<span class="pattern-wrap" ${attrs.join(' ')}>${img}${badge}${crosshair}</span>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSimilarValue(value: number): string {
  // Round to 2 decimals; toString drops trailing zeros (0.5 not 0.50).
  const clamped = Math.max(0, Math.min(1, value));
  return (Math.round(clamped * 100) / 100).toString();
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
