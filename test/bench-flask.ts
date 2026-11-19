import { Workspace } from '../src/core/context/workspace';
import { SymbolIndex } from '../src/core/context/symbols';
import { CoChangeIndex } from '../src/core/context/git';
import { ContextEngine, receiptMarkdown } from '../src/core/context/retrieve';
(async () => {
  const root = process.argv[2];
  const t0 = Date.now();
  const ws = new Workspace(root); await ws.init();
  const sy = new SymbolIndex(root); await sy.build(ws.files);
  const kin = new CoChangeIndex(root); await kin.build();
  console.log(`index: ${ws.files.length} files, ${kin.commitCount} commits, ${Date.now() - t0} ms`);
  const eng = new ContextEngine(ws, sy, kin);
  const B = `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`;
  const p = eng.assemble(B, { budgetTokens: 32000 });
  console.log(receiptMarkdown(p.receipt)); console.log('dropped:', p.receipt.dropped.map(d => d.file).join(', '));
  console.log('terms:', p.receipt.terms.join(' '));
})();
