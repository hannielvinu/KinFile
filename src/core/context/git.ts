// Git co-change index: "files that changed together, change together".
// Built once per workspace from `git log --name-only` (bounded), then cached in memory.
import { execFile } from 'child_process';

export interface CoChange {
  file: string;
  together: number;   // commits where both files changed
  seedCommits: number; // commits touching the seed file
  confidence: number; // together / seedCommits
}

const MAX_COMMITS = 3000;
const MAX_FILES_PER_COMMIT = 40; // ignore sweeping refactors / formatting commits

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export class CoChangeIndex {
  private commitsByFile = new Map<string, number[]>();
  private filesByCommit: string[][] = [];
  private renames = new Map<string, string>(); // old path -> current path
  ready = false;
  commitCount = 0;

  constructor(private root: string) {}

  async build(): Promise<void> {
    let out: string;
    try {
      out = await git(this.root, ['log', `-n${MAX_COMMITS}`, '--no-merges', '--name-status', '-M', '--format=%x00%H']);
    } catch {
      this.ready = true; // not a git repo: the index is simply empty
      return;
    }
    const tracked = new Set((await git(this.root, ['ls-files']).catch(() => '')).split('\n').filter(Boolean));
    const commits = out.split('\x00').slice(1);
    // Walk newest -> oldest so rename chains resolve to the current path.
    for (const block of commits) {
      const lines = block.split('\n').slice(1).filter(Boolean);
      const files: string[] = [];
      for (const line of lines) {
        const parts = line.split('\t');
        const status = parts[0];
        if (status.startsWith('R') && parts.length >= 3) {
          const [, oldP, newP] = parts;
          const cur = this.renames.get(newP) ?? newP;
          this.renames.set(oldP, cur);
          files.push(cur);
        } else if (parts[1]) {
          files.push(this.renames.get(parts[1]) ?? parts[1]);
        }
      }
      const live = [...new Set(files)].filter(f => tracked.size === 0 || tracked.has(f));
      if (live.length === 0 || live.length > MAX_FILES_PER_COMMIT) continue;
      const ci = this.filesByCommit.length;
      this.filesByCommit.push(live);
      for (const f of live) {
        const arr = this.commitsByFile.get(f) ?? [];
        arr.push(ci);
        this.commitsByFile.set(f, arr);
      }
    }
    this.commitCount = this.filesByCommit.length;
    this.ready = true;
  }

  commitsTouching(file: string): number {
    return this.commitsByFile.get(file)?.length ?? 0;
  }

  related(file: string, limit = 8, minTogether = 2): CoChange[] {
    const commits = this.commitsByFile.get(file);
    if (!commits) return [];
    const counts = new Map<string, number>();
    for (const ci of commits) for (const f of this.filesByCommit[ci]) if (f !== file) counts.set(f, (counts.get(f) ?? 0) + 1);
    return [...counts.entries()]
      .filter(([, n]) => n >= minTogether)
      .map(([f, n]) => ({ file: f, together: n, seedCommits: commits.length, confidence: n / commits.length }))
      .sort((a, b) => b.together - a.together)
      .slice(0, limit);
  }
}
