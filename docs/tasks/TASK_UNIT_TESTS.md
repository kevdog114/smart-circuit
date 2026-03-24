# Agent Task: Unit Tests

## Objective
Add unit tests for the core data model and EasyEDA export module.

## Context
- The app is a Vite + TypeScript project at `/Users/klschaefer/dev-projects/smart-circuit/`
- Client is in `client/` with Vite as the bundler
- Use **Vitest** (Vite-native test runner): `npm install -D vitest` in the `client/` workspace

## What to Test

### Core Data Model (`client/src/core/`)

#### `document.ts` tests
- `createDocument()` returns valid structure with ID, sheet, metadata
- `createSheet()` returns empty sheet with correct defaults
- `nextDesignator()` generates R1, R2, R3 sequence correctly
- `AddComponentCommand`: execute adds component, undo removes it
- `MoveComponentCommand`: execute updates position + pin positions, undo restores
- `DeleteComponentCommand`: execute removes component, undo restores it
- `AddWireCommand`: execute adds wire + creates net, undo removes both
- Serialize → deserialize round-trip preserves document

#### `command-stack.ts` tests
- Execute pushes to undo stack
- Undo pops from undo, pushes to redo
- Redo pops from redo, pushes to undo
- New execute after undo clears redo stack
- `canUndo` / `canRedo` reflect stack state
- History limit (100 commands)

#### `event-bus.ts` tests
- `on()` registers handler, returns unsubscribe function
- `emit()` calls all registered handlers for that event type
- `off()` removes specific handler
- Handler errors don't break other handlers
- `clear()` removes all listeners

### EasyEDA Export (`client/src/export/`)
*(Only if the EasyEDA serializer has been implemented — skip if the directory is empty)*

- Exported JSON has required fields: `docType`, `head`, `canvas`, `shape`
- Wire serializes to `W~...` format
- Component serializes to `LIB~...` format
- ID generator produces `gge1`, `gge2`, etc.

## Setup
```bash
cd client
npm install -D vitest
```

Add to `client/package.json`:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Create test files at `client/src/core/__tests__/` following Vitest conventions.

## Acceptance Criteria
1. `npm test` in `client/` runs all tests and passes
2. Core document commands have full undo/redo coverage
3. Command stack edge cases are covered
4. Event bus is tested

## Key Files to Read First
- `client/src/core/document.ts` (commands to test)
- `client/src/core/command-stack.ts` (undo/redo to test)
- `client/src/core/event-bus.ts` (pub/sub to test)
- `client/src/core/types.ts` (interfaces used by tests)
