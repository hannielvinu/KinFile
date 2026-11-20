import * as vscode from 'vscode';
import { KinfileService } from './service';
import { AgentPanel } from './panel';
import { cancelInline, inlineEdit } from './inline';

let service: KinfileService | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('Kinfile');
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    service = new KinfileService(folder.uri.fsPath, out);
    ctx.subscriptions.push(service);
    service.index().catch(e => out.appendLine(`Indexing failed: ${e}`));
  }
  const panel = new AgentPanel(ctx, () => service);
  ctx.subscriptions.push(
    out,
    vscode.window.registerWebviewViewProvider(AgentPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('kinfile.inlineEdit', (instruction?: unknown) => (service ? inlineEdit(service, panel, typeof instruction === 'string' ? instruction : undefined) : vscode.window.showWarningMessage('Kinfile: open a folder first.'))),
    // Same as typing in the panel; also handy for scripted demos and tests.
    vscode.commands.registerCommand('kinfile.runAgent', async (text?: unknown) => { await panel.show(); return panel.startRun(typeof text === 'string' ? text : ''); }),
    vscode.commands.registerCommand('kinfile.openAgent', async () => { await panel.show(); panel.post({ type: 'focusInput' }); }),
    vscode.commands.registerCommand('kinfile.stop', async () => {
      const a = await cancelInline();
      if (panel.running) await panel.stop();
      if (!a && !panel.running) vscode.window.setStatusBarMessage('Kinfile: nothing is running', 2000);
    }),
    vscode.commands.registerCommand('kinfile.showContext', async () => {
      if (!service) return;
      const q = await vscode.window.showInputBox({ prompt: 'Request to preview Kinfile context selection for' });
      if (!q) return;
      await service.index();
      const p = service.engine.assemble(q, { budgetTokens: vscode.workspace.getConfiguration('kinfile').get('contextBudgetTokens', 32000) });
      await panel.show();
      panel.post({ type: 'user', text: `(context preview) ${q}` });
      panel.post({ type: 'receipt', receipt: p.receipt });
    }),
    vscode.commands.registerCommand('kinfile.refreshModels', () => panel.refreshModels()),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('kinfile')) panel.refreshModels(); }),
  );
}

export function deactivate(): void {
  service?.dispose();
}
