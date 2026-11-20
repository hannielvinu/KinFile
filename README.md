# Kinfile

**Files that changed together, change together.**

Kinfile is a VS Code coding agent whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge). It works in repositories larger than a model's context window by asking the repository's own history which files belong to a change. It shows *why* each file was picked, and nothing reaches disk until you accept it hunk by hunk.

Built by team **ZeroBix** for the TrueFoundry Forge-a-thon (Techfest 2026-27, IIT Bombay).

| Capability | How Kinfile does it |
|---|---|
| Inline edit | Select code → `Ctrl+Alt+K` (`Cmd+Alt+K`) → plain-language instruction → the diff opens in the editor with **Accept / Reject on every hunk** |
| Agent mode | Agent panel: one request drives a TrueForge agent through the tool loop (read, search, related files, propose edit, run command) until it is done; it finds the files itself |
| Context assembly | `@file` / `@symbol` mentions **plus** automatic retrieval: text match + symbol definitions + **git co-change** + test pairing, packed into a token budget and shown as a **Context Receipt** (file, reason, tokens) |
| Diff review | Every write is a TrueForge **tool approval**; Kinfile turns it into a per-hunk review. Only an accepted hunk is written, as one undoable edit. **Undo**: `Ctrl+Alt+Z` / "Kinfile: Undo Last Applied Change" |
| Streaming + cancel | Tokens stream from TrueForge events into the panel and the inline-edit notification. **Stop** (or `Ctrl+Alt+Backspace`) cancels the TrueForge turn at once; unreviewed hunks are discarded, so nothing is half-applied |
| Resilience | **Relay**: on a model failure, Kinfile retries once with backoff, then **reruns the same request on the next configured model automatically**. The workspace is untouched because nothing was staged to disk |

## Starting point

**From scratch.** No upstream editor project was forked; there is no fork commit to declare. Kinfile uses ordinary open-source dependencies only (see `THIRD_PARTY_NOTICES.md`): `@modelcontextprotocol/sdk` (MIT), `zod` (MIT), `diff` (BSD-3-Clause). The agent loop is TrueForge's; Kinfile never calls a model provider directly.

## Setup (from a clean clone)

Requirements: Node.js 22.14+ (for TrueForge), VS Code 1.90+, git.

```bash
git clone https://github.com/hannielvinu/KinFile.git
cd KinFile
npm install
npm run build
```

### 1. Start TrueForge locally (terminal 1)

```bash
npm run trueforge
```

This runs `npx @truefoundry/trueforge@latest` (local mode, SQLite, http://localhost:8790) with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`. TrueForge blocks private hosts by default, and Kinfile's editor tools are served to it by an MCP server on `127.0.0.1`. Without this variable TrueForge refuses to call them. Equivalent manual command:

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest
```

### 2. Configure models and load the agent definition (terminal 2)

```bash
cp config/trueforge.example.json config/trueforge.local.json
```

Put your keys in `config/trueforge.local.json`, or keep `"$GEMINI_API_KEY"` / `"$GROQ_API_KEY"` there and export those variables. The local file is git-ignored. Then:

```bash
npm run setup
```

This registers the model providers in TrueForge and loads the agent definition `agent/kinfile.agent.json`.

**Gemini 3 note:** Gemini 3 models require each tool call's *thought signature* to be sent back on the next request, and TrueForge's OpenAI-compatible provider drops it. The example config therefore points Gemini at a small local relay that restores the signatures and retries free-tier 429/503 responses. Run it next to TrueForge:

```bash
node scripts/model-relay.mjs
``` Any provider TrueForge supports works (OpenAI, Anthropic, Gemini, Fireworks, Together, an AI gateway, or a local OpenAI-compatible server such as Ollama). The extension is not tied to one provider; you can also add models in the TrueForge UI at http://localhost:8790.

### 3. Run the extension

Open this folder in VS Code and press **F5** ("Run Kinfile"). In the window that opens, open the project you want to work on (for example `pallets/flask` at tag `3.1.3`). To install it permanently instead:

```bash
npm run package
```

```bash
code --install-extension kinfile-0.1.0.vsix
```

### 4. Choose models (fallback order)

In VS Code settings:

```json
"kinfile.models": ["nvidia/kimi-k3-1-pro", "gemini/gemini-3-1-flash-lite"]
```

The first model is primary; the next ones take over automatically. If the list is empty, Kinfile uses every model configured in TrueForge, in TrueForge's order. Switching models needs no code change: edit this list, or the providers in TrueForge.

## Using it

- **Inline edit:** select code, `Ctrl+Alt+K`, type the instruction. The proposal opens as a *Kinfile proposal* tab: removed lines in red, added lines in green, and `Accept hunk n / Reject` above every hunk (plus Accept all / Reject all).
- **Agent mode:** open the Kinfile view in the activity bar (`Ctrl+Alt+L`) and type a request. The panel shows the Context Receipt, the scout subagent, each tool call, approval cards and the streamed answer, plus a link to the TrueForge session.
- **Mentions:** type `@` in the panel to insert a file, or write `@SymbolName`. Mentioned files are always included.
- **Preview context only:** "Kinfile: Preview Context Selection".

## Architecture on TrueForge

```
VS Code extension (Kinfile)                         TrueForge (local mode, :8790)
┌──────────────────────────────────┐   HTTP + SSE   ┌──────────────────────────────┐
│ Agent panel / inline edit        │ ─────────────► │ sessions · turns · streaming │
│ Context engine (receipt, budget) │ ◄───────────── │ agent loop + model call      │
│ Relay (retry → next model)       │                │ tool approval (pause/resume) │
│ Review controller (hunks, undo)  │ ◄── approval ──│ dynamic subagents ("scout")  │
│ MCP server "kinfile-editor"      │ ◄── MCP/HTTP ──│ deferred tool loading        │
│  read_file search_code           │                │ context compaction           │
│  related_files find_symbol       │                └──────────────────────────────┘
│  list_files propose_edit         │                       │ provider API
│  create_file run_command         │                       ▼
└──────────────────────────────────┘                 any configured model
```

1. Kinfile builds a Context Receipt for the request and starts a TrueForge session from the agent spec in `src/core/agentSpec.ts` (exported to `agent/kinfile.agent.json`), with the chosen model.
2. The turn streams over SSE. The agent calls Kinfile's MCP tools. `propose_edit`, `create_file` and `run_command` are listed in `require_approval_for_tools`, so TrueForge pauses with `tool.approval_required`.
3. Kinfile reads the paused tool call's arguments, stages the proposal in memory, and opens the hunk review. Accepted hunks are written as one undoable edit. Kinfile then answers the approval (`user.tool_approval`), and the tool reports to the agent what was applied or rejected. Invalid edits (for example `old_string` not found) are denied with the reason, so the model corrects itself.
4. TrueForge features used: **sessions/turns + streaming**, **MCP tools**, **tool approval**, **dynamic subagents** (the agent is told to send a "scout" first; it shows as a separate thread in the session), **deferred tool loading** (only `read_file`, `search_code`, `related_files` and `propose_edit` are preloaded; the rest are discovered with `list_tools` / `call_tool`), and **context compaction** (triggered at 60k estimated input tokens; large tool responses are offloaded).

## How context is selected

For each request Kinfile scores every text file in the repository with four repo-agnostic signals:

1. **Text:** BM25-style term match over contents, plus path-segment match (weighted by how rare the term is among paths).
2. **Symbols:** definitions whose names match the request (Python, TS/JS, Go, Rust, Java), so the closest existing example ("precedent") is included.
3. **Kin (git co-change):** for the top source files, files that changed in the same commits (up to 3,000 commits, ignoring sweeping commits over 40 files, following renames). Example on Flask 3.1.3: `src/flask/cli.py` changed with `tests/test_cli.py` in 52 of its 172 commits and with `docs/cli.rst` in 19.
4. **Test pairing:** `test_<name>.py` / `<name>.test.ts` for the top source files.

Files are packed into a **token budget** (default 32,000, `kinfile.contextBudgetTokens`). The anchor file goes first. Each file gets at most 25% of the budget (prose 12.5%). Small files go in whole, large ones as an outline plus windows around the relevant lines. Every chosen file appears in the receipt with its reasons and token cost, and files left out are listed too. The agent can fetch anything else with its tools. On Flask's Task B request this takes about 40 ms after a one-time index of about 0.2 s.

## The three fixed tasks (pallets/flask 3.1.3)

Prepare Flask once:

```bash
git clone https://github.com/pallets/flask.git && cd flask && git checkout 3.1.3
```

```bash
python -m venv .venv && . .venv/bin/activate && pip install -e . "pytest<9"
```

Flask 3.1.3's test suite imports a pytest internal that pytest 9 removed, so pin `pytest<9`.

- **A:** open `src/flask/helpers.py`, select `get_debug_flag`, `Ctrl+Alt+K`, give the instruction, review and accept the hunks. Check:

  ```bash
  FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
  ```

  (PowerShell: `$env:FLASK_DEBUG="off"; python -c "..."`)
- **B:** in the panel, give the instruction, review and accept each proposal, then open the session link. Check:

  ```bash
  pytest tests/test_cli.py -q
  ```

- **C:** break the primary model, repeat Task A (Kinfile switches to the second model by itself), then restore the key:

  ```bash
  npm run demo:break-primary
  ```

  ```bash
  git status
  ```

  ```bash
  npm run demo:restore
  ```

## Development

```bash
npm test
```

Unit tests cover the hunk engine, the edit matcher and co-change retrieval on a temporary git repo.

```bash
npm run bench:flask -- /path/to/flask
```

This prints the Context Receipt for Task B.

```bash
npm run export-agents
```

This regenerates `agent/*.json` from the source.

## Known limitations

- Co-change needs git history; a fresh repository falls back to text, symbol and test signals.
- The symbol index is regex-based (fast, no native deps) rather than a full parser.
- If a model fails *after* the user has accepted some hunks, Kinfile does not silently switch models mid-change; it stops with a clear message.
- Code Mode and Skills are not used (they need TrueForge's sandbox).
- Free-tier model quotas (Gemini, Groq) throttle long agent runs; a paid key or a gateway is more reliable for Task B.
- Subagents may explore but not edit: Kinfile denies write tools on subagent threads so only the main agent proposes changes.

## License

MIT (see `LICENSE`).
