# Smart Circuit — Contributing & Development Guide

## Quick Start

```bash
# Clone and install
git clone <repo-url> && cd smart-circuit
npm install

# Start dev server (frontend + backend)
npm run dev

# Frontend only
npm run dev:client

# Backend only
npm run dev:server
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vite + TypeScript |
| Rendering | HTML5 Canvas |
| Backend | Node.js + Express |
| LLM | Google Gemini API |
| Export | EasyEDA Standard JSON |

## Project Structure

```
src/            → Frontend source
  core/         → Data model, event bus, undo/redo
  schematic/    → Schematic canvas editor
  pcb/          → PCB editor (stretch)
  library/      → Component library
  llm/          → LLM chat integration
  export/       → EasyEDA exporter
  ui/           → Shared UI components
server/         → Backend (Express)
public/library/ → Built-in component definitions
docs/           → Architecture & specs (you are here)
tests/          → Tests
```

## Coding Conventions

- **TypeScript strict mode** — no `any` unless unavoidable
- **Barrel exports** — each module has `index.ts`
- **Event-driven** — modules communicate via event bus, not direct imports
- **Command pattern** — all data mutations as undoable commands
- **No cross-module internals** — import only from `module/index.ts`

## Module Ownership

Multiple agents can work in parallel on different modules. Key boundaries:

| Module | Depends On | Independent? |
|--------|-----------|-------------|
| `core/` | Nothing | ✅ Start here |
| `schematic/` | `core/` | After core types exist |
| `library/` | `core/` | After core types exist |
| `export/` | `core/` | After core types exist |
| `llm/` | `core/`, `server/` | After core + API exist |
| `ui/` | Nothing | ✅ Fully independent |
| `server/` | Nothing | ✅ Fully independent |

## Key Documents

| Document | Purpose |
|---------|---------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design, tech stack, data flow |
| [DATA_MODEL.md](./DATA_MODEL.md) | TypeScript types for all data structures |
| [API_CONTRACTS.md](./API_CONTRACTS.md) | Backend REST & WebSocket API |
| [EASYEDA_FORMAT.md](./EASYEDA_FORMAT.md) | Export format reference |
| [LLM_INTEGRATION.md](./LLM_INTEGRATION.md) | LLM system prompt, tools, flows |
| [COMPONENT_LIBRARY.md](./COMPONENT_LIBRARY.md) | Component types and built-in library |

## Testing

```bash
npm test              # Run all tests
npm test -- --watch   # Watch mode
```

## Recommended Parallel Work Streams

1. **Agent A**: `core/` — Implement data model types, event bus, command stack
2. **Agent B**: `server/` — Set up Express, LLM proxy, component search API
3. **Agent C**: `ui/` — Build toolbar, sidebar, property panel, theme
4. **Agent D**: `schematic/` — Canvas renderer, grid, zoom/pan (can start with mock data)
5. **Agent E**: `export/` — EasyEDA serializer (can start with hardcoded test circuits)
6. **Agent F**: `library/` — Component JSON definitions for built-in parts
