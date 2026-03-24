# Smart Circuit — Component Library Specification

## Overview

Each component has a **Symbol** (schematic), **Footprint** (PCB), and **Metadata** (specs, sourcing).

---

## Core Types

```typescript
interface ComponentDefinition {
  id: string;
  name: string;
  description: string;
  category: string;       // "resistors" | "capacitors" | "ics_analog" | ...
  symbol: SymbolDefinition;
  footprint: FootprintDefinition;
  manufacturer?: string;
  mpn?: string;
  datasheet?: string;
  lcscPartNumber?: string;
  properties: Record<string, string>;
  tags: string[];
}

interface SymbolDefinition {
  id: string;
  width: number;
  height: number;
  origin: Point;
  pins: PinDefinition[];
  graphics: SymbolGraphic[];
  designatorPosition: Point;
  valuePosition: Point;
}

interface SymbolGraphic {
  type: 'line' | 'rect' | 'circle' | 'arc' | 'polyline' | 'text';
  properties: Record<string, any>;
}

interface FootprintDefinition {
  id: string;
  name: string;
  pads: PadDefinition[];
  courtyard: Polygon;
  silkscreen: FootprintGraphic[];
  origin: Point;
}

interface PadDefinition {
  id: string;
  pinNumber: string;
  shape: 'rect' | 'circle' | 'oval' | 'roundrect';
  position: Point;
  width: number;
  height: number;
  layer: 'front' | 'back' | 'through';
  drill?: number;
}
```

---

## Built-in Library

### Passives
| ID | Name | Pins |
|----|------|------|
| `res_generic` | Resistor | 2 |
| `cap_generic` | Capacitor | 2 |
| `cap_polarized` | Electrolytic Cap | 2 (+, −) |
| `ind_generic` | Inductor | 2 |

### Semiconductors
| ID | Name | Pins |
|----|------|------|
| `diode_generic` | Diode | 2 (A, K) |
| `led_generic` | LED | 2 (A, K) |
| `npn_generic` | NPN BJT | 3 (B, C, E) |
| `nmos_generic` | N-MOSFET | 3 (G, D, S) |

### Power Symbols
| ID | Net |
|----|-----|
| `pwr_gnd` | GND |
| `pwr_3v3` | +3V3 |
| `pwr_5v` | +5V |
| `pwr_vcc` | VCC |

---

## File Structure

```
public/library/
├── passives/res_generic.json
├── semiconductors/diode_generic.json
├── connectors/header_1x2.json
└── index.json              ← Manifest
```

## Extending the Library

1. **Manual** — Add JSON file to library folder
2. **JLCPCB import** — Search via `jlcsearch.tscircuit.com` API, import by LCSC part number
3. **LLM-generated** — LLM creates definition from datasheet description

### JLCPCB Search API (via jlcsearch.tscircuit.com)

No API key required. Key endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /api/search?q=<query>&limit=20` | Full-text search |
| `GET /components/list.json?search=<query>&package=<pkg>` | Filtered search |
| `GET /resistors/list.json?resistance=10k` | Category-specific |
| `GET /capacitors/list.json?capacitance=100nF` | Category-specific |
| `GET /voltage_regulators/list.json` | Category listing |

All endpoints return JSON with component details including LCSC part number, pricing, stock, and specs.
