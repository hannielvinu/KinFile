// Inline edit: select code, press Ctrl+Alt+K (Cmd+Alt+K), type an instruction, review the diff hunk by hunk.
import * as vscode from 'vscode';
import { KinfileService, cfg } from './service';
import { KinfileRun, UiEvent } from '../core/run';
import { inlineSpec } from '../core/agentSpec';
import { extractReplacement, matchIndent } from '../core/stage';
import { AgentPanel } from './panel';

let active: KinfileRun | undefined;

export async function cancelInline(): Promise<boolean> {
  if (!active) return false;
  await active.cancel();
  return true;
}

export async function inlineEdit(svc: KinfileService, panel: AgentPanel, presetInstruction?: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') { vscode.window.showWarningMessage('Kinfile: open a file and select the code to edit.'); return; }
  if (active) { vscode.window.showWarningMessage('Kinfile: an inline edit is already running (Esc or "Kinfile: Stop" cancels it).'); return; }
  const doc = editor.document;
  // Work on whole lines so the diff is clean.
  let { start, end } = editor.selection;
  if (editor.selection.isEmpty) { start = new vscode.Position(start.line, 0); end = doc.lineAt(start.line).range.end; }
  if (end.character === 0 && end.line > start.line) end = doc.lineAt(end.line - 1).range.end;
  const range = new vscode.Range(new vscode.Position(start.line, 0), doc.lineAt(end.line).range.end);
  const selected = doc.getText(range);
  const rel = svc.ws.rel(doc.uri.fsPath);

  const instruction = presetInstruction ?? await vscode.window.showInputBox({
    title: `Kinfile · edit ${rel}:${range.start.line + 1}-${range.end.line + 1}`,
    prompt: 'Describe the change in plain language',
    placeHolder: 'e.g. also treat "off" and "n" as false and update the docstring',
    ignoreFocusOut: true,
  });
  if (!instruction) return;

  let models: string[];
  try { await svc.index(); models = await svc.models(); }
  catch (e: any) { vscode.window.showErrorMessage(`Kinfile: ${e?.message ?? e}`); return; }

  const lines = doc.getText().split('\n');
  const before = lines.slice(Math.max(0, range.start.line - 30), range.start.line).join('\n');
  const after = lines.slice(range.end.line + 1, range.end.line + 31).join('\n');
  const kin = svc.kin.related(rel, 3).map(k => `${k.file} (changed together in ${k.together} commits)`).join(', ');
  const message = [
    `File: ${rel} (${doc.languageId}), lines ${range.start.line + 1}-${range.end.line + 1} are selected.`,
    kin ? `Files that usually change with this one: ${kin}. You only edit the selection here.` : '',
    `Code just before the selection (read-only):\n\`\`\`\n${before}\n\`\`\``,
    `SELECTED CODE (rewrite this):\n\`\`\`\n${selected}\n\`\`\``,
    `Code just after the selection (read-only):\n\`\`\`\n${after}\n\`\`\``,
    `Instruction: ${instruction}`,
    'Return only the full replacement for the SELECTED CODE in one fenced code block.',
  ].filter(Boolean).join('\n\n');

  panel.post({ type: 'user', text: `Inline edit · ${rel}:${range.start.line + 1}-${range.end.line + 1}\n${instruction}` });
  let streamed = '';
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Kinfile', cancellable: true }, async (progress, token) => {
    const run = new KinfileRun(svc.tf, m => inlineSpec(m, cfg<string>('reasoningEffort', 'low') || undefined), { models, retryBackoffMs: 1500, firstEventTimeoutMs: cfg('firstResponseTimeoutSeconds', 120) * 1000 }, {
      emit: (e: UiEvent) => {
        panel.post({ type: 'event', e });
        if (e.kind === 'model') progress.report({ message: `asking ${e.model}…` });
        if (e.kind === 'delta') { streamed += e.text; progress.report({ message: `streaming ${streamed.length} chars: …${streamed.slice(-60).replace(/\s+/g, ' ')}` }); }
        if (e.kind === 'relay') { progress.report({ message: e.text }); if (e.level !== 'info') vscode.window.showWarningMessage(`Kinfile: ${e.text}`); }
      },
      review: () => Promise.reject(new Error('no tools in inline mode')),
      approveCommand: async () => false,
    });
    active = run;
    token.onCancellationRequested(() => { run.cancel(); });
    progress.report({ message: 'starting…' });
    const result = await run.start(message).finally(() => { active = undefined; });
    if (result.status === 'cancelled') { vscode.window.showInformationMessage('Kinfile: inline edit cancelled. Nothing was changed.'); return; }
    if (result.status === 'error') { vscode.window.showErrorMessage(`Kinfile: ${result.error ?? 'model error'}. Your files were not changed.`); return; }

    let replacement = matchIndent(selected, extractReplacement(result.text));
    // Keep the selection's trailing whitespace (e.g. the blank line after a function) exactly as it was.
    const trailing = selected.match(/\s*$/)?.[0] ?? '';
    replacement = replacement.replace(/\s+$/, '') + trailing;
    const full = doc.getText();
    const startOff = doc.offsetAt(range.start), endOff = doc.offsetAt(range.end);
    const proposed = full.slice(0, startOff) + replacement + full.slice(endOff);
    if (proposed === full) { vscode.window.showInformationMessage('Kinfile: the model proposed no change.'); return; }
    progress.report({ message: 'review the diff in the editor' });
    const outcome = await svc.review({ key: `inline-${Date.now()}`, tool: 'inline', path: rel, before: full, proposed, isNew: false, explanation: instruction });
    panel.post({ type: 'event', e: { kind: 'approval', id: `inline-${Date.now()}`, tool: 'inline', summary: `${rel}: ${outcome.accepted} hunk(s) accepted, ${outcome.rejected} rejected`, state: outcome.accepted === 0 ? 'rejected' : outcome.rejected ? 'partial' : 'accepted' } });
  });
}
