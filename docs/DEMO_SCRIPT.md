# Demo video script (max 4:00)

Record at 1920×1080, VS Code zoom +1 (`Ctrl+=`), dark theme, Kinfile panel on the left and the editor in the middle. Close Copilot/Chat panels. Cut only *model waiting time*, never the gap between giving an instruction and the diff appearing. The timestamps match the scorecard in the write-up. If yours differ, update section 6 of `docs/writeup/writeup.html` and rebuild the PDF.

## Before recording (not filmed)

1. Terminal 1, in the KinFile repo:

   ```bash
   npm run trueforge
   ```

2. Terminal 2, in the KinFile repo (real keys in `config/trueforge.local.json`):

   ```bash
   npm run setup
   ```

3. Prepare Flask:

   ```bash
   git clone https://github.com/pallets/flask.git && cd flask && git checkout 3.1.3
   ```

   ```bash
   python -m venv .venv && . .venv/bin/activate && pip install -e . "pytest<9"
   ```

4. Install the extension:

   ```bash
   npm run package
   ```

   ```bash
   code --install-extension kinfile-0.1.0.vsix
   ```

5. From the activated venv, open Flask with `code .`, so commands the agent runs use this Python.
6. VS Code settings: `"kinfile.models": ["google-gemini/gemini-3-5-flash", "groq/gpt-oss-120b"]`.
7. Rehearse once and run `git status` (must be clean). Open the TrueForge UI (http://localhost:8790) in a browser tab.

## 0:00–0:12 Intro
Show the VS Code window with Flask 3.1.3, `git status` clean in the terminal, and the Kinfile panel header showing `primary ⟶ fallback`. Optional caption: "Kinfile: agent loop on TrueForge; context from git history; every hunk reviewed".

## 0:12–1:05 Task A: inline edit
1. Open `src/flask/helpers.py` and select the whole `get_debug_flag` function.
2. `Ctrl+Alt+K` and type exactly: *Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.* Press Enter.
3. **0:15** Tokens stream in the notification and the panel. Do not cut here.
4. **~0:25** The *Kinfile proposal* tab opens: red/green lines, `Accept hunk 1/2 · Reject` above each hunk.
5. **0:30** Click *Accept hunk 1/2*, then *Accept hunk 2/2*. The real file updates; the panel shows "Applied … Undo".
6. **0:40** Terminal, check:

   ```bash
   FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   ```

   It prints **False**.
7. **0:50** Show undo: press `Ctrl+Alt+Z` (Kinfile: Undo Last Applied Change). The last hunk returns to the original. Press `Ctrl+Alt+Z` again; `git status` is clean. *(B2: a working undo, shown on screen.)*

## 1:05–3:00 Task B: agent mode
1. In the Kinfile panel, mention no files and type exactly: *Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.* Press Enter.
2. **1:10** The **Context Receipt** appears: hover or zoom on `docs/cli.rst … changed together with src/flask/cli.py in 19 of its 172 commits` and `tests/test_cli.py … 52 of its 172 commits`, plus the budget bar. *(B1)*
3. **1:25** The *Subagent "scout"* card shows its tool calls. *(B4)*
4. **1:40–2:30** Each edit opens a proposal tab. Review each hunk and accept it (cut model waiting between proposals). You should see edits to `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst` (maybe `CHANGES.rst`). If the agent asks to run a command, click **Run** in the panel.
5. **2:35** Terminal:

   ```bash
   pytest tests/test_cli.py -q
   ```

   It passes. Then show that `config` is listed in the help:

   ```bash
   flask --app tests/test_apps/helloworld/hello.py --help
   ```

   And run it:

   ```bash
   flask --app tests/test_apps/helloworld/hello.py config
   ```

   This prints the configuration as JSON with `"SECRET_KEY": "***"` (and any other sensitive key) masked.
6. Show the diff touches 3 or more files:

   ```bash
   git diff --stat
   ```

7. **2:45–3:00** Click the *TrueForge session* link in the panel. In the browser, expand *Agent steps*: the turns, tool calls (`related_files`, `read_file`, `propose_edit`, `call_tool`) and the scout subagent. *(B4)*
8. Reset for Task C (keep it quick):

   ```bash
   git stash -u
   ```

## 3:00–3:40 Task C: resilience
1. Terminal 2 (KinFile repo):

   ```bash
   npm run demo:break-primary
   ```

   The output shows the primary provider's key is now invalid.
2. Repeat Task A: select `get_debug_flag`, `Ctrl+Alt+K`, the same instruction.
3. **3:15** The panel and a toast show: "google-gemini/gemini-3-5-flash failed: [Model Error] … API key not valid. Retrying in 1.5 s…", then "… is unavailable. Switching automatically to groq/gpt-oss-120b. No files were changed." Click into the editor or scroll to show it stays responsive.
4. **3:25** The proposal opens from the fallback model. Before accepting anything, run `git status` in the terminal: **no files changed**. Click *Reject all*.

## 3:40–3:58 Bonus: cancel mid-flight
In the panel type *Explain src/flask/app.py in detail* and press Enter. While tokens stream, click **■ Stop**. The panel shows "Cancelled. Unreviewed hunks were discarded; nothing half-applied." Run `git status`: clean. Afterwards restore the key with `npm run demo:restore`.

## Upload
YouTube (Unlisted) or Google Drive ("Anyone with the link can view"). Note the exact duration (mm:ss) for the form.
