// Kinfile agent panel (webview). Plain JS, no framework.
(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const stop = document.getElementById('stop');
  const modelsEl = document.getElementById('models');
  let current = null;           // assistant text element for the main thread
  const threads = new Map();    // subagent thread id -> card
  const tools = new Map();      // tool call id -> element
  const approvals = new Map();  // tool call id -> element
  let sessionUrl = null;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const add = (node, parent) => { const empty = log.querySelector('.empty'); if (empty) empty.remove(); (parent || log).appendChild(node); scroll(); return node; };

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
  }
  send.onclick = submit;
  stop.onclick = () => vscode.postMessage({ type: 'stop' });
  document.getElementById('at').onclick = () => vscode.postMessage({ type: 'mention' });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') vscode.postMessage({ type: 'stop' });
  });
  input.addEventListener('input', () => { if (input.value.endsWith('@')) { input.value = input.value.slice(0, -1); vscode.postMessage({ type: 'mention' }); } });

  function receiptCard(r) {
    const card = el('div', 'card receipt');
    const pct = Math.min(100, Math.round((r.used / r.budget) * 100));
    card.appendChild(el('div', 'card-title', `Context Receipt · ${r.used.toLocaleString()} / ${r.budget.toLocaleString()} tokens`));
    const bar = el('div', 'bar'); const fill = el('div', 'fill'); fill.style.width = pct + '%'; bar.appendChild(fill); card.appendChild(bar);
    card.appendChild(el('div', 'muted', `${r.entries.length} files chosen from ${r.filesScanned} · ${r.commitsIndexed} commits of history · ${r.ms} ms`));
    const list = el('ol', 'files');
    for (const e of r.entries) {
      const li = el('li');
      const a = el('a', 'file', e.file); a.href = '#'; a.onclick = ev => { ev.preventDefault(); vscode.postMessage({ type: 'open', file: e.file }); };
      li.appendChild(a);
      li.appendChild(el('span', 'tok', ` ${e.tokens.toLocaleString()} tok · ${e.mode}`));
      const why = el('div', 'why'); e.reasons.forEach(rs => why.appendChild(el('div', /changed together/.test(rs) ? 'kin' : '', '• ' + rs)));
      li.appendChild(why);
      list.appendChild(li);
    }
    card.appendChild(list);
    if (r.dropped && r.dropped.length) card.appendChild(el('div', 'muted', 'Left out (budget/limit): ' + r.dropped.map(d => d.file).join(', ')));
    add(card);
  }

  function threadParent(thread) {
    if (!thread || thread === 'main') return log;
    const card = threads.get(thread);
    return card ? card.querySelector('.body') : log;
  }

  function onEvent(e) {
    switch (e.kind) {
      case 'model':
        add(el('div', 'meta', `▶ ${e.model}${e.attempt > 1 ? ' (retry)' : ''}`));
        current = null; break;
      case 'session': {
        sessionUrl = e.url;
        const d = el('div', 'meta'); const a = el('a', '', `TrueForge session ${e.sessionId.slice(-8)}`); a.href = '#';
        a.onclick = ev => { ev.preventDefault(); vscode.postMessage({ type: 'openUrl', url: e.url }); };
        d.append('↳ ', a); add(d); break;
      }
      case 'delta': {
        if (e.thread && e.thread !== 'main') {
          const p = threadParent(e.thread); let t = p.querySelector(':scope > .assistant:last-child');
          if (!t) t = add(el('div', 'assistant small'), p);
          t.textContent += e.text; scroll(); break;
        }
        if (!current) current = add(el('div', 'assistant'));
        current.textContent += e.text; scroll(); break;
      }
      case 'tool': {
        current = null;
        let args = {}; try { args = JSON.parse(e.args || '{}'); } catch (_) {}
        if (e.name === 'create_sub_agent') break; // shown as a subagent card
        const summary = args.path || args.query || args.name || args.command || args.glob || args.tool_name || args.mcp_server || '';
        const t = el('details', 'tool'); const s = el('summary', '', `⚙ ${e.name} ${summary}`); t.appendChild(s);
        tools.set(e.id, t); add(t, threadParent(e.thread)); break;
      }
      case 'toolResult': {
        let t = tools.get(e.id);
        if (!t) {  // some providers only surface the call when its result arrives
          t = el('details', 'tool'); t.appendChild(el('summary', '', '⚙ ' + (String(e.text || '').split('\n')[0].slice(0, 70) || 'tool call')));
          tools.set(e.id, t); add(t, threadParent(e.thread));
        }
        const pre = el('pre', 'result', e.text || '(empty)'); t.appendChild(pre); break;
      }
      case 'subagent': {
        if (!e.done) {
          const card = el('div', 'card sub');
          card.appendChild(el('div', 'card-title', `🔎 Subagent “${e.title}” exploring…`));
          if (e.input) card.appendChild(el('div', 'muted', e.input.slice(0, 400)));
          card.appendChild(el('div', 'body'));
          threads.set(e.thread, card); add(card);
        } else {
          const card = threads.get(e.thread);
          if (card) card.querySelector('.card-title').textContent = `🔎 Subagent “${e.title}” ${e.state === 'done' ? 'finished' : e.state || 'finished'}`;
        }
        current = null; break;
      }
      case 'compaction':
        add(el('div', 'meta', e.done ? '🗜 Context compacted by TrueForge' : '🗜 TrueForge is compacting older context…')); break;
      case 'relay':
        add(el('div', 'notice ' + e.level, (e.level === 'error' ? '✖ ' : '⟳ ') + e.text)); current = null; break;
      case 'approval': {
        let a = approvals.get(e.id);
        if (!a) { a = add(el('div', 'card approval')); approvals.set(e.id, a); }
        const label = { pending: '⏳ Review in editor', accepted: '✔ Accepted', rejected: '✖ Rejected', partial: '◐ Partly accepted' }[e.state];
        a.className = 'card approval ' + e.state;
        a.textContent = `${label}: ${e.summary}`;
        current = null; break;
      }
      case 'done': {
        current = null;
        const d = el('div', 'notice ' + (e.status === 'done' ? 'ok' : e.status === 'cancelled' ? 'warn' : 'error'));
        d.textContent = e.status === 'done' ? `✔ Done${e.model ? ' on ' + e.model : ''}` : e.status === 'cancelled' ? '■ Cancelled. Unreviewed hunks were discarded; nothing half-applied.' : `✖ ${e.text || 'Failed'}`;
        add(d); break;
      }
      case 'status':
        add(el('div', 'meta', e.text)); break;
    }
  }

  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'user': { current = null; add(el('div', 'user', m.text)); break; }
      case 'receipt': receiptCard(m.receipt); break;
      case 'event': onEvent(m.e); break;
      case 'running': send.hidden = m.running; stop.hidden = !m.running; break;
      case 'status': add(el('div', 'meta', m.text)); break;
      case 'insert': input.value += m.text; input.focus(); break;
      case 'focusInput': setTimeout(() => input.focus(), 50); break;
      case 'askCommand': {
        const card = add(el('div', 'card approval pending'));
        card.appendChild(el('div', 'card-title', 'Run command?'));
        card.appendChild(el('pre', 'result', m.command));
        const row = el('div', 'row');
        const ok = el('button', 'primary', 'Run (Ctrl+Alt+Enter)'); const no = el('button', '', 'Deny');
        card.dataset.id = m.id;
        const done = v => { vscode.postMessage({ type: 'command', id: m.id, ok: v }); row.remove(); card.appendChild(el('div', 'muted', v ? 'Approved' : 'Denied')); };
        ok.onclick = () => done(true); no.onclick = () => done(false);
        row.append(ok, no); card.appendChild(row); break;
      }
      case 'commandAnswered': {
        const card = log.querySelector(`[data-id="${m.id}"]`);
        if (card) { const row = card.querySelector('.row'); if (row) row.remove(); card.appendChild(el('div', 'muted', m.ok ? 'Approved' : 'Denied')); }
        break;
      }
      case 'journal': {
        if (!m.label) break;
        const d = add(el('div', 'meta'));
        d.append(`Applied ${m.label} `);
        const u = el('a', '', 'Undo'); u.href = '#'; u.onclick = ev => { ev.preventDefault(); vscode.postMessage({ type: 'undo' }); }; d.appendChild(u);
        break;
      }
      case 'models': {
        if (m.error) { modelsEl.textContent = 'TrueForge offline'; modelsEl.title = m.error; modelsEl.className = 'models off'; break; }
        modelsEl.className = 'models';
        modelsEl.textContent = m.models.length ? `${m.models[0]}${m.models.length > 1 ? `  ⟶ fallback ${m.models.slice(1).join(', ')}` : ''}` : 'no model configured';
        modelsEl.title = `TrueForge at ${m.url}`; break;
      }
    }
  });
})();
