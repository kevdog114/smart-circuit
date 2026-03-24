# Agent E — Gemini Auto-Placement Tool

## Objective
Add a Gemini LLM tool that auto-arranges components on the PCB board based on the circuit topology. Gemini analyzes the schematic connections and recommends component placements that minimize trace lengths and group related components.

## Prerequisites
- **Agent A** complete: PCB types and commands
- **Agent C** complete: PCB renderer (so placements are visible)
- **Agent D** complete: View management (so PCB view is accessible)

## Context
- **Server LLM route:** `server/src/routes/llm.ts` — defines available tools for Gemini function calling
- **Client tool executor:** `client/src/llm/tool-executor.ts` — handles tool calls from the Gemini SSE stream
- Study both files carefully for the existing tool patterns (e.g., `add_component`, `add_subcircuit`)

## Deliverables

### 1. Modify `server/src/routes/llm.ts`

Add a new tool declaration to the tools array:

```typescript
{
  name: 'layout_pcb_components',
  description: 'Place components on the PCB board in a layout optimized for the circuit topology. Groups related components together (e.g. power supply section, analog section, digital section), minimizes trace lengths between connected components, and follows PCB design best practices. Decoupling capacitors should be placed near their associated ICs. Power components should be kept separate from sensitive analog circuitry.',
  parameters: {
    type: 'OBJECT',
    properties: {
      boardWidth: {
        type: 'NUMBER',
        description: 'Board width in mm (default 100)'
      },
      boardHeight: {
        type: 'NUMBER',
        description: 'Board height in mm (default 80)'
      },
      placements: {
        type: 'ARRAY',
        description: 'Component placements on the PCB',
        items: {
          type: 'OBJECT',
          properties: {
            designator: {
              type: 'STRING',
              description: 'Component designator (e.g. R1, U1, C1)'
            },
            x: {
              type: 'NUMBER',
              description: 'X position in mm from board left edge'
            },
            y: {
              type: 'NUMBER',
              description: 'Y position in mm from board top edge'
            },
            rotation: {
              type: 'NUMBER',
              description: 'Rotation in degrees (0, 90, 180, 270)'
            },
            layer: {
              type: 'STRING',
              description: 'PCB layer: F.Cu (front/top) or B.Cu (back/bottom)',
              enum: ['F.Cu', 'B.Cu']
            }
          },
          required: ['designator', 'x', 'y']
        }
      }
    },
    required: ['placements']
  }
}
```

Also update the system prompt context to include PCB state when available. In the part where `circuitContext` is sent to Gemini, add PCB layout status:

```typescript
// In the request body construction, extend the system prompt:
const pcbContext = circuitContext.pcbLayout ? {
  boardSize: `${circuitContext.pcbLayout.board.width}mm x ${circuitContext.pcbLayout.board.height}mm`,
  placedComponents: circuitContext.pcbLayout.components.filter(c => c.isPlaced).length,
  unplacedComponents: circuitContext.pcbLayout.components.filter(c => !c.isPlaced).length,
} : null;
```

### 2. Modify `client/src/llm/tool-executor.ts`

Add a handler for the `layout_pcb_components` tool:

```typescript
interface LayoutPCBArgs {
  boardWidth?: number;
  boardHeight?: number;
  placements: {
    designator: string;
    x: number;
    y: number;
    rotation?: number;
    layer?: 'F.Cu' | 'B.Cu';
  }[];
}
```

In the `handleToolCall` switch statement, add:
```typescript
case 'layout_pcb_components':
  return this.renderLayoutPCB(args as unknown as LayoutPCBArgs);
```

**Implement `renderLayoutPCB`:**

1. Create a tool card (same pattern as other tools) with:
   - Icon: `🗺️`
   - Title: `"Auto Layout PCB"`
   - Details: `{ label: 'Components', value: '${placements.length} placements' }`

2. On accept:
   - Ensure `doc.pcbLayout` exists (create if not)
   - For each placement:
     - Find the schematic component by designator
     - Find the matching `PCBComponent` in `doc.pcbLayout.components`
     - If it exists and is unplaced, place it at the specified position
     - If it exists and is already placed, move it
     - If it doesn't exist, create a new `PCBComponent` entry
   - Apply via command(s) — you can batch these into a single composite command or execute individually
   - Update the PCB renderer

3. On reject: standard rejection

**Important:** The tool executor will need a reference to the PCB renderer to trigger re-renders. You may need to add `pcbRenderer` to the constructor opts, or fire events via `eventBus`.

### 3. Extend the chat context in `main.ts` (coordinate with Agent D)

In `sendLLMMessage()`, extend `circuitContext` to include PCB state:

```typescript
const circuitContext = {
  components: doc.sheets[0].components.map(c => ({
    designator: c.designator,
    value: c.value,
    libraryId: c.libraryId
  })),
  nets: doc.sheets[0].nets.map(n => ({
    name: n.name,
    pins: n.pinIds
  })),
  currentSheet: doc.sheets[0].name,
  // Add PCB context
  pcbLayout: doc.pcbLayout ? {
    board: doc.pcbLayout.board,
    placedComponents: doc.pcbLayout.components
      .filter(c => c.isPlaced)
      .map(c => {
        const schComp = doc.sheets[0].components.find(sc => sc.id === c.schematicComponentId);
        return {
          designator: schComp?.designator || 'Unknown',
          x: c.position.x,
          y: c.position.y,
          layer: c.layer,
        };
      }),
    unplacedCount: doc.pcbLayout.components.filter(c => !c.isPlaced).length,
  } : null,
};
```

## Important Notes
- Do NOT modify the PCB renderer, component drawer, or view management files
- Match the existing tool card UI style exactly
- The tool should work even if the user hasn't switched to PCB view yet — it should initialize the PCBLayout if needed
- Default board size: 100mm × 80mm if not specified
- Default layer: 'F.Cu' if not specified by Gemini
- Default rotation: 0 if not specified
- Gemini should receive enough context (component list + net connections) to make intelligent placement decisions
