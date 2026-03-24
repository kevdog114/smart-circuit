# Smart Circuit — API Contracts

## Overview

The backend exposes a REST + WebSocket API. The frontend can operate fully offline for schematic editing; the server is needed only for LLM queries, component search, and cloud project storage.

**Base URL**: `http://localhost:3001/api`

---

## Authentication

The Gemini API key is stored **server-side** via the `GEMINI_API_KEY` environment variable. No user accounts or client-side API keys in v1. The frontend communicates with our backend, which proxies LLM requests.

```bash
# Server .env
GEMINI_API_KEY=your-gemini-api-key-here
```

---

## REST Endpoints

### Projects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/projects` | List saved projects |
| `GET` | `/projects/:id` | Get full project JSON |
| `POST` | `/projects` | Create new project |
| `PUT` | `/projects/:id` | Update project |
| `DELETE` | `/projects/:id` | Delete project |

#### `POST /projects`

```typescript
// Request
interface CreateProjectRequest {
  name: string;
  description?: string;
}

// Response 201
interface CreateProjectResponse {
  id: string;
  name: string;
  createdAt: string;
}
```

#### `PUT /projects/:id`

```typescript
// Request — full CircuitDocument JSON
interface UpdateProjectRequest {
  document: CircuitDocument;
}

// Response 200
interface UpdateProjectResponse {
  id: string;
  updatedAt: string;
}
```

---

### Component Search (JLCPCB)

Proxied through our backend to `jlcsearch.tscircuit.com`. No API key required.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/components/search` | Full-text search (proxies `/api/search`) |
| `GET` | `/components/:lcsc_id` | Get component by LCSC part number |
| `GET` | `/components/categories` | List JLCPCB categories |
| `GET` | `/components/category/:name` | Category-specific search (e.g. `/resistors/list.json`) |

#### `GET /components/search`

```typescript
// Query params
interface ComponentSearchParams {
  q: string;              // Free-text query, e.g. "3.3V LDO SOT-223"
  package?: string;       // e.g. "SOT-223"
  limit?: number;         // Default 20, max 100
}

// Response 200 (normalized from jlcsearch)
interface ComponentSearchResponse {
  results: ComponentSummary[];
  total: number;
}

interface ComponentSummary {
  lcscPartNumber: string;  // e.g. "C6186" — primary ID
  name: string;            // e.g. "AMS1117-3.3"
  description: string;
  category: string;
  package: string;
  manufacturer: string;
  mpn: string;             // Manufacturer Part Number
  price?: number;          // USD per unit
  stock?: number;
  basic: boolean;          // JLCPCB basic part (cheaper assembly)
  datasheet?: string;
}
```

#### `GET /components/:id`

```typescript
// Response 200
interface ComponentDetailResponse {
  id: string;
  name: string;
  description: string;
  category: string;
  package: string;
  manufacturer: string;
  mpn: string;
  symbol: SymbolDefinition;     // Full symbol with pins and drawing
  footprint: FootprintDefinition;
  datasheet?: string;
  properties: Record<string, string>;  // Specs: voltage, current, etc.
  lcscPartNumber?: string;
  equivalents?: string[];       // IDs of compatible alternatives
}
```

---

### LLM Chat

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/llm/chat` | Send a message, get streaming response |
| `POST` | `/llm/suggest-parts` | Get part suggestions for a requirement |
| `POST` | `/llm/review-circuit` | Get design review feedback |

#### `POST /llm/chat`

Streaming endpoint (SSE or chunked response).

```typescript
// Request
interface LLMChatRequest {
  messages: ChatMessage[];
  circuitContext: CircuitContext;   // Current state of the circuit
  tools?: LLMTool[];               // Available function calls
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

interface CircuitContext {
  components: ComponentSummary[];   // What's currently on the schematic
  nets: { name: string; pins: string[] }[];
  currentSheet: string;
  selectedComponents?: string[];
}

// Response — Server-Sent Events stream
// event: text
// data: {"content": "I'd recommend..."}
//
// event: tool_call
// data: {"name": "add_component", "args": {...}}
//
// event: done
// data: {}
```

#### `POST /llm/suggest-parts`

```typescript
// Request
interface SuggestPartsRequest {
  requirement: string;           // e.g. "I need a 5V to 3.3V regulator, <500mA"
  constraints?: {
    package?: string;
    maxPrice?: number;
    inStockOnly?: boolean;
    preferredManufacturers?: string[];
  };
  existingCircuit?: CircuitContext;
}

// Response 200
interface SuggestPartsResponse {
  suggestions: PartSuggestion[];
  reasoning: string;
}

interface PartSuggestion {
  componentId: string;
  name: string;
  mpn: string;
  whyChosen: string;
  supportingCircuit?: {          // Optional subcircuit (caps, resistors)
    components: Component[];
    nets: Net[];
  };
}
```

#### `POST /llm/review-circuit`

```typescript
// Request
interface ReviewCircuitRequest {
  document: CircuitDocument;
  focusAreas?: ('power' | 'decoupling' | 'signal_integrity' | 'thermal' | 'general')[];
}

// Response 200
interface ReviewCircuitResponse {
  issues: DesignIssue[];
  suggestions: string[];
  overallAssessment: string;
}

interface DesignIssue {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  affectedComponents?: string[];  // Component IDs
  suggestedFix?: string;
}
```

---

### Export

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/export/easyeda` | Export to EasyEDA JSON *(can also run client-side)* |
| `POST` | `/export/netlist` | Export netlist |
| `POST` | `/export/bom` | Export BOM |

#### `POST /export/easyeda`

```typescript
// Request
interface ExportEasyEDARequest {
  document: CircuitDocument;
  options?: {
    includeSchematic: boolean;
    includePCB: boolean;
  };
}

// Response 200 — download
// Content-Type: application/json
// Content-Disposition: attachment; filename="project.json"
```

#### `POST /export/bom`

```typescript
// Request
interface ExportBOMRequest {
  document: CircuitDocument;
  format: 'csv' | 'json';
  groupByValue: boolean;
}

// Response 200
interface BOMEntry {
  designator: string;
  quantity: number;
  value: string;
  footprint: string;
  mpn: string;
  manufacturer: string;
  lcscPartNumber?: string;
  description: string;
}
```

---

## WebSocket Events

WebSocket at `ws://localhost:3001/ws` for real-time features.

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `subscribe:project` | `{ projectId }` | Watch for changes (future collab) |
| `llm:message` | `LLMChatRequest` | Alternative to REST for streaming |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `llm:chunk` | `{ content }` | Streaming LLM response text |
| `llm:tool_call` | `{ name, args }` | LLM wants to execute a tool |
| `llm:done` | `{}` | LLM response complete |
| `llm:error` | `{ message }` | Error during LLM processing |

---

## Error Format

All errors follow a consistent format:

```typescript
interface APIError {
  error: {
    code: string;        // e.g. "COMPONENT_NOT_FOUND"
    message: string;
    details?: any;
  };
}
```

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `INVALID_REQUEST` | Malformed request body |
| 404 | `NOT_FOUND` | Resource not found |
| 429 | `RATE_LIMITED` | Too many LLM requests |
| 500 | `INTERNAL_ERROR` | Server error |
| 503 | `LLM_UNAVAILABLE` | Gemini API unreachable |
