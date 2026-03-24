# Smart Circuit — EasyEDA Export Format Reference

## Overview

Smart Circuit exports to the **EasyEDA Standard** JSON format. This allows users to open their designs in EasyEDA for final DRC, annotation, and gerber file generation. This document describes the target format and how our internal data model maps to it.

> [!IMPORTANT]
> We target **EasyEDA Standard** (not EasyEDA Pro). The Pro version uses a different `.epro` ZIP-based format with JSON Lines files.

---

## Top-Level Structure

An EasyEDA schematic file is a JSON object:

```json
{
  "docType": "1",
  "head": {
    "docType": "1",
    "editorVersion": "6.5.40",
    "title": "My Circuit",
    "description": "",
    "c_para": {},
    "x": "0",
    "y": "0",
    "hasId498": true
  },
  "canvas": "CA~1000~1000~#FFFFFF~yes~#CCCCCC~5~1000~1000~line~0.5~mm~1~45~visible~0.5~0~0~0~;;;",
  "shape": [
    "...shape string 1...",
    "...shape string 2..."
  ],
  "title": "My Circuit",
  "BBox": {
    "x": -100,
    "y": -200,
    "width": 800,
    "height": 600
  },
  "colors": {},
  "routerRule": {},
  "netColors": {}
}
```

### docType Values

| Value | Type |
|-------|------|
| `1` | Schematic |
| `2` | Schematic Symbol |
| `3` | PCB |
| `4` | PCB Footprint |

---

## Shape String Format

Shapes are encoded as **tilde-delimited strings** within the `shape` array. Each shape type has its own prefix and attribute order.

### Common Shape Types (Schematic)

#### Wire (`W`)
```
W~x1 y1 x2 y2 [x3 y3 ...]~strokeColor~strokeWidth~0~ggeID~net
```

Example:
```
W~380 300 450 300~#008800~1~0~gge10~+3V3
```

#### Component / SchematicLib (`LIB`)
```
LIB~x~y~package~rotation~importFlag~id~locked~mirror~designator~...
```

A `LIB` shape contains nested shapes for its symbol graphics (lines, arcs, pins, text).
Nested shapes within a `LIB` block are joined using the `#@$` delimiter (not newlines).

Example:
```
LIB~100~200~R0603~0~~gge1~0~0~R1~#@$PL~90 190 110 190~#000000~1~0~gge2~0#@$P~show~4~90~200~80~200~#880000~1~1~~gge3~0
```

#### Pin (`P`)
```
P~show~electric~x1~y1~x2~y2~color~pinName~pinNumber~...~id~locked
```

- `show`: pin name visibility
- `electric`: pin type (0=unspecified, 1=input, 2=output, 3=bidirectional, 4=passive)

#### Net Label (`N`)
```
N~x~y~rotation~mirror~color~netName~fontSize~id~locked~visible
```

#### Net Flag / Power Flag (`F`)
```
F~power~netName~x~y~rotation~id~...
```

Standard power flags: `GND`, `VCC`, `VDD`, `+3V3`, `+5V`, etc.

#### Text (`T`)
```
T~L~x~y~rotation~mirror~color~fontSize~fontFamily~fontWeight~fontStyle~text~id~locked~visible
```

#### Rectangle (`R`)
```
R~x~y~rx~ry~width~height~fillColor~strokeWidth~rotation~fillStyle~id~locked
```

#### Line / Polyline (`PL`)
```
PL~x1 y1 x2 y2 ...~strokeColor~strokeWidth~0~id~locked
```

#### Ellipse / Circle (`E`)
```
E~cx~cy~rx~ry~fillColor~strokeColor~strokeWidth~id~locked
```

#### Arc (`A`)
```
A~M x1 y1 A rx ry rotation largeArc sweep x2 y2~strokeColor~strokeWidth~fillStyle~id~locked
```

#### Junction (`J`)
```
J~x~y~id~junctionCircleRadius~fillColor
```

---

## Shape String Format (PCB)

#### Track (`TRACK`)
```
TRACK~strokeWidth~layer~net~points~id~locked
```

#### Pad (`PAD`)
```
PAD~shape~x~y~width~height~layer~net~number~holeRadius~points~rotation~id~locked~plated
```

- `shape`: `ELLIPSE`, `RECT`, `OVAL`, `POLYGON`

#### Via (`VIA`)
```
VIA~x~y~outerDiameter~holeRadius~net~id~locked
```

#### Board Outline (`SOLIDREGION`)
```
SOLIDREGION~solid~boardOutline~points~type~id~locked
```

---

## Mapping: Our Data Model → EasyEDA

### Component → LIB Shape

```typescript
function componentToEasyEDA(comp: Component, def: ComponentDefinition): string {
  // 1. Create LIB header with position, rotation, package name
  // 2. Append nested shapes from symbol definition (lines, arcs, text)
  // 3. Append pin shapes with electrical type mapping
  // 4. Append designator and value text labels
}
```

### Pin Type Mapping

| Our PinType | EasyEDA Electric Code |
|------------|----------------------|
| `unspecified` | `0` |
| `input` | `1` |
| `output` | `2` |
| `bidirectional` | `3` |
| `passive` | `4` |
| `power` | `5` |
| `open_collector` | `6` |
| `open_emitter` | `7` |

### Wire → W Shape

```typescript
function wireToEasyEDA(wire: Wire, net: Net): string {
  const points = wire.segments
    .flatMap(s => [s.start, s.end])
    .map(p => `${p.x} ${p.y}`)
    .join(' ');
  return `W~${points}~#008800~1~0~${generateId()}~${net.name}`;
}
```

### Net Label → N Shape

```typescript
function netLabelToEasyEDA(label: NetLabel): string {
  return `N~${label.position.x}~${label.position.y}~${label.rotation}~0~#0000FF~${label.netName}~8pt~${generateId()}~0~1`;
}
```

---

## Canvas String

The canvas string configures the drawing area:

```
CA~width~height~bgColor~gridVisible~gridColor~gridSize~viewportWidth~viewportHeight~
lineStyle~lineWidth~units~snapToGrid~snapAngle~othersVisible~snapSize~
originX~originY~rotation~;;;
```

Default for schematics:
```
CA~1000~1000~#FFFFFF~yes~#CCCCCC~10~1000~1000~line~1~mil~1~45~visible~10~0~0~0~;;;
```

---

## ID Generation

EasyEDA uses IDs in the format `gge<number>` (e.g., `gge1`, `gge42`). Our exporter should maintain a monotonic counter starting from `1`.

```typescript
let _idCounter = 0;
function generateEasyEDAId(): string {
  return `gge${++_idCounter}`;
}
```

---

## Validation Checklist

Before exporting, validate:

- [ ] All components have valid designators (no duplicates)
- [ ] All pins in a net have consistent types (no output-to-output)
- [ ] All wires are connected (no floating endpoints)
- [ ] All required component properties are set (package, value)
- [ ] Power nets have at least one power source
- [ ] No overlapping components at the same position

## Testing Strategy

1. **Hand-craft a known-good EasyEDA JSON** from a simple circuit (e.g., LED + resistor + battery)
2. **Export our representation** of the same circuit
3. **Compare** the two JSON files structurally
4. **Open both in EasyEDA** and verify they render identically
5. Automate with snapshot tests for regression
