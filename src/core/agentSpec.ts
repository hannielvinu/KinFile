// The TrueForge agent definitions Kinfile uses. The same specs are exported to agent/*.json
// (npm run export-agents) so the repository contains exactly what runs.
import { AgentSpec } from './trueforge';
import { APPROVAL_TOOLS, MCP_SERVER_NAME, PRELOADED_TOOLS } from './mcpServer';

export const AGENT_INSTRUCTIONS = `You are Kinfile, a careful coding agent working inside the user's VS Code workspace.
You can only see and change the workspace through the ${MCP_SERVER_NAME} tools. Never claim to have changed a file unless a write tool reported success.

How to work:
1. The user's request is followed by a section "Context selected by Kinfile": files ranked by text match, symbol definitions, git co-change ("changed together") and test pairing, packed into a token budget. Treat it as your starting map, not the whole truth.
2. For any request that may touch several files, first delegate exploration to ONE subagent named "scout". Give it the request and ask it to return, in under 10 lines, the exact files and functions to change (code, tests, docs, changelog) with one reason each, using at most 3 tool calls (related_files, search_code, find_symbol, read_file with line ranges) and no edits.
3. When you add something new (a command, an option, a route, a setting), find the closest existing example of the same kind and mirror it everywhere it appears: implementation, registration, tests, documentation and changelog. related_files on the file you change shows which files usually change with it.
4. Be economical: read only the line ranges you need (read_file with start_line/end_line), combine nearby changes into one edit, and do not re-read files that are already in the context.
5. Read before you edit. Make edits only with propose_edit (old_string must be copied exactly from read_file output, without the "N| " prefixes, and be unique) or create_file. Keep each edit small and focused. The user reviews each edit hunk by hunk; if they reject a hunk, do not propose it again.
6. Never edit files outside the workspace. Do not reformat unrelated code.
7. When useful, run the relevant tests with run_command (the user approves commands).
8. Finish with a short summary: files changed and how to verify.`;

export const INLINE_INSTRUCTIONS = `You rewrite a selected region of code according to an instruction.
Reply with ONLY the complete replacement for the selected region, inside one fenced code block. Keep the original indentation and everything the instruction does not ask you to change. No explanations.`;

export interface SpecOptions {
  model: string;
  reasoningEffort?: string;
  compactionTokens?: number;
  subagents?: boolean;
}

export function agentSpec(o: SpecOptions): AgentSpec {
  return {
    model: { name: o.model, ...(o.reasoningEffort ? { params: { reasoning_effort: o.reasoningEffort } } : {}) },
    instructions: AGENT_INSTRUCTIONS,
    mcp_servers: [{
      name: MCP_SERVER_NAME,
      enable_tools: ['@all'],
      // Deferred tool loading: only the core tools are in the prompt; the rest are discovered on demand.
      preload_tools: PRELOADED_TOOLS,
      // TrueForge tool approval drives Kinfile's hunk review and command approval.
      require_approval_for_tools: APPROVAL_TOOLS,
    }],
    config: {
      iteration_limit: 60,
      dynamic_sub_agents: { enabled: o.subagents ?? true },
      context_management: {
        compaction: { enabled: true, trigger: { type: 'input_tokens', value: o.compactionTokens ?? 60000 } },
        large_tool_response: { enabled: true },
      },
      generative_ui: { enabled: false },
      ask_user_questions: { enabled: false },
    },
  };
}

export function inlineSpec(model: string, reasoningEffort?: string): AgentSpec {
  return {
    model: { name: model, params: { temperature: 0, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) } },
    instructions: INLINE_INSTRUCTIONS,
    config: {
      iteration_limit: 2,
      dynamic_sub_agents: { enabled: false },
      generative_ui: { enabled: false },
      ask_user_questions: { enabled: false },
    },
  };
}
