# Agent D — View Management, Split Screen & UI Integration

## Objective
Wire everything together: add Schematic/PCB view tabs, split-screen mode, cross-highlighting between views, layer controls, and integrate the PCB renderer + component drawer into `main.ts`.

## Prerequisites
- **Agent A** complete: PCB types and commands in `types.ts` and `pcb-document.ts`
- **Agent B** complete: Footprint library in `footprint-library.ts`
- **Agent C** complete: `PCBRenderer` in `pcb/pcb-renderer.ts` and `ComponentDrawer` in `pcb/component-drawer.ts`

## Context
- Read `client/src/main.ts` thoroughly — it's the main application file (~1150 lines) that orchestrates everything
- Read `client/src/style.css` for the existing design system (dark theme, color variables, panel layouts)
- Read `client/src/schematic/canvas-renderer.ts` for the `highlightComponent` method you'll add
- The app uses a dark theme with `#1a1a2e` background, `#00c9a7` accent color, `#e2e2e2` text

## Deliverables

### 1. Modify `client/src/schematic/canvas-renderer.ts`

Add cross-highlight support:

```typescript
// Add to class properties
private highlightedComponentId: string | null = null;

// Add public method
highlightComponent(id: string | null): void {
  this.highlightedComponentId = id;
}
```

In the `renderComponents` method, when rendering a component whose `id === this.highlightedComponentId`:
- Draw a green glow effect (use `ctx.shadowColor = '#00c9a7'`, `ctx.shadowBlur = 15`)
- Draw a thicker outline
- This is in addition to the existing "selected" highlight

### 2. Modify `client/src/main.ts`

This is the biggest change. You need to:

**a) Add view tabs to the toolbar HTML:**

After the app title, add a tab strip:
```html
<div class="view-tabs">
  <button id="tab-schematic" class="view-tab active">Schematic</button>
  <button id="tab-pcb" class="view-tab">PCB Layout</button>
  <button id="tab-split" class="view-tab" title="Split View">⬒</button>
</div>
```

**b) Restructure the main area.**

Currently the main area is:
```html
<div class="main-area">
  <aside class="library-panel">...</aside>
  <main class="canvas-container" id="canvas-container"></main>
  <aside class="properties-panel">...</aside>
</div>
```

Change to support dual views:
```html
<div class="main-area">
  <aside class="library-panel" id="library-panel">...</aside>
  
  <div class="views-container" id="views-container">
    <main class="canvas-container" id="canvas-container"></main>
    <main class="canvas-container pcb-canvas-container" id="pcb-container" style="display:none"></main>
  </div>
  
  <aside class="properties-panel" id="properties-panel">...</aside>
  
  <!-- Component Drawer (PCB mode only) -->
  <aside class="component-drawer-panel" id="component-drawer" style="display:none">
    <h3>Unplaced Components</h3>
    <div id="drawer-content"></div>
  </aside>
</div>
```

**c) Initialize the PCB renderer (lazy — only when first switching to PCB tab):**

```typescript
import { PCBRenderer } from './pcb';
import { ComponentDrawer } from './pcb/component-drawer';
import { FootprintLibrary } from './library/footprint-library';
import { createPCBLayout, PlacePCBComponentCommand, MovePCBComponentCommand, InitializePCBFromSchematicCommand } from './core/pcb-document';

let pcbRenderer: PCBRenderer | null = null;
let componentDrawer: ComponentDrawer | null = null;
const footprintLibrary = new FootprintLibrary();
let currentView: 'schematic' | 'pcb' | 'split' = 'schematic';

function initPCBView() {
  if (pcbRenderer) return;
  
  // Initialize PCB layout if not present
  if (!doc.pcbLayout) {
    doc.pcbLayout = createPCBLayout();
    // Create unplaced PCB components for all schematic components
    const cmd = new InitializePCBFromSchematicCommand(doc);
    commandStack.execute(cmd);
  }
  
  const pcbContainer = document.getElementById('pcb-container')!;
  pcbRenderer = new PCBRenderer(pcbContainer);
  pcbRenderer.setDocument(doc);
  pcbRenderer.setFootprintMap(footprintLibrary.getMap());
  pcbRenderer.centerView();
  
  // Set up drawer
  const drawerContainer = document.getElementById('drawer-content')!;
  componentDrawer = new ComponentDrawer(drawerContainer);
  componentDrawer.update(doc, libraryMap);
  
  // Wire up PCB callbacks
  pcbRenderer.onComponentPlaced = (pcbCompId, pos) => {
    const cmd = new PlacePCBComponentCommand(pcbCompId, pos);
    commandStack.execute(cmd);
    componentDrawer?.update(doc, libraryMap);
  };
  
  pcbRenderer.onComponentMoved = (pcbCompId, pos) => {
    const cmd = new MovePCBComponentCommand(pcbCompId, pos);
    commandStack.execute(cmd);
  };
  
  // Cross-highlighting: PCB → Schematic
  pcbRenderer.onComponentSelected = (schematicId) => {
    renderer.highlightComponent(schematicId);
    if (schematicId) {
      updatePropertiesPanel([schematicId]);
    }
  };
}
```

**d) Wire up view tab switching:**

```typescript
function switchView(view: 'schematic' | 'pcb' | 'split') {
  currentView = view;
  const schematicContainer = document.getElementById('canvas-container')!;
  const pcbContainer = document.getElementById('pcb-container')!;
  const libraryPanel = document.getElementById('library-panel')!;
  const drawerPanel = document.getElementById('component-drawer')!;
  
  // Update tab active states
  document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
  
  switch (view) {
    case 'schematic':
      schematicContainer.style.display = '';
      pcbContainer.style.display = 'none';
      libraryPanel.style.display = '';
      drawerPanel.style.display = 'none';
      document.getElementById('tab-schematic')!.classList.add('active');
      break;
    case 'pcb':
      initPCBView();
      schematicContainer.style.display = 'none';
      pcbContainer.style.display = '';
      libraryPanel.style.display = 'none';
      drawerPanel.style.display = '';
      document.getElementById('tab-pcb')!.classList.add('active');
      break;
    case 'split':
      initPCBView();
      schematicContainer.style.display = '';
      pcbContainer.style.display = '';
      libraryPanel.style.display = '';
      drawerPanel.style.display = '';
      document.getElementById('tab-split')!.classList.add('active');
      // Apply split layout CSS
      document.getElementById('views-container')!.classList.add('split-view');
      break;
  }
  
  if (view !== 'split') {
    document.getElementById('views-container')!.classList.remove('split-view');
  }
}
```

**e) Cross-highlighting: Schematic → PCB:**

In the existing `renderer.onComponentSelected` callback, add:
```typescript
renderer.onComponentSelected = (ids: string[]) => {
  updatePropertiesPanel(ids);
  if (pcbRenderer && ids.length > 0) {
    pcbRenderer.highlightComponent(ids[0]);
  }
};
```

**f) Layer controls (shown when PCB view is active):**

Add to toolbar (conditionally visible):
```html
<div class="pcb-layer-controls" id="pcb-layer-controls" style="display:none">
  <select id="active-layer">
    <option value="F.Cu">Front Copper</option>
    <option value="B.Cu">Back Copper</option>
    <option value="In1.Cu">Inner 1</option>
    <option value="In2.Cu">Inner 2</option>
  </select>
  <div class="layer-visibility">
    <label><input type="checkbox" data-layer="F.Cu" checked> F.Cu</label>
    <label><input type="checkbox" data-layer="B.Cu" checked> B.Cu</label>
  </div>
</div>
```

### 3. Modify `client/src/style.css`

Add styles for:

```css
/* View Tabs */
.view-tabs { display: flex; gap: 2px; margin-left: 16px; }
.view-tab {
  background: transparent; border: none; color: var(--text-dim, #8888aa);
  padding: 6px 14px; font-size: 13px; cursor: pointer; border-radius: 6px 6px 0 0;
  transition: all 0.2s;
}
.view-tab.active { background: var(--bg-surface, #16213e); color: #e2e2e2; }
.view-tab:hover { color: #e2e2e2; }

/* Split View */
.views-container { display: flex; flex: 1; position: relative; }
.views-container.split-view .canvas-container { flex: 1; }
.views-container.split-view .canvas-container + .canvas-container {
  border-left: 2px solid #333;
}

/* Component Drawer */
.component-drawer-panel {
  width: 200px; background: #16213e; border-left: 1px solid #333;
  padding: 12px; overflow-y: auto;
}
/* ... drawer item styles ... */

/* Layer Controls */
.pcb-layer-controls {
  display: flex; align-items: center; gap: 8px; margin-left: 8px;
}
.pcb-layer-controls select {
  background: #1a1a2e; color: #e2e2e2; border: 1px solid #333;
  border-radius: 4px; padding: 4px 8px; font-size: 12px;
}
.layer-visibility { display: flex; gap: 6px; }
.layer-visibility label {
  font-size: 11px; color: #8888aa; display: flex; align-items: center; gap: 3px;
}
```

## Important Notes
- Do NOT modify server files
- Do NOT modify `pcb-renderer.ts` or `component-drawer.ts` — Agent C builds those
- The schematic renderer only needs the small `highlightComponent` addition
- Keep the LLM chat drawer working as-is — it should remain visible in all views
- The properties panel should work for components selected in either view
- Make sure keyboard shortcuts (V, W, Ctrl+Z, Delete) still work — they apply to whichever view is active
- The `document:changed` event should trigger re-renders in both views
