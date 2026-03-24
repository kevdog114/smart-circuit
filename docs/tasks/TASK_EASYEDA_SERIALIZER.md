# Agent Task: EasyEDA Serializer

## Objective
Implement the EasyEDA Standard JSON exporter that converts our `CircuitDocument` into a file that opens correctly in EasyEDA (https://easyeda.com/editor).

## Context
- The app is a Vite + TypeScript schematic editor at `/Users/klschaefer/dev-projects/smart-circuit/`
- **Format spec**: Read `docs/EASYEDA_FORMAT.md` — it has the full shape string format and mapping tables
- **Data model**: Read `client/src/core/types.ts` — all TypeScript interfaces

## What Exists
- `client/src/main.ts` — has a placeholder export button (line ~300) that just dumps raw JSON
- `client/src/export/` — empty directory ready for your code

## What to Build

### `client/src/export/easyeda-serializer.ts`
Convert `CircuitDocument` → EasyEDA Standard JSON:
- Top-level structure: `{ docType: "1", head: {...}, canvas: "...", shape: [...] }`
- `Component` → `LIB` shape string (nested pin/graphic shapes)
- `Wire` → `W~x1 y1 x2 y2~#008800~1~0~ggeID~netName`
- `NetLabel` → `N~x~y~rotation~...`
- `Junction` → `J~x~y~id~radius~color`
- Pin type mapping: passive=4, power=5, input=1, output=2, etc.

### `client/src/export/easyeda-id-gen.ts`
Monotonic `gge<N>` ID generator (EasyEDA requires this format).

### Update `client/src/main.ts`
Wire the export button to use the serializer instead of raw JSON dump.

## Acceptance Criteria
1. Export button downloads a `.json` file
2. The file has valid EasyEDA structure (docType, head, canvas, shape array)
3. Shape strings use `~` delimiters with correct attribute order
4. A circuit with R1 + C1 + wire between them exports correctly
5. Ideally, the exported file opens in EasyEDA without errors

## Key Files to Read First
- `docs/EASYEDA_FORMAT.md` (format spec)
- `client/src/core/types.ts` (data model)
- `client/src/main.ts` (current export button, ~line 300)
