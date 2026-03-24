# Smart Circuit — LLM Integration Specification

## Overview

The LLM (Google Gemini) acts as a **circuit design copilot**. It assists with:
1. **Part selection** — recommending components based on requirements and constraints
2. **Subcircuit generation** — producing complete subcircuits (e.g., voltage regulator with caps)
3. **Design review** — analyzing the schematic for common mistakes
4. **Q&A** — answering electronics design questions in context

> [!IMPORTANT]
> The LLM **never** modifies the schematic directly. It proposes actions via function calls, and the user confirms before they are applied.

---

## Architecture

```
User ──► Chat Panel ──► LLM Service (frontend)
                              │
                              ▼
                        Backend Proxy ──► Gemini API
                              │
                              ▼
                        Response Stream ──► Parse tool calls
                              │                    │
                              ▼                    ▼
                        Display text         Preview proposed changes
                                                   │
                                            User confirms ──► Apply to CircuitDocument
```

### Why a Backend Proxy?

- **API key security** — key stored on server, not exposed in browser
- **Rate limiting** — prevent runaway costs
- **Context enrichment** — server can augment prompts with component DB data
- **Caching** — cache common queries (part lookups, datasheet summaries)

---

## System Prompt

The system prompt establishes the LLM's role and capabilities:

```
You are an expert electronics design assistant integrated into Smart Circuit,
a web-based schematic editor. You help users design circuits by:

1. Recommending components based on requirements
2. Generating subcircuits with proper supporting components
3. Reviewing designs for common errors
4. Answering electronics questions

CONTEXT: You will receive the current circuit state including all components,
nets, and connections. Use this to give contextual advice.

TOOLS: You have access to the following tools to modify the schematic.
Always explain what you plan to do before calling a tool. Wait for user
confirmation on significant changes.

CONSTRAINTS:
- Prefer commonly available parts (LCSC/JLCPCB stocked)
- Always include required decoupling capacitors
- Consider thermal requirements
- Suggest alternatives when a part may be hard to source
- Use standard designator prefixes (R, C, U, D, Q, L, etc.)
```

---

## Function Calling (Tools)

The LLM can propose these structured actions:

### `add_component`

```typescript
interface AddComponentTool {
  name: 'add_component';
  description: 'Add a component to the schematic';
  parameters: {
    libraryId: string;       // Component from our library
    designator: string;      // e.g. "U1"
    value: string;           // e.g. "AMS1117-3.3"
    sheet?: string;          // Target sheet name
    nearComponent?: string;  // Place near this designator for logical grouping
    properties?: Record<string, string>;
  };
}
```

### `add_subcircuit`

```typescript
interface AddSubcircuitTool {
  name: 'add_subcircuit';
  description: 'Add a group of components with their interconnections';
  parameters: {
    name: string;            // e.g. "3.3V LDO Power Supply"
    components: {
      libraryId: string;
      designator: string;
      value: string;
      properties?: Record<string, string>;
    }[];
    connections: {
      from: { designator: string; pin: string };
      to: { designator: string; pin: string };
      netName?: string;
    }[];
    sheet?: string;
  };
}
```

### `modify_component`

```typescript
interface ModifyComponentTool {
  name: 'modify_component';
  description: 'Change a property of an existing component';
  parameters: {
    designator: string;      // Which component to modify
    changes: {
      value?: string;
      footprintId?: string;
      properties?: Record<string, string>;
    };
  };
}
```

### `remove_component`

```typescript
interface RemoveComponentTool {
  name: 'remove_component';
  description: 'Remove a component and its connections';
  parameters: {
    designator: string;
  };
}
```

### `search_components`

```typescript
interface SearchComponentsTool {
  name: 'search_components';
  description: 'Search the component library for parts matching criteria';
  parameters: {
    query: string;
    category?: string;
    package?: string;
    maxResults?: number;
  };
}
```

### `review_design`

```typescript
interface ReviewDesignTool {
  name: 'review_design';
  description: 'Analyze the current circuit and report issues';
  parameters: {
    focusAreas?: string[];   // e.g. ["power", "decoupling"]
  };
}
```

---

## Circuit Context Injection

Every LLM request includes a structured summary of the current circuit:

```typescript
function buildCircuitContext(doc: CircuitDocument): string {
  const components = doc.sheets.flatMap(s => s.components);
  const nets = doc.sheets.flatMap(s => s.nets);

  return `
## Current Circuit State

### Components (${components.length})
${components.map(c =>
  `- ${c.designator}: ${c.value} [${c.libraryId}] on sheet "${getSheet(c).name}"`
).join('\n')}

### Nets (${nets.length})
${nets.map(n =>
  `- ${n.name}: connects ${n.pinIds.map(formatPin).join(', ')}`
).join('\n')}

### Sheets
${doc.sheets.map(s => `- ${s.name} (${s.components.length} components)`).join('\n')}
  `;
}
```

> [!TIP]
> For large circuits, summarize rather than enumerate. Group by subcircuit or sheet.

---

## Conversation Flow Examples

### Part Selection

```
User: I need a buck converter to go from 12V to 5V at 2A

LLM: For a 12V→5V buck converter at 2A, I'd recommend the **MP2315GJ**:
- Input: 4.5V–24V
- Output: adjustable, set to 5V with resistor divider
- Max output: 3A (plenty of headroom)
- Package: SOT-23-8 (compact)
- Widely available on LCSC (C15457)

I'll set up the complete subcircuit with:
- Input caps: 2× 10µF ceramic + 100nF
- Output inductor: 4.7µH
- Output caps: 2× 22µF ceramic
- Feedback divider: R1=100kΩ, R2=32.4kΩ (sets 5.08V)
- Bootstrap cap: 100nF

[tool_call: add_subcircuit({ name: "12V to 5V Buck (MP2315)", ... })]

User: Looks good, add it.
→ Apply tool call to CircuitDocument
```

### Design Review

```
User: Can you review my power section?

LLM: [tool_call: review_design({ focusAreas: ["power", "decoupling"] })]

Looking at your power section, I found:
⚠️ WARNING: U3 (AMS1117-3.3) is missing input decoupling capacitor.
  → Add 10µF electrolytic on VIN pin
⚠️ WARNING: 12V rail has no bulk capacitance before the buck converter.
  → Add 100µF electrolytic at power input
ℹ️ INFO: R5/R6 feedback divider on U2 sets output to 4.97V (within 1% of 5V target). Good.
✅ Output decoupling on 3.3V rail looks correct (10µF + 100nF).
```

---

## Prompt Engineering Guidelines

1. **Always include circuit context** — The LLM performs dramatically better with state
2. **Use structured output** — Function calling prevents hallucinated component placements
3. **Limit context window** — Summarize large circuits; send only relevant sheets
4. **Temperature: 0.2–0.4** — Factual accuracy matters more than creativity
5. **Include component DB results** — When the LLM calls `search_components`, inject real results from our DB before it responds to the user
6. **Multi-turn memory** — Maintain the full conversation for context, but summarize after 20+ turns

---

## Error Handling

| Scenario | Behavior |
|---------|----------|
| Gemini API down | Show offline banner; editor still works |
| Rate limited | Queue request, show "Processing..." |
| Invalid tool call | Show error to user, ask LLM to retry |
| Hallucinated part | Validate against component DB before applying |
| Context too large | Summarize circuit, retry with smaller context |
