# Agent Task: LLM Tool Executor

## Objective
When the AI assistant calls tools like `add_component` or `add_subcircuit`, display a preview card and apply the action to the schematic when the user confirms.

## Context
- The app is a Vite + TypeScript schematic editor at `/Users/klschaefer/dev-projects/smart-circuit/`
- **LLM spec**: Read `docs/LLM_INTEGRATION.md` — tool definitions and conversation flows
- **Data model**: Read `client/src/core/types.ts` and `client/src/core/document.ts` (commands)

## What Exists
- `client/src/main.ts` — has the LLM chat UI (~line 250-310) with SSE streaming
  - Currently parses `event: tool_call` lines but does nothing with them
- `server/src/services/gemini.ts` — Gemini service with 4 function-calling tools already defined:
  - `add_component`, `add_subcircuit`, `modify_component`, `remove_component`
- `client/src/core/document.ts` — Has `AddComponentCommand`, `DeleteComponentCommand`

## What to Build

### `client/src/llm/tool-executor.ts`
Parse tool calls from the SSE stream and:
1. Render a **preview card** in the chat showing what the AI wants to do
   - For `add_component`: "Add R1 (10kΩ resistor)" with Accept/Reject buttons
   - For `add_subcircuit`: Show list of components + connections
   - For `modify_component`: Show before → after
   - For `remove_component`: Show which component will be removed
2. On **Accept**: execute the corresponding `Command` from `document.ts` via the `CommandStack`
3. On **Reject**: append "User rejected this action" to the chat

### Update `client/src/main.ts`
- Import and wire up the tool executor
- When SSE stream emits `event: tool_call`, pass it to the executor
- The executor needs references to: `doc`, `commandStack`, `libraryMap`, `renderer`

### CSS additions to `client/src/style.css`
- `.tool-call-card` — visual card with gradient border, component details, Accept/Reject buttons
- Should match the existing dark theme

## Acceptance Criteria
1. AI tool calls render as styled preview cards in the chat
2. Clicking "Accept" adds the component to the schematic canvas
3. Clicking "Reject" dismisses the card
4. Accepted actions are undoable via Ctrl+Z
5. Works for at least `add_component` and `remove_component`

## Key Files to Read First
- `docs/LLM_INTEGRATION.md` (tool definitions)
- `client/src/main.ts` (chat UI, lines ~250-310)
- `client/src/core/document.ts` (command classes)
- `server/src/services/gemini.ts` (tool declarations)
