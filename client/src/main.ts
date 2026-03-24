import { createDocument, createSheet, nextDesignator, AddComponentCommand, AddWireCommand, AddWireNodeCommand, MoveWireNodeCommand, DeleteWireNodeCommand, MoveComponentCommand, RotateComponentCommand, DeleteComponentCommand, DeleteWireCommand } from './core/index';
import { API_BASE } from './config';
import { CommandStack } from './core/command-stack';
import { eventBus } from './core/event-bus';
import { SchematicRenderer } from './schematic/canvas-renderer';
import type { ComponentDefinition, Point, CircuitDocument } from './core/types';
import { serializeToEasyEDA, type EasyEDADocument } from './export/easyeda-serializer';
import { serializeToEasyEDAPCB } from './export/easyeda-pcb-serializer';
import { serializeToKiCad } from './export/kicad-serializer';
import { importFromEasyEDA, importMultipleFromEasyEDA } from './import/easyeda-importer';
import { importFromEasyEDAPro } from './import/easyeda-pro-importer';
import { builtinLibrary } from './library/builtin-library';
import { resolvedToComponentDef, resolvedFootprintToDefinition, type ResolvedComponentResponse } from './library/easyeda-parser';
import { ToolExecutor } from './llm/tool-executor';
import { saveProject, listProjects, getProject, deleteProject, saveComponentsToLibrary, fetchComponentsFromLibrary } from './services/api';
import { WebSocketService } from './services/websocket-service';
import { PCBRenderer, ComponentDrawer } from './pcb';
import { FootprintLibrary } from './library/footprint-library';
import type { FootprintDefinition } from './library/easyeda-parser';
import { createPCBLayout, MovePCBComponentCommand, InitializePCBFromSchematicCommand } from './core/pcb-document';
import type { PCBLayer } from './core/types';
import { SimulationPanel } from './simulation/simulation-panel';
import { SimulationEngine } from './simulation/simulation-engine';
import { generateNetlist } from './simulation/netlist-generator';
import './style.css';

// ---- Prevent Safari native pinch-to-zoom at the document level ----
// Safari fires non-standard gesture* events for trackpad pinch; preventing
// them here stops the browser from applying its own page zoom.
document.addEventListener('gesturestart', (e) => { try { e.preventDefault(); } catch (_) {} }, { passive: false } as any);
document.addEventListener('gesturechange', (e) => { try { e.preventDefault(); } catch (_) {} }, { passive: false } as any);
document.addEventListener('gestureend', (e) => { try { e.preventDefault(); } catch (_) {} }, { passive: false } as any);
// Also intercept Ctrl+wheel (the synthetic wheel event Safari emits for pinch)
// at the document level so the browser never gets a chance to zoom the page.
document.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    try { e.preventDefault(); } catch (_) {}
  }
}, { passive: false });

// ----- Initialize Document -----
let doc = createDocument('Untitled');
let commandStack = new CommandStack(doc);
let activeSheetIndex = 0;
function getActiveSheet() { return doc.sheets[activeSheetIndex]; }

// ----- WebSocket Auto-Save -----
const wsService = new WebSocketService();

wsService.onConnectionChange = (state) => {
  const dot = document.getElementById('ws-dot');
  const label = document.getElementById('ws-label');
  const toast = document.getElementById('ws-toast');

  if (dot && label) {
    dot.className = `ws-dot ${state}`;
    label.className = `ws-label ${state}`;
    const labelText: Record<string, string> = {
      connected: 'Synced',
      disconnected: 'Offline',
      connecting: 'Connecting',
    };
    label.textContent = labelText[state] || state;
  }

  if (toast) {
    if (state === 'disconnected') {
      toast.classList.add('visible');
    } else if (state === 'connected') {
      toast.classList.remove('visible');
    }
  }
};

wsService.onSaveAck = (data) => {
  doc.updatedAt = data.updatedAt;
};

// Connect once DOM is ready (we're already in a module, so DOM is parsed)
wsService.connect();

// Allow manual toast dismiss
setTimeout(() => {
  document.getElementById('ws-toast-dismiss')?.addEventListener('click', () => {
    document.getElementById('ws-toast')?.classList.remove('visible');
  });
}, 0);

const libraryMap = new Map<string, ComponentDefinition>();
builtinLibrary.forEach(def => libraryMap.set(def.id, def));

/** Restore non-builtin library definitions when loading a saved project */
async function restoreCustomLibrary(loadedDoc: CircuitDocument) {
  // 1. Legacy: restore from customLibrary field if present
  if (loadedDoc.customLibrary) {
    for (const def of loadedDoc.customLibrary) {
      libraryMap.set(def.id, def);
    }
    // Also migrate to server-side library
    saveComponentsToLibrary(loadedDoc.customLibrary);
  }

  // 2. Collect non-builtin libraryIds from all sheets
  const missingIds = new Set<string>();
  for (const sheet of loadedDoc.sheets) {
    for (const comp of sheet.components) {
      if (comp.libraryId && !libraryMap.has(comp.libraryId)) {
        missingIds.add(comp.libraryId);
      }
    }
  }

  if (missingIds.size > 0) {
    const fetched = await fetchComponentsFromLibrary([...missingIds]);
    for (const [id, def] of fetched.entries()) {
      libraryMap.set(id, def);
    }
    console.log(`Restored ${fetched.size}/${missingIds.size} component definitions from library`);
  }
}

// Tool executor is initialized after the DOM is ready (see LLM Chat section)
let toolExecutor: ToolExecutor;

// ----- Initialize App -----
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="app-layout">
    <header class="toolbar" id="toolbar">
      <div class="toolbar-group">
        <span class="app-title">⚡ Smart Circuit</span>
        <span class="project-name" id="project-name" title="Project name">Untitled</span>
        <div class="view-tabs">
          <button id="tab-schematic" class="view-tab active">Schematic</button>
          <button id="tab-pcb" class="view-tab">PCB Layout</button>
          <button id="tab-split" class="view-tab" title="Split View">⬒</button>
        </div>
      </div>
      <div class="toolbar-group">
        <button id="tool-select" class="tool-btn active" title="Select (V)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3 1l10 6.5L8 9l-2 6L3 1z"/></svg>
        </button>
        <button id="tool-wire" class="tool-btn" title="Wire (W)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 14L7 7L14 2"/></svg>
        </button>
        <button id="tool-pan" class="tool-btn" title="Pan (H)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1v3M8 12v3M5.5 4V2.5a1 1 0 00-2 0V9M3.5 7V5.5a1 1 0 00-2 0V10a5 5 0 005 5h3a5 5 0 005-5V5.5a1 1 0 00-2 0V4M8 4V1.5a1 1 0 012 0V4M10.5 4V2.5a1 1 0 012 0V9"/></svg>
        </button>
        <div class="toolbar-separator"></div>
        <button id="btn-rotate" class="tool-btn" title="Rotate (Space)" disabled>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8a5.5 5.5 0 11-2-4.24"/><path d="M13.5 2v4h-4"/></svg>
        </button>
        <button id="btn-delete" class="tool-btn" title="Delete" disabled>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M5.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1M6 7v4M8 7v4M10 7v4M4 4l.7 8.4a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4"/></svg>
        </button>
        <div class="toolbar-separator"></div>
        <button id="btn-undo" class="tool-btn" title="Undo (Ctrl+Z)" disabled>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7h7a3 3 0 010 6H8M3 7l3-3M3 7l3 3"/></svg>
        </button>
        <button id="btn-redo" class="tool-btn" title="Redo (Ctrl+Y)" disabled>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 7H6a3 3 0 000 6h2M13 7l-3-3M13 7l-3 3"/></svg>
        </button>
        <div class="toolbar-separator"></div>
        <div class="menu-wrapper" id="menu-wrapper">
          <button id="btn-menu" class="tool-btn" title="File Menu">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h12M2 8h12M2 12h12"/></svg>
          </button>
          <div class="menu-dropdown" id="menu-dropdown">
            <button class="menu-item" id="menu-new">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>
              New Project
            </button>
            <div class="menu-divider"></div>
            <button class="menu-item" id="menu-save">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 14H3a1 1 0 01-1-1V3a1 1 0 011-1h7l4 4v7a1 1 0 01-1 1zM10 2v4H6V2M4 14v-4h8v4"/></svg>
              Save Project
            </button>
            <button class="menu-item" id="menu-load">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 5a1 1 0 011-1h4l2 2h4a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1V5z"/></svg>
              Open Project
            </button>
            <div class="menu-divider"></div>
            <button class="menu-item" id="menu-import">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 14V6M4 10l4-4 4 4M2 2h12"/></svg>
              Import EasyEDA
            </button>
            <button class="menu-item" id="menu-export">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8M4 6l4 4 4-4M2 12h12"/></svg>
              Export EasyEDA
            </button>
            <button class="menu-item" id="menu-export-kicad">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8M4 6l4 4 4-4M2 12h12"/></svg>
              Export KiCad
            </button>
            <button class="menu-item" id="menu-export-easyeda-pcb">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8M4 6l4 4 4-4M2 12h12"/></svg>
              Export EasyEDA (Include PCB)
            </button>
            <div class="menu-divider"></div>
            <button class="menu-item" id="menu-bom">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1zM6 5h5M6 8h5M6 11h3"/></svg>
              Bill of Materials
            </button>
          </div>
        </div>
        <div class="toolbar-separator"></div>
        <button id="btn-zoom-out" class="tool-btn zoom-btn" title="Zoom Out (−)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><path d="M5 7h4M11 11l3.5 3.5"/></svg>
        </button>
        <span id="zoom-label" class="zoom-label">100%</span>
        <button id="btn-zoom-in" class="tool-btn zoom-btn" title="Zoom In (+)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><path d="M7 5v4M5 7h4M11 11l3.5 3.5"/></svg>
        </button>
        <div class="pcb-layer-controls" id="pcb-layer-controls" style="display:none">
          <div class="toolbar-separator"></div>
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
      </div>
      <div class="toolbar-group">
        <div class="ws-status" id="ws-status" title="Server connection">
          <span class="ws-dot disconnected" id="ws-dot"></span>
          <span class="ws-label disconnected" id="ws-label">Offline</span>
        </div>
        <div class="toolbar-separator"></div>
        <button id="btn-simulate" class="tool-btn sim-btn" title="Simulate (F5)">📊 Sim</button>
        <button id="btn-llm" class="tool-btn llm-btn" title="AI Assistant">🤖 AI</button>
      </div>

    <!-- WebSocket Disconnection Toast -->
    <div class="ws-toast" id="ws-toast">
      <span class="ws-toast-icon">⚠️</span>
      <span class="ws-toast-text">Connection lost — changes will sync when reconnected</span>
      <button class="ws-toast-dismiss" id="ws-toast-dismiss">✕</button>
    </div>
    </header>

    <div class="main-area">
      <button class="panel-toggle panel-toggle-left" id="toggle-library" title="Toggle Library">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1zM6 5h5M6 8h5M6 11h3"/></svg>
      </button>
      <aside class="library-panel" id="library-panel">
        <h3>Components</h3>
        <div id="lib-builtin" class="lib-section">
          <h4>Built-in</h4>
          <div id="lib-list"></div>
        </div>
        <button id="btn-jlcpcb-lib" class="jlcpcb-lib-btn">🔍 Search JLCPCB…</button>
      </aside>

      <div class="views-container" id="views-container">
        <main class="canvas-container" id="canvas-container"></main>
        <div id="sheet-tabs"></div>
        <main class="canvas-container pcb-canvas-container" id="pcb-container" style="display:none"></main>
      </div>

      <aside class="properties-panel" id="properties-panel">
        <h3>Properties</h3>
        <div id="prop-content">
          <p class="hint">Select a component to view its properties.</p>
        </div>
      </aside>
      <button class="panel-toggle panel-toggle-right" id="toggle-properties" title="Toggle Properties">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12.5 3h-9a1 1 0 00-1 1v8a1 1 0 001 1h9a1 1 0 001-1V4a1 1 0 00-1-1zM10 6v4"/></svg>
      </button>

      <!-- Component Drawer (PCB mode only) -->
      <aside class="component-drawer-panel" id="component-drawer" style="display:none">
        <div id="drawer-content"></div>
      </aside>
    </div>

    <!-- Simulation Panel (bottom drawer) -->
    <div class="sim-drawer" id="sim-drawer" style="display:none"></div>

    <!-- Mobile Bottom Toolbar (touch devices only, hidden on desktop) -->
    <div class="mobile-toolbar" id="mobile-toolbar">
      <button class="mobile-tool-btn" id="m-tool-select" title="Select">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M3 1l10 6.5L8 9l-2 6L3 1z"/></svg>
        <span>Select</span>
      </button>
      <button class="mobile-tool-btn" id="m-tool-wire" title="Wire">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 14L7 7L14 2"/></svg>
        <span>Wire</span>
      </button>
      <button class="mobile-tool-btn" id="m-tool-pan" title="Pan">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1v3M8 12v3M5.5 4V2.5a1 1 0 00-2 0V9M3.5 7V5.5a1 1 0 00-2 0V10a5 5 0 005 5h3a5 5 0 005-5V5.5a1 1 0 00-2 0V4M8 4V1.5a1 1 0 012 0V4M10.5 4V2.5a1 1 0 012 0V9"/></svg>
        <span>Pan</span>
      </button>
      <button class="mobile-tool-btn" id="m-btn-rotate" title="Rotate" disabled>
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8a5.5 5.5 0 11-2-4.24"/><path d="M13.5 2v4h-4"/></svg>
        <span>Rotate</span>
      </button>
      <button class="mobile-tool-btn" id="m-btn-delete" title="Delete" disabled>
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M5.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1M6 7v4M8 7v4M10 7v4M4 4l.7 8.4a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4"/></svg>
        <span>Delete</span>
      </button>
      <button class="mobile-tool-btn" id="m-toggle-library" title="Library">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1zM6 5h5M6 8h5M6 11h3"/></svg>
        <span>Library</span>
      </button>
    </div>

    <div class="llm-drawer" id="llm-drawer" style="display:none">
      <div class="llm-header">
        <h3>🤖 AI Assistant</h3>
        <button id="llm-close" class="tool-btn">✕</button>
      </div>
      <div class="llm-messages" id="llm-messages"></div>
      <div class="llm-input-area">
        <textarea id="llm-input" placeholder="Ask about your circuit..." rows="2"></textarea>
        <button id="llm-send" class="send-btn">Send</button>
      </div>
    </div>
    
    <!-- Open Project Modal -->
    <div id="load-modal" class="modal-overlay" style="display:none">
      <div class="modal-content load-modal-content">
        <div class="modal-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" stroke-width="1.5" style="vertical-align: -3px; margin-right: 6px;"><path d="M2 5a1 1 0 011-1h4l2 2h4a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1V5z"/></svg>
            Open Project
          </h2>
          <button id="load-close" class="modal-close">✕</button>
        </div>
        <input type="text" id="project-search-input" class="project-search-input" placeholder="Search projects…" />
        <div id="load-list" class="project-list">
          <div class="empty-projects">
            <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="var(--text-dim)" stroke-width="1" style="margin-bottom: 8px;"><path d="M2 5a1 1 0 011-1h4l2 2h4a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1V5z"/></svg>
            <div>Loading projects…</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Save Project Modal -->
    <div id="save-modal" class="modal-overlay" style="display:none">
      <div class="modal-content save-modal-content">
        <div class="modal-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" stroke-width="1.5" style="vertical-align: -3px; margin-right: 6px;"><path d="M13 14H3a1 1 0 01-1-1V3a1 1 0 011-1h7l4 4v7a1 1 0 01-1 1zM10 2v4H6V2M4 14v-4h8v4"/></svg>
            Save Project
          </h2>
          <button id="save-close" class="modal-close">✕</button>
        </div>
        <div class="save-modal-body">
          <label class="save-label">Project Name</label>
          <input type="text" id="save-name-input" class="modal-input" placeholder="My Circuit Design" />
          <div class="modal-actions">
            <button id="save-cancel" class="btn-secondary">Cancel</button>
            <button id="save-confirm" class="btn-primary">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -2px; margin-right: 4px;"><path d="M13 14H3a1 1 0 01-1-1V3a1 1 0 011-1h7l4 4v7a1 1 0 01-1 1z"/></svg>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Toast Notification -->
    <div id="app-toast" class="app-toast"></div>

    <!-- Map JLCPCB Modal -->
    <div id="map-modal" class="modal-overlay" style="display:none">
      <div class="modal-content">
        <div class="modal-header">
          <h2>Map to JLCPCB Part</h2>
          <button id="map-close" class="modal-close">✕</button>
        </div>
        <div>
          <div style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
            <input type="text" id="map-search-input" class="modal-input" style="flex: 2; margin: 0;" placeholder="Search (e.g. 10k)..." />
            <input type="text" id="map-package-input" class="modal-input" style="flex: 1; margin: 0;" placeholder="Package" />
            <label style="display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-primary); cursor: pointer; white-space: nowrap;">
              <input type="checkbox" id="map-basic-filter" /> Basic Only
            </label>
          </div>
          <div style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
            <select id="map-category-filter" class="category-filter">
              <option value="">All Categories</option>
            </select>
          </div>
          <div id="map-results" style="max-height: 400px; overflow-y: auto;"></div>
        </div>
      </div>
    </div>

    <!-- BOM Modal -->
    <div id="bom-modal" class="modal-overlay" style="display:none">
      <div class="modal-content bom-modal-content">
        <div class="modal-header">
          <h2>Bill of Materials</h2>
          <button id="bom-close" class="modal-close">✕</button>
        </div>
        <div id="bom-body"></div>
      </div>
    </div>

    <!-- JLCPCB Library Modal -->
    <div id="jlcpcb-lib-modal" class="modal-overlay" style="display:none">
      <div class="modal-content jlcpcb-lib-modal-content">
        <div class="modal-header">
          <h2>JLCPCB Component Library</h2>
          <button id="jlcpcb-lib-close" class="modal-close">✕</button>
        </div>
        <div>
          <div style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
            <input type="text" id="jlcpcb-lib-search" class="modal-input" style="flex: 2; margin: 0;" placeholder="Search components…" />
            <input type="text" id="jlcpcb-lib-package" class="modal-input" style="flex: 1; margin: 0;" placeholder="Package" />
            <label style="display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-primary); cursor: pointer; white-space: nowrap;">
              <input type="checkbox" id="jlcpcb-lib-basic" /> Basic Only
            </label>
          </div>
          <div style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
            <select id="jlcpcb-lib-category" class="category-filter">
              <option value="">All Categories</option>
            </select>
          </div>
          <div id="jlcpcb-lib-results" style="max-height: 400px; overflow-y: auto;"></div>
        </div>
      </div>
    </div>
  </div>
`;

// ----- Schematic Renderer -----
const canvasContainer = document.getElementById('canvas-container')!;
const renderer = new SchematicRenderer(canvasContainer);
renderer.setDocument(doc);
renderer.setLibraryMap(libraryMap);
renderer.centerView();

// ----- PCB State -----
let pcbRenderer: PCBRenderer | null = null;
let componentDrawer: ComponentDrawer | null = null;
const footprintLibrary = new FootprintLibrary();
let currentView: 'schematic' | 'pcb' | 'split' = 'schematic';

function rebuildFootprintMap(): Map<string, any> {
  const fpMap = new Map<string, any>();
  if (!doc.pcbLayout) return fpMap;

  for (const pcbComp of doc.pcbLayout.components) {
    const schComp = doc.sheets.flatMap(s => s.components).find(c => c.id === pcbComp.schematicComponentId);
    if (!schComp) continue;
    const def = libraryMap.get(schComp.libraryId);
    if (!def) continue;
    const fp = footprintLibrary.getFootprint(
      { definitionId: schComp.libraryId, properties: schComp.properties },
      def
    );
    // Use the PCB component's footprintId as the key
    fpMap.set(pcbComp.footprintId, fp);
  }
  return fpMap;
}

function initPCBView() {
  if (pcbRenderer) return;

  // Initialize PCB layout if not present
  if (!doc.pcbLayout) {
    doc.pcbLayout = createPCBLayout();
    const cmd = new InitializePCBFromSchematicCommand();
    commandStack.execute(cmd);
  }

  // Ensure every PCB component has a footprintId set
  if (doc.pcbLayout) {
    for (const pcbComp of doc.pcbLayout.components) {
      if (!pcbComp.footprintId) {
        const schComp = doc.sheets.flatMap(s => s.components).find(c => c.id === pcbComp.schematicComponentId);
        if (schComp) {
          const def = libraryMap.get(schComp.libraryId);
          if (def) {
            pcbComp.footprintId = def.id;
          }
        }
      }
    }
  }

  const pcbContainer = document.getElementById('pcb-container')!;
  pcbRenderer = new PCBRenderer(pcbContainer);
  pcbRenderer.setDocument(doc);
  pcbRenderer.setFootprintMap(rebuildFootprintMap());
  pcbRenderer.centerView();

  // Set up drawer
  const drawerContainer = document.getElementById('drawer-content')!;
  componentDrawer = new ComponentDrawer(drawerContainer);
  componentDrawer.update(doc, libraryMap);

  // Wire up drawer drag → PCB renderer
  componentDrawer.onDragStart = (pcbCompId: string, _schematicCompId: string) => {
    pcbRenderer?.startDraggingComponent(pcbCompId);
  };

  // Wire up PCB placement callback
  pcbRenderer.onComponentPlaced = (pcbCompId: string, pos: Point) => {
    if (doc.pcbLayout) {
      const pcbComp = doc.pcbLayout.components.find(c => c.id === pcbCompId);
      if (pcbComp && !pcbComp.isPlaced) {
        pcbComp.isPlaced = true;
        pcbComp.position = { ...pos };
        doc.updatedAt = new Date().toISOString();

        // Make sure the footprint map has this component's entry
        pcbRenderer?.setFootprintMap(rebuildFootprintMap());
      }
    }
    componentDrawer?.update(doc, libraryMap);
  };

  // Wire up PCB move callback
  pcbRenderer.onComponentMoved = (pcbCompId: string, pos: Point) => {
    const cmd = new MovePCBComponentCommand(pcbCompId, pos);
    commandStack.execute(cmd);
  };

  // Cross-highlighting: PCB → Schematic
  pcbRenderer.onComponentSelected = (schematicId: string | null) => {
    renderer.highlightComponent(schematicId);
    if (schematicId) {
      updatePropertiesPanel([schematicId]);
    }
  };

  // PCB delete — unplace components (move back to drawer), does NOT delete from schematic
  pcbRenderer.onDeleteRequested = (pcbComponentIds: string[]) => {
    if (!doc.pcbLayout) return;
    for (const pcbId of pcbComponentIds) {
      const pcbComp = doc.pcbLayout.components.find(c => c.id === pcbId);
      if (pcbComp) {
        pcbComp.isPlaced = false;
        pcbComp.position = { x: 0, y: 0 };
      }
    }
    doc.updatedAt = new Date().toISOString();
    componentDrawer?.update(doc, libraryMap);
  };

  // PCB batch move (multi-select drag)
  pcbRenderer.onBatchMoved = (moves: { id: string; position: Point }[]) => {
    for (const move of moves) {
      const cmd = new MovePCBComponentCommand(move.id, move.position);
      commandStack.execute(cmd);
    }
  };

  // Update zoom label from PCB renderer (covers wheel, trackpad pinch, Safari gestures)
  pcbRenderer.onZoomChanged = (percent) => {
    if (currentView !== 'schematic') {
      zoomLabel.textContent = `${percent}%`;
    }
  };
}

// ----- View Switching -----
function switchView(view: 'schematic' | 'pcb' | 'split') {
  currentView = view;
  const schematicContainer = document.getElementById('canvas-container')!;
  const pcbContainer = document.getElementById('pcb-container')!;
  const libraryPanel = document.getElementById('library-panel')!;
  const drawerPanel = document.getElementById('component-drawer')!;
  const layerControls = document.getElementById('pcb-layer-controls')!;
  const viewsContainer = document.getElementById('views-container')!;
  const sheetTabs = document.getElementById('sheet-tabs')!;

  // Update tab active states
  document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));

  switch (view) {
    case 'schematic':
      schematicContainer.style.display = '';
      pcbContainer.style.display = 'none';
      libraryPanel.style.display = '';
      drawerPanel.style.display = 'none';
      layerControls.style.display = 'none';
      sheetTabs.style.display = 'flex';
      document.getElementById('tab-schematic')!.classList.add('active');
      break;
    case 'pcb':
      // Show container FIRST so PCBRenderer gets correct dimensions
      schematicContainer.style.display = 'none';
      pcbContainer.style.display = '';
      libraryPanel.style.display = 'none';
      drawerPanel.style.display = '';
      layerControls.style.display = 'flex';
      sheetTabs.style.display = 'none';
      document.getElementById('tab-pcb')!.classList.add('active');
      initPCBView();
      break;
    case 'split':
      // Show containers FIRST so PCBRenderer gets correct dimensions
      schematicContainer.style.display = '';
      pcbContainer.style.display = '';
      libraryPanel.style.display = '';
      drawerPanel.style.display = '';
      layerControls.style.display = 'flex';
      sheetTabs.style.display = 'flex';
      document.getElementById('tab-split')!.classList.add('active');
      viewsContainer.classList.add('split-view');
      initPCBView();
      break;
  }

  if (view !== 'split') {
    viewsContainer.classList.remove('split-view');
  }
}

// View tab event listeners
document.getElementById('tab-schematic')!.addEventListener('click', () => switchView('schematic'));
document.getElementById('tab-pcb')!.addEventListener('click', () => switchView('pcb'));
document.getElementById('tab-split')!.addEventListener('click', () => switchView('split'));

// ----- Sheet Tab Bar -----
function switchSheet(index: number) {
  if (index < 0 || index >= doc.sheets.length) return;
  activeSheetIndex = index;
  renderer.setActiveSheetIndex(index);
  renderer.clearSelection();
  updatePropertiesPanel([]);
  updateSelectionButtons(false);
  renderSheetTabs();
  renderer.centerView();
}

function renderSheetTabs() {
  const container = document.getElementById('sheet-tabs');
  if (!container) return;
  container.innerHTML = '';

  doc.sheets.forEach((sheet, i) => {
    const tab = document.createElement('button');
    tab.className = 'sheet-tab' + (i === activeSheetIndex ? ' active' : '');
    tab.dataset.index = String(i);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = sheet.name;
    tab.appendChild(nameSpan);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'sheet-tab-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (doc.sheets.length <= 1) return; // prevent deleting last sheet
      if (!confirm(`Delete sheet "${sheet.name}"?`)) return;
      doc.sheets.splice(i, 1);
      if (activeSheetIndex >= doc.sheets.length) {
        activeSheetIndex = doc.sheets.length - 1;
      }
      renderer.setActiveSheetIndex(activeSheetIndex);
      renderer.setDocument(doc);
      renderer.centerView();
      updatePropertiesPanel([]);
      renderSheetTabs();
    });
    tab.appendChild(closeBtn);

    // Click to switch
    tab.addEventListener('click', () => switchSheet(i));

    // Double-click to rename
    tab.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'sheet-tab-rename';
      input.value = sheet.name;
      nameSpan.replaceWith(input);
      input.focus();
      input.select();

      const finishRename = () => {
        const newName = input.value.trim() || sheet.name;
        sheet.name = newName;
        renderSheetTabs();
      };
      input.addEventListener('blur', finishRename);
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
        if (ke.key === 'Escape') { input.value = sheet.name; input.blur(); }
      });
    });

    container.appendChild(tab);
  });

  // Add sheet button
  const addBtn = document.createElement('button');
  addBtn.className = 'sheet-tab-add';
  addBtn.textContent = '+';
  addBtn.title = 'Add Sheet';
  addBtn.addEventListener('click', () => {
    const newSheet = createSheet(`Sheet ${doc.sheets.length + 1}`);
    doc.sheets.push(newSheet);
    switchSheet(doc.sheets.length - 1);
  });
  container.appendChild(addBtn);
}

// Initial render of sheet tabs
renderSheetTabs();

// ----- Layer Controls -----
document.getElementById('active-layer')!.addEventListener('change', (e) => {
  const layer = (e.target as HTMLSelectElement).value as PCBLayer;
  pcbRenderer?.setActiveLayer(layer);
});

document.querySelectorAll('.layer-visibility input[type="checkbox"]').forEach(cb => {
  cb.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const layer = input.dataset.layer as PCBLayer;
    pcbRenderer?.setLayerVisibility(layer, input.checked);
  });
});

// ----- Library Panel -----
const libList = document.getElementById('lib-list')!;
for (const def of builtinLibrary) {
  const btn = document.createElement('button');
  btn.className = 'lib-item';
  btn.textContent = def.name;
  btn.title = def.description;
  btn.addEventListener('click', () => {
    renderer.startPlacingComponent(def);
  });
  libList.appendChild(btn);
}

// ----- Component Placement -----
renderer.onComponentPlaced = (def: ComponentDefinition, position: Point, rotation: 0 | 90 | 180 | 270) => {
  const designator = nextDesignator(doc, def.designatorPrefix);
  const cmd = new AddComponentCommand(getActiveSheet().id, def, position, def.defaultValue || def.name, designator, rotation);
  commandStack.execute(cmd);
};

// ----- Wire Drawing -----
renderer.onWireDrawn = (segments) => {
  const cmd = new AddWireCommand(getActiveSheet().id, segments);
  commandStack.execute(cmd);
};

// ----- Wire Nodes -----
renderer.onWireNodeAdded = (wireId: string, position: Point) => {
  const cmd = new AddWireNodeCommand(getActiveSheet().id, wireId, position);
  commandStack.execute(cmd);
};

renderer.onWireNodeMoved = (nodeId: string, wireId: string, position: Point) => {
  const cmd = new MoveWireNodeCommand(getActiveSheet().id, nodeId, wireId, position);
  commandStack.execute(cmd);
};

renderer.onWireNodeDeleted = (nodeId: string, wireId: string) => {
  const cmd = new DeleteWireNodeCommand(getActiveSheet().id, nodeId, wireId);
  commandStack.execute(cmd);
};

// ----- Component Move -----
renderer.onComponentMoved = (id: string, position: Point) => {
  const cmd = new MoveComponentCommand(getActiveSheet().id, id, position);
  commandStack.execute(cmd);
};

// ----- Batch Move (multi-select drag) -----
renderer.onBatchMoved = (moves: { id: string; position: Point }[]) => {
  const sheetId = getActiveSheet().id;
  for (const move of moves) {
    const cmd = new MoveComponentCommand(sheetId, move.id, move.position);
    commandStack.execute(cmd);
  }
};

// ----- Component Rotate -----
renderer.onComponentRotated = (id: string) => {
  const comp = getActiveSheet().components.find(c => c.id === id);
  if (!comp) return;
  const def = libraryMap.get(comp.libraryId);
  if (!def) return;
  const cmd = new RotateComponentCommand(getActiveSheet().id, id, def);
  commandStack.execute(cmd);
};

// ----- Component Selection (with cross-highlight to PCB) -----
renderer.onComponentSelected = (ids: string[]) => {
  updatePropertiesPanel(ids);
  updateSelectionButtons(ids.length > 0);
  if (pcbRenderer && ids.length > 0) {
    pcbRenderer.highlightComponent(ids[0]);
  } else if (pcbRenderer) {
    pcbRenderer.highlightComponent(null);
  }
};

// ----- Net/Wire/Label Selection -----
renderer.onNetSelected = (info) => {
  if (!info) return; // Component was selected, properties handled by onComponentSelected
  updateNetPropertiesPanel(info);
};

// ----- Auto-Tool Switch (e.g., clicking a pin in select mode) -----
renderer.onToolChanged = (tool) => {
  setActiveTool(`tool-${tool}`);
};

// ----- Delete Handling -----
function countAttachedItems(componentId: string): { wires: number; labels: number } {
  const sheet = getActiveSheet();
  const comp = sheet.components.find(c => c.id === componentId);
  if (!comp) return { wires: 0, labels: 0 };

  const pinPositions = comp.pins.map(p => p.absolutePosition);
  let wires = 0;
  for (const wire of sheet.wires) {
    const firstSeg = wire.segments[0];
    const lastSeg = wire.segments[wire.segments.length - 1];
    const touchesPin = pinPositions.some(pp =>
      (firstSeg.start.x === pp.x && firstSeg.start.y === pp.y) ||
      (lastSeg.end.x === pp.x && lastSeg.end.y === pp.y)
    );
    if (touchesPin) wires++;
  }
  let labels = 0;
  for (const label of sheet.labels) {
    if (pinPositions.some(pp => label.position.x === pp.x && label.position.y === pp.y)) labels++;
  }
  return { wires, labels };
}

function showDeleteConfirmModal(
  componentIds: string[],
  attachedWires: number,
  attachedLabels: number,
): void {
  // Build description
  const items: string[] = [];
  if (attachedWires > 0) items.push(`${attachedWires} wire${attachedWires > 1 ? 's' : ''}`);
  if (attachedLabels > 0) items.push(`${attachedLabels} net label${attachedLabels > 1 ? 's' : ''}`);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content" style="max-width: 360px;">
      <div class="modal-header">
        <h2>Delete Component</h2>
        <button class="modal-close" id="del-confirm-close">✕</button>
      </div>
      <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.5;">
        This component has <strong style="color: var(--text-primary);">${items.join(' and ')}</strong> attached.
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${attachedWires > 0 ? `<label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-primary); cursor: pointer;">
          <input type="checkbox" id="del-wires-cb" checked /> Delete attached wires
        </label>` : ''}
        ${attachedLabels > 0 ? `<label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-primary); cursor: pointer;">
          <input type="checkbox" id="del-labels-cb" checked /> Delete attached net labels
        </label>` : ''}
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" id="del-cancel">Cancel</button>
        <button class="btn-primary" id="del-confirm" style="background: var(--danger); min-width: 80px;">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const confirmBtn = overlay.querySelector('#del-confirm') as HTMLButtonElement;
  confirmBtn.focus();

  const close = () => {
    overlay.remove();
  };

  overlay.querySelector('#del-confirm-close')!.addEventListener('click', close);
  overlay.querySelector('#del-cancel')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Keyboard shortcuts: Enter to confirm, Escape to cancel
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); window.removeEventListener('keydown', onKey); }
    if (e.key === 'Enter') { confirmBtn.click(); }
  };
  window.addEventListener('keydown', onKey);

  confirmBtn.addEventListener('click', () => {
    const deleteWires = attachedWires > 0
      ? (overlay.querySelector('#del-wires-cb') as HTMLInputElement)?.checked ?? true
      : false;
    const deleteLabels = attachedLabels > 0
      ? (overlay.querySelector('#del-labels-cb') as HTMLInputElement)?.checked ?? true
      : false;

    const sheetId = getActiveSheet().id;
    for (const id of componentIds) {
      commandStack.execute(new DeleteComponentCommand(sheetId, id, { deleteWires, deleteLabels }));
    }
    updatePropertiesPanel([]);
    window.removeEventListener('keydown', onKey);
    close();
  });
}

renderer.onDeleteRequested = (target) => {
  const sheetId = getActiveSheet().id;
  if (target.type === 'component') {
    // Check for attached wires/labels and confirm before cascade-deleting
    let totalWires = 0;
    let totalLabels = 0;
    for (const id of target.ids) {
      const counts = countAttachedItems(id);
      totalWires += counts.wires;
      totalLabels += counts.labels;
    }
    if (totalWires > 0 || totalLabels > 0) {
      showDeleteConfirmModal(target.ids, totalWires, totalLabels);
    } else {
      // No attachments — delete immediately
      for (const id of target.ids) {
        commandStack.execute(new DeleteComponentCommand(sheetId, id));
      }
      updatePropertiesPanel([]);
    }
  } else if (target.type === 'wire') {
    commandStack.execute(new DeleteWireCommand(sheetId, target.id));
    updatePropertiesPanel([]);
  } else if (target.type === 'label') {
    const sheet = getActiveSheet();
    const label = sheet.labels.find(l => l.id === target.id);
    if (label) {
      sheet.labels = sheet.labels.filter(l => l.id !== target.id);
      doc.updatedAt = new Date().toISOString();
    }
    updatePropertiesPanel([]);
  }
};

// ----- Toolbar -----
const toolBtns = document.querySelectorAll('.tool-btn[id^="tool-"]') as NodeListOf<HTMLButtonElement>;
const setActiveTool = (toolId: string) => {
  toolBtns.forEach(b => b.classList.remove('active'));
  document.getElementById(toolId)?.classList.add('active');
};

document.getElementById('tool-select')!.addEventListener('click', () => {
  renderer.setTool('select');
  setActiveTool('tool-select');
});
document.getElementById('tool-wire')!.addEventListener('click', () => {
  renderer.setTool('wire');
  setActiveTool('tool-wire');
});
document.getElementById('tool-pan')!.addEventListener('click', () => {
  renderer.setTool('pan');
  setActiveTool('tool-pan');
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

  if (e.key === 'v' || e.key === 'V') { renderer.setTool('select'); setActiveTool('tool-select'); }
  if (e.key === 'w' || e.key === 'W') { renderer.setTool('wire'); setActiveTool('tool-wire'); }
  if (e.key === 'h' || e.key === 'H') { renderer.setTool('pan'); setActiveTool('tool-pan'); }

  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    if (e.shiftKey) commandStack.redo();
    else commandStack.undo();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
    e.preventDefault();
    commandStack.redo();
  }


  // F5 — Simulate
  if (e.key === 'F5') {
    e.preventDefault();
    initSimulation();
    simPanel!.show();
    // Auto-run if already visible
    if (simPanel!.isVisible()) {
      simPanel!.onRunSimulation?.(simPanel!.getConfig());
    }
  }
});

// Undo/Redo buttons
const undoBtn = document.getElementById('btn-undo') as HTMLButtonElement;
const redoBtn = document.getElementById('btn-redo') as HTMLButtonElement;
undoBtn.addEventListener('click', () => commandStack.undo());
redoBtn.addEventListener('click', () => commandStack.redo());

// ----- Rotate / Delete Buttons -----
const rotateBtn = document.getElementById('btn-rotate') as HTMLButtonElement;
const deleteBtn = document.getElementById('btn-delete') as HTMLButtonElement;
const mRotateBtn = document.getElementById('m-btn-rotate') as HTMLButtonElement;
const mDeleteBtn = document.getElementById('m-btn-delete') as HTMLButtonElement;

function updateSelectionButtons(hasSelection: boolean) {
  rotateBtn.disabled = !hasSelection;
  deleteBtn.disabled = !hasSelection;
  mRotateBtn.disabled = !hasSelection;
  mDeleteBtn.disabled = !hasSelection;
}

function doRotateSelected() {
  const ids = renderer.getSelectedIds();
  for (const id of ids) {
    const comp = getActiveSheet().components.find(c => c.id === id);
    if (!comp) continue;
    const def = libraryMap.get(comp.libraryId);
    if (!def) continue;
    commandStack.execute(new RotateComponentCommand(getActiveSheet().id, id, def));
  }
}

function doDeleteSelected() {
  const ids = renderer.getSelectedIds();
  const wid = renderer.getSelectedWireId();
  const lid = renderer.getSelectedLabelId();

  if (ids.length > 0) {
    renderer.onDeleteRequested?.({ type: 'component', ids });
  }
  if (wid) {
    renderer.onDeleteRequested?.({ type: 'wire', id: wid });
  }
  if (lid) {
    renderer.onDeleteRequested?.({ type: 'label', id: lid });
  }
}

rotateBtn.addEventListener('click', doRotateSelected);
deleteBtn.addEventListener('click', doDeleteSelected);
mRotateBtn.addEventListener('click', doRotateSelected);
mDeleteBtn.addEventListener('click', doDeleteSelected);

// ----- Panel Toggle Buttons -----
const libraryPanel = document.getElementById('library-panel')!;
const propertiesPanel = document.getElementById('properties-panel')!;

document.getElementById('toggle-library')!.addEventListener('click', () => {
  libraryPanel.classList.toggle('collapsed');
});

document.getElementById('toggle-properties')!.addEventListener('click', () => {
  propertiesPanel.classList.toggle('collapsed');
});

// Mobile: toggle library from bottom toolbar
document.getElementById('m-toggle-library')!.addEventListener('click', () => {
  libraryPanel.classList.toggle('collapsed');
});

// ----- Mobile Bottom Toolbar -----
const mobileToolBtns = document.querySelectorAll('.mobile-tool-btn[id^="m-tool-"]') as NodeListOf<HTMLButtonElement>;
const setMobileActiveTool = (toolId: string) => {
  mobileToolBtns.forEach(b => b.classList.remove('active'));
  document.getElementById(toolId)?.classList.add('active');
};

document.getElementById('m-tool-select')!.addEventListener('click', () => {
  renderer.setTool('select');
  setActiveTool('tool-select');
  setMobileActiveTool('m-tool-select');
});
document.getElementById('m-tool-wire')!.addEventListener('click', () => {
  renderer.setTool('wire');
  setActiveTool('tool-wire');
  setMobileActiveTool('m-tool-wire');
});
document.getElementById('m-tool-pan')!.addEventListener('click', () => {
  renderer.setTool('pan');
  setActiveTool('tool-pan');
  setMobileActiveTool('m-tool-pan');
});

// Zoom buttons
const zoomInBtn = document.getElementById('btn-zoom-in')!;
const zoomOutBtn = document.getElementById('btn-zoom-out')!;
const zoomLabel = document.getElementById('zoom-label')!;

zoomInBtn.addEventListener('click', () => {
  if (currentView === 'pcb' && pcbRenderer) {
    pcbRenderer.zoomIn();
    zoomLabel.textContent = `${pcbRenderer.getZoomPercent()}%`;
  } else {
    renderer.zoomIn();
    zoomLabel.textContent = `${renderer.getZoomPercent()}%`;
  }
});
zoomOutBtn.addEventListener('click', () => {
  if (currentView === 'pcb' && pcbRenderer) {
    pcbRenderer.zoomOut();
    zoomLabel.textContent = `${pcbRenderer.getZoomPercent()}%`;
  } else {
    renderer.zoomOut();
    zoomLabel.textContent = `${renderer.getZoomPercent()}%`;
  }
});

// Update zoom label whenever the renderers zoom (covers wheel, trackpad pinch, Safari gestures)
renderer.onZoomChanged = (percent) => {
  if (currentView !== 'pcb') {
    zoomLabel.textContent = `${percent}%`;
  }
};

eventBus.on('document:changed', () => {
  undoBtn.disabled = !commandStack.canUndo;
  redoBtn.disabled = !commandStack.canRedo;
  // Keep PCB renderer in sync
  if (pcbRenderer) {
    pcbRenderer.setDocument(doc);
  }
  if (componentDrawer) {
    componentDrawer.update(doc, libraryMap);
  }
  // Auto-save via WebSocket
  wsService.saveDocument(doc);
  renderSheetTabs();
});

// ----- Properties Panel -----
function updatePropertiesPanel(ids: string[]) {
  const content = document.getElementById('prop-content')!;
  if (ids.length === 0) {
    content.innerHTML = '<p class="hint">Select a component to view its properties.</p>';
    return;
  }
  const comp = getActiveSheet().components.find(c => c.id === ids[0]);
  if (!comp) return;

  const def = libraryMap.get(comp.libraryId);
  // Component instance properties override definition properties
  const hasInstanceLcsc = comp.properties && 'lcsc' in comp.properties;
  const lcsc = hasInstanceLcsc ? (comp.properties!.lcsc || '') : (def?.properties?.lcsc || '');
  const isMapped = !!lcsc;
  const stock = def?.properties?.stock || comp.properties?.stock || '';
  const price = def?.properties?.price || comp.properties?.price || '';
  const basic = (def?.properties?.basic || comp.properties?.basic || '') === 'true';
  const mpn = def?.properties?.mpn || def?.mpn || comp.properties?.mpn || '';
  const manufacturer = def?.properties?.manufacturer || def?.manufacturer || '';
  const jlcDescription = comp.properties?.description || def?.properties?.description || '';
  const jlcCategory = comp.properties?.category || def?.properties?.category || '';
  const jlcPackage = comp.properties?.package || def?.properties?.package || '';
  const jlcName = comp.properties?.jlcpcbName || def?.properties?.jlcpcbName || '';

  let sourcingHTML = '';
  if (isMapped) {
    const stockNum = parseInt(stock, 10) || 0;
    const priceNum = parseFloat(price) || 0;
    const stockColor = stockNum > 100 ? '#10b981' : stockNum > 0 ? '#f59e0b' : '#e94560';
    sourcingHTML = `
      <div class="sourcing-section">
        <div class="sourcing-header">
          <span class="sourcing-dot sourcing-mapped"></span>
          JLCPCB Part
        </div>
        <div class="prop-row"><label>LCSC#</label><span class="prop-value sourcing-link">${lcsc}</span></div>
        ${mpn ? `<div class="prop-row"><label>MPN</label><span class="prop-value">${mpn}</span></div>` : ''}
        ${jlcName ? `<div class="prop-row"><label>Name</label><span class="prop-value">${jlcName}</span></div>` : ''}
        ${manufacturer ? `<div class="prop-row"><label>Manufacturer</label><span class="prop-value">${manufacturer}</span></div>` : ''}
        ${jlcPackage ? `<div class="prop-row"><label>Package</label><span class="prop-value">${jlcPackage}</span></div>` : ''}
        ${jlcDescription ? `<div class="prop-row"><label>Description</label><span class="prop-value" style="font-size: 11px;">${jlcDescription}</span></div>` : ''}
        ${jlcCategory ? `<div class="prop-row"><label>Category</label><span class="prop-value">${jlcCategory}</span></div>` : ''}
        <div class="prop-row"><label>Stock</label><span class="prop-value" style="color: ${stockColor}">${stockNum.toLocaleString()}</span></div>
        <div class="prop-row"><label>Unit Price</label><span class="prop-value">$${priceNum.toFixed(4)}</span></div>
        <div class="prop-row"><label>Assembly</label><span class="sourcing-badge ${basic ? 'sourcing-basic' : 'sourcing-extended'}">${basic ? 'Basic' : 'Extended'}</span></div>
        <div style="display: flex; gap: 6px; margin-top: 8px;">
          <button id="btn-map-part" class="btn-secondary" style="flex: 1;">Search JLCPCB...</button>
          <button id="btn-unmap-part" class="btn-secondary btn-danger" style="flex: 0 0 auto;">Unmap</button>
        </div>
      </div>
    `;
  } else {
    sourcingHTML = `
      <div class="sourcing-section">
        <div class="sourcing-header">
          <span class="sourcing-dot sourcing-unmapped"></span>
          Not mapped to JLCPCB
        </div>
        <p class="hint" style="padding: 4px 0;">Use AI or search to assign a real part.</p>
        <button id="btn-map-part" class="btn-secondary" style="margin-top: 8px; width: 100%;">Search JLCPCB...</button>
      </div>
    `;
  }

  // ----- Similar Components -----
  const similarComps = getActiveSheet().components.filter(c =>
    c.id !== comp.id &&
    c.libraryId === comp.libraryId &&
    c.value === comp.value &&
    c.properties?.lcsc
  );

  let similarHTML = '';
  if (similarComps.length > 0) {
    const items = similarComps.map(sc => {
      const scDef = libraryMap.get(sc.libraryId);
      const pkg = sc.properties?.package || scDef?.properties?.package || '';
      const scLcsc = sc.properties?.lcsc || '';
      const scMpn = sc.properties?.mpn || '';
      const scMfr = sc.properties?.manufacturer || '';
      const descParts = [scLcsc, scMpn, scMfr].filter(Boolean).join(' · ');
      return `
        <div class="similar-item" data-comp-id="${sc.id}">
          <div class="similar-top-row">
            <span class="similar-designator">${sc.designator}</span>
            ${pkg ? `<span class="similar-pkg">${pkg}</span>` : ''}
          </div>
          <div class="similar-desc">${descParts}</div>
        </div>`;
    }).join('');

    similarHTML = `
      <div class="similar-section">
        <div class="similar-header">Same Value in Project</div>
        ${items}
      </div>
    `;
  }

  content.innerHTML = `
    <div class="prop-row"><label>Designator</label><input type="text" value="${comp.designator}" data-field="designator" /></div>
    <div class="prop-row"><label>Value</label><input type="text" value="${comp.value}" data-field="value" /></div>
    <div class="prop-row"><label>Library ID</label><span class="prop-value">${comp.libraryId}</span></div>
    <div class="prop-row"><label>Position</label><span class="prop-value">(${comp.position.x}, ${comp.position.y})</span></div>
    <div class="prop-row"><label>Pins</label><span class="prop-value">${comp.pins.length}</span></div>
    ${sourcingHTML}
    ${similarHTML}
  `;

  document.getElementById('btn-map-part')?.addEventListener('click', () => {
    openMapModal(comp.id);
  });

  document.getElementById('btn-unmap-part')?.addEventListener('click', () => {
    comp.properties = comp.properties || {};
    comp.properties.lcsc = '';
    comp.properties.mpn = '';
    comp.properties.manufacturer = '';
    comp.properties.stock = '';
    comp.properties.price = '';
    comp.properties.basic = '';
    comp.properties.package = '';
    comp.properties.description = '';
    comp.properties.category = '';
    comp.properties.jlcpcbName = '';

    localStorage.setItem('sc_document', JSON.stringify(doc));
    renderer.setDocument(doc);
    updatePropertiesPanel([comp.id]);
  });

  // Bind designator and value editing
  const inputs = content.querySelectorAll('input[data-field]') as NodeListOf<HTMLInputElement>;
  inputs.forEach(input => {
    input.addEventListener('change', () => {
      const field = input.dataset.field as 'designator' | 'value';
      const newVal = input.value.trim();
      if (!field || !newVal) return;
      (comp as any)[field] = newVal;
      localStorage.setItem('sc_document', JSON.stringify(doc));
      renderer.setDocument(doc);
    });
  });

  // Bind similar component click handlers
  content.querySelectorAll('.similar-item').forEach(el => {
    el.addEventListener('click', () => {
      const sourceId = (el as HTMLElement).dataset.compId;
      const source = getActiveSheet().components.find(c => c.id === sourceId);
      if (!source || !source.properties?.lcsc) return;

      comp.properties = comp.properties || {};
      comp.properties.lcsc = source.properties.lcsc || '';
      comp.properties.mpn = source.properties.mpn || '';
      comp.properties.manufacturer = source.properties.manufacturer || '';
      comp.properties.stock = source.properties.stock || '0';
      comp.properties.price = source.properties.price || '0';
      comp.properties.basic = source.properties.basic || 'false';
      comp.properties.package = source.properties.package || '';
      comp.properties.description = source.properties.description || '';
      comp.properties.category = source.properties.category || '';
      comp.properties.jlcpcbName = source.properties.jlcpcbName || '';

      localStorage.setItem('sc_document', JSON.stringify(doc));
      renderer.setDocument(doc);
      updatePropertiesPanel([comp.id]);
    });
  });
}

// ----- Net Properties Panel -----
function updateNetPropertiesPanel(info: { type: 'label' | 'wire'; id: string; netName: string }) {
  const content = document.getElementById('prop-content')!;
  const sheet = getActiveSheet();

  // Find the net (check active sheet first, then all sheets)
  let net = sheet.nets.find(n => n.name === info.netName || n.id === info.netName);
  if (!net) {
    for (const s of doc.sheets) {
      net = s.nets.find(n => n.name === info.netName || n.id === info.netName);
      if (net) break;
    }
  }
  const connectionMode = net?.connectionMode || 'auto';

  // Find connected components — search ALL sheets for label-based connections
  const connectedPins: { designator: string; pinName: string; position: Point; sheetName?: string }[] = [];

  if (info.type === 'label') {
    const label = sheet.labels.find(l => l.id === info.id);
    if (!label) return;
    // Search all sheets for matching net labels and their connected pins
    for (const s of doc.sheets) {
      const matchingLabels = s.labels.filter(l => l.netName === info.netName);
      for (const ml of matchingLabels) {
        for (const comp of s.components) {
          for (const pin of comp.pins) {
            if (pin.absolutePosition.x === ml.position.x && pin.absolutePosition.y === ml.position.y) {
              const def = libraryMap.get(comp.libraryId);
              const pinDef = def?.symbol.pins.find(p => p.id === pin.definitionId);
              connectedPins.push({
                designator: comp.designator,
                pinName: pinDef?.name || pin.definitionId,
                position: { ...ml.position },
                sheetName: s !== sheet ? s.name : undefined,
              });
            }
          }
        }
      }
    }
  } else {
    // Wire — only look at the active sheet (wires don't cross sheets)
    const wire = sheet.wires.find(w => w.id === info.id);
    if (!wire) return;
    const firstSeg = wire.segments[0];
    const lastSeg = wire.segments[wire.segments.length - 1];
    const endpoints = [firstSeg.start, lastSeg.end];
    for (const ep of endpoints) {
      for (const comp of sheet.components) {
        for (const pin of comp.pins) {
          if (pin.absolutePosition.x === ep.x && pin.absolutePosition.y === ep.y) {
            const def = libraryMap.get(comp.libraryId);
            const pinDef = def?.symbol.pins.find(p => p.id === pin.definitionId);
            connectedPins.push({
              designator: comp.designator,
              pinName: pinDef?.name || pin.definitionId,
              position: { ...ep },
            });
          }
        }
      }
    }
  }

  const typeLabel = info.type === 'label' ? 'Net Label' : 'Wire';
  const connectionsHTML = connectedPins.length > 0
    ? connectedPins.map(cp => `
        <div class="prop-row">
          <label>${cp.designator}${cp.sheetName ? ` <span style="color: var(--text-dim); font-weight: 400;">(${cp.sheetName})</span>` : ''}</label>
          <span class="prop-value">Pin ${cp.pinName}</span>
        </div>`).join('')
    : '<p class="hint">No connected pins found.</p>';

  content.innerHTML = `
    <div style="margin-bottom: 8px; font-size: 10px; color: #8888aa; text-transform: uppercase; letter-spacing: 1px;">${typeLabel}</div>
    <div class="prop-row">
      <label>Net Name</label>
      <input type="text" value="${info.netName}" id="net-name-input" />
    </div>
    <div class="prop-row">
      <label>Mode</label>
      <select id="net-mode-select" style="background: #1a1a2e; color: #e2e2e2; border: 1px solid #333; border-radius: 4px; padding: 4px 6px; font-size: 12px;">
        <option value="auto" ${connectionMode === 'auto' ? 'selected' : ''}>Auto</option>
        <option value="wire" ${connectionMode === 'wire' ? 'selected' : ''}>Force Wire</option>
        <option value="label" ${connectionMode === 'label' ? 'selected' : ''}>Force Label</option>
      </select>
    </div>
    <div style="margin-top: 10px; margin-bottom: 4px; font-size: 10px; color: #8888aa; text-transform: uppercase; letter-spacing: 1px;">Connected To</div>
    ${connectionsHTML}
  `;

  // Bind net name editing
  const nameInput = document.getElementById('net-name-input') as HTMLInputElement;
  nameInput?.addEventListener('change', () => {
    const newName = nameInput.value.trim();
    if (!newName) return;
    // Update all matching labels across ALL sheets
    for (const s of doc.sheets) {
      for (const label of s.labels) {
        if (label.netName === info.netName) {
          label.netName = newName;
        }
      }
    }
    // Update net name
    if (net) {
      net.name = newName;
    }
    info.netName = newName;
    localStorage.setItem('sc_document', JSON.stringify(doc));
    renderer.setDocument(doc);
  });

  // Bind connection mode
  const modeSelect = document.getElementById('net-mode-select') as HTMLSelectElement;
  modeSelect?.addEventListener('change', () => {
    const mode = modeSelect.value as 'auto' | 'wire' | 'label';
    if (!net) {
      // Create a net if one doesn't exist yet
      net = { id: info.netName, name: info.netName, pinIds: [], wireIds: [], connectionMode: mode };
      sheet.nets.push(net);
    }
    net.connectionMode = mode;
    localStorage.setItem('sc_document', JSON.stringify(doc));
  });
}

// ----- Simulation Panel -----
let simPanel: SimulationPanel | null = null;
let simEngine: SimulationEngine | null = null;

function initSimulation() {
  if (simPanel) return;
  const container = document.getElementById('sim-drawer')!;
  simPanel = new SimulationPanel(container);
  simEngine = new SimulationEngine();

  simPanel.onRunSimulation = async (config) => {
    simPanel!.setLoading(true, 'Generating netlist…');
    const nlResult = generateNetlist(doc, config, libraryMap);
    console.log('[Simulation] Generated netlist:');
    console.log(nlResult.netlist);
    console.log('[Simulation] Warnings:', nlResult.warnings);
    console.log('[Simulation] Errors:', nlResult.errors);
    if (nlResult.errors.length > 0) {
      simPanel!.displayErrors(nlResult.errors, nlResult.warnings);
      simPanel!.setLoading(false);
      return;
    }
    if (nlResult.warnings.length > 0) {
      simPanel!.displayErrors([], nlResult.warnings);
    }

    simPanel!.setLoading(true, 'Initializing simulation engine…');
    if (!simEngine!.isReady()) await simEngine!.init();

    simPanel!.setLoading(true, 'Running simulation…');
    try {
      const result = await simEngine!.run(nlResult.netlist);
      simPanel!.setLoading(false);
      simPanel!.displayResults(result);
    } catch (err) {
      simPanel!.setLoading(false);
      simPanel!.displayErrors(
        [`Simulation failed: ${err instanceof Error ? err.message : String(err)}`],
        []
      );
    }
  };
}

// Toggle button
document.getElementById('btn-simulate')!.addEventListener('click', () => {
  initSimulation();
  simPanel!.toggle();
});

// ----- LLM Chat -----
const llmDrawer = document.getElementById('llm-drawer')!;
const llmMessages = document.getElementById('llm-messages')!;
const llmInput = document.getElementById('llm-input') as HTMLTextAreaElement;
const llmSend = document.getElementById('llm-send')!;

toolExecutor = new ToolExecutor({
  doc, commandStack, libraryMap,
  messagesContainer: llmMessages,
});

document.getElementById('btn-llm')!.addEventListener('click', () => {
  llmDrawer.style.display = llmDrawer.style.display === 'none' ? 'flex' : 'none';
});
document.getElementById('llm-close')!.addEventListener('click', () => {
  llmDrawer.style.display = 'none';
});

llmSend.addEventListener('click', sendLLMMessage);
llmInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendLLMMessage();
  }
});

const chatHistory: { role: string; content: string }[] = [];

async function sendLLMMessage() {
  const msg = llmInput.value.trim();
  if (!msg) return;

  chatHistory.push({ role: 'user', content: msg });
  appendChatMessage('user', msg);
  llmInput.value = '';

  // Derive actual connectivity from wire endpoints and net labels
  const sheet = getActiveSheet();
  const derivedNets: { name: string; pins: string[] }[] = [];
  const netGroupPins = new Map<string, Set<string>>(); // netId/netName → set of "DESIGNATOR.PIN" strings

  // 1. Walk all wires and find which component pins sit at each endpoint
  for (const wire of sheet.wires) {
    const firstSeg = wire.segments[0];
    const lastSeg = wire.segments[wire.segments.length - 1];
    if (!firstSeg || !lastSeg) continue;
    const endpoints = [firstSeg.start, lastSeg.end];

    for (const ep of endpoints) {
      for (const comp of sheet.components) {
        for (const pin of comp.pins) {
          if (pin.absolutePosition.x === ep.x && pin.absolutePosition.y === ep.y) {
            const def = libraryMap.get(comp.libraryId);
            const pinDef = def?.symbol.pins.find(p => p.id === pin.definitionId);
            const pinLabel = pinDef?.name || pin.definitionId;
            const key = wire.netId || wire.id;
            if (!netGroupPins.has(key)) netGroupPins.set(key, new Set());
            netGroupPins.get(key)!.add(`${comp.designator}.${pinLabel}`);
          }
        }
      }
    }
  }

  // 2. Include net-label-based connections (same netName = same net)
  const labelGroups = new Map<string, Set<string>>(); // netName → set of pin labels
  for (const label of sheet.labels) {
    for (const comp of sheet.components) {
      for (const pin of comp.pins) {
        if (pin.absolutePosition.x === label.position.x && pin.absolutePosition.y === label.position.y) {
          const def = libraryMap.get(comp.libraryId);
          const pinDef = def?.symbol.pins.find(p => p.id === pin.definitionId);
          const pinLabel = pinDef?.name || pin.definitionId;
          if (!labelGroups.has(label.netName)) labelGroups.set(label.netName, new Set());
          labelGroups.get(label.netName)!.add(`${comp.designator}.${pinLabel}`);
        }
      }
    }
  }

  // 3. Merge wire-based nets with their stored names
  for (const [key, pins] of netGroupPins) {
    if (pins.size < 2) continue;
    const net = sheet.nets.find(n => n.id === key);
    derivedNets.push({ name: net?.name || key, pins: [...pins] });
  }

  // 4. Add label-based nets (only those with 2+ connected pins)
  for (const [netName, pins] of labelGroups) {
    if (pins.size < 2) continue;
    derivedNets.push({ name: netName, pins: [...pins] });
  }

  const circuitContext = {
    components: sheet.components.map(c => {
      const def = libraryMap.get(c.libraryId);
      return {
        designator: c.designator,
        value: c.value,
        libraryId: c.libraryId,
        pins: def ? def.symbol.pins.map(p => p.name) : [],
      };
    }),
    nets: derivedNets,
    currentSheet: getActiveSheet().name,
    pcbLayout: doc.pcbLayout ? {
      board: doc.pcbLayout.board,
      placedComponents: doc.pcbLayout.components
        .filter(c => c.isPlaced)
        .map(c => {
          const schComp = doc.sheets.flatMap(s => s.components).find(sc => sc.id === c.schematicComponentId);
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

  const assistantDiv = appendChatMessage('assistant', '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>');
  const contentSpan = assistantDiv.querySelector('.msg-content')!;

  try {
    const response = await fetch(`${API_BASE}/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory, circuitContext })
    });

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let assistantText = '';
    let currentEvent = 'text';
    let startedResponding = false;
    const toolCallNames: string[] = [];
    let lineBuffer = ''; // Buffer for partial SSE lines across chunks

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Process any remaining buffered line
          if (lineBuffer.trim()) {
            processSSELine(lineBuffer);
            lineBuffer = '';
          }
          if (!startedResponding) contentSpan.innerHTML = '';
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        // Append to buffer and split into complete lines
        lineBuffer += chunk;
        const parts = lineBuffer.split('\n');
        // Last element may be incomplete (no trailing \n), keep it in buffer
        lineBuffer = parts.pop() || '';

        for (const line of parts) {
          processSSELine(line);
        }
      }
    }

    function processSSELine(line: string) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));

          if (currentEvent === 'text' && data.content) {
            startedResponding = true;
            assistantText += data.content;
            contentSpan.textContent = assistantText;
            llmMessages.scrollTop = llmMessages.scrollHeight;
          } else if (currentEvent === 'tool_call' && data.name) {
            if (!startedResponding) {
              startedResponding = true;
              contentSpan.innerHTML = '';
            }
            toolExecutor.handleToolCall(data.name, data.args || {});
            toolCallNames.push(data.name);
          } else if (currentEvent === 'error' && data.message) {
            startedResponding = true;
            console.error('[Gemini] API error:', data.message);
            contentSpan.innerHTML = `<span class="chat-error">⚠️ Gemini error: ${data.message}</span>`;
            llmMessages.scrollTop = llmMessages.scrollHeight;
          }
        } catch (e) {
          console.warn('[SSE] Failed to parse data line:', line.slice(0, 200), e);
        }
      }
    }

    // Include tool call summaries in chat history for multi-turn context
    let historyContent = assistantText;
    if (toolCallNames.length > 0) {
      const toolSummary = `[Called tools: ${toolCallNames.join(', ')}]`;
      historyContent = historyContent ? `${historyContent}\n${toolSummary}` : toolSummary;
    }
    chatHistory.push({ role: 'assistant', content: historyContent });
  } catch {
    contentSpan.textContent = '⚠️ Could not reach AI server. Make sure the server is running on port 3001.';
  }
}

function appendChatMessage(role: string, content: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = `chat-msg chat-${role}`;
  div.innerHTML = `
    <span class="msg-role">${role === 'user' ? 'You' : '🤖 AI'}</span>
    <span class="msg-content">${content}</span>
  `;
  llmMessages.appendChild(div);
  llmMessages.scrollTop = llmMessages.scrollHeight;
  return div;
}

// ----- JLCPCB Library Modal -----
const jlcpcbLibModal = document.getElementById('jlcpcb-lib-modal')!;
const jlcpcbLibSearch = document.getElementById('jlcpcb-lib-search') as HTMLInputElement;
const jlcpcbLibPackage = document.getElementById('jlcpcb-lib-package') as HTMLInputElement;
const jlcpcbLibResults = document.getElementById('jlcpcb-lib-results')!;
let jlcpcbLibTimeout: ReturnType<typeof setTimeout>;

document.getElementById('btn-jlcpcb-lib')!.addEventListener('click', () => {
  jlcpcbLibModal.style.display = 'flex';
  jlcpcbLibSearch.value = '';
  jlcpcbLibPackage.value = '';
  (document.getElementById('jlcpcb-lib-basic') as HTMLInputElement).checked = false;
  (document.getElementById('jlcpcb-lib-category') as HTMLSelectElement).innerHTML = '<option value="">All Categories</option>';
  jlcpcbLibResults.innerHTML = '<p class="hint">Type at least 2 characters to search.</p>';
  jlcpcbLibSearch.focus();
});

document.getElementById('jlcpcb-lib-close')!.addEventListener('click', () => {
  jlcpcbLibModal.style.display = 'none';
});

jlcpcbLibModal.addEventListener('click', (e) => {
  if (e.target === jlcpcbLibModal) jlcpcbLibModal.style.display = 'none';
});

document.getElementById('jlcpcb-lib-basic')?.addEventListener('change', () => {
  if (jlcpcbLibSearch.value.trim().length >= 2) jlcpcbLibSearch.dispatchEvent(new Event('input'));
});

jlcpcbLibPackage.addEventListener('input', () => {
  if (jlcpcbLibSearch.value.trim().length >= 2) jlcpcbLibSearch.dispatchEvent(new Event('input'));
});

document.getElementById('jlcpcb-lib-category')!.addEventListener('change', () => {
  const selected = (document.getElementById('jlcpcb-lib-category') as HTMLSelectElement).value;
  jlcpcbLibResults.querySelectorAll('.jlcpcb-lib-result').forEach(el => {
    const cat = (el as HTMLElement).dataset.category || '';
    (el as HTMLElement).style.display = (!selected || cat === selected) ? '' : 'none';
  });
});

function inferBuiltinSymbol(name: string, description: string): string {
  const text = `${name} ${description}`.toLowerCase();
  if (/\bresistor\b|\bres\b/.test(text)) return 'res_generic';
  if (/\bcapacitor\b|\bcap\b|\bmlcc\b/.test(text)) {
    if (/polar|electrolytic|tantalum/.test(text)) return 'cap_polarized';
    return 'cap_generic';
  }
  if (/\binductor\b|\bferrite\b|\bchoke\b/.test(text)) return 'ind_generic';
  if (/\bled\b|light.emit/.test(text)) return 'led_generic';
  if (/\bzener\b/.test(text)) return 'zener_generic';
  if (/\bdiode\b|\brectifier\b|\bschottky\b/.test(text)) return 'diode_generic';
  if (/\bmosfet\b|\bnmos\b|\bn-ch\b|\bn.channel\b/.test(text)) return 'nmos_generic';
  if (/\bnpn\b/.test(text)) return 'npn_generic';
  if (/\bpnp\b/.test(text)) return 'pnp_generic';
  if (/\bop.?amp\b|\bcomparator\b/.test(text)) return 'opamp_generic';
  if (/\bheader\b|\bconnector\b/.test(text)) return 'header_1x2';
  return 'ic_generic';
}

function buildFallbackDef(ds: DOMStringMap, builtinId: string): ComponentDefinition {
  const baseDef = builtinLibrary.find(d => d.id === builtinId) || builtinLibrary[0];
  return {
    ...baseDef,
    id: `jlcpcb_${ds.lcsc}`,
    name: ds.name || ds.lcsc || baseDef.name,
    description: ds.desc || '',
    manufacturer: ds.mfr || '',
    mpn: ds.mpn || '',
    lcscPartNumber: ds.lcsc || '',
    defaultValue: ds.name || baseDef.defaultValue,
    properties: {
      ...baseDef.properties,
      lcsc: ds.lcsc || '',
      mpn: ds.mpn || '',
      manufacturer: ds.mfr || '',
      stock: ds.stock || '0',
      price: ds.price || '0',
      basic: ds.basic || 'false',
      package: ds.package || '',
      description: ds.desc || '',
      category: ds.category || '',
      jlcpcbName: ds.name || '',
    },
  };
}

jlcpcbLibSearch.addEventListener('input', () => {
  clearTimeout(jlcpcbLibTimeout);
  jlcpcbLibTimeout = setTimeout(async () => {
    const q = jlcpcbLibSearch.value.trim();
    if (q.length < 2) {
      jlcpcbLibResults.innerHTML = '<p class="hint">Type at least 2 characters to search.</p>';
      return;
    }

    jlcpcbLibResults.innerHTML = '<p class="hint">Searching JLCPCB…</p>';

    const pkg = jlcpcbLibPackage.value.trim();
    const pkgParam = pkg ? `&package=${encodeURIComponent(pkg)}` : '';
    const isBasicOnly = (document.getElementById('jlcpcb-lib-basic') as HTMLInputElement).checked;
    const basicParam = isBasicOnly ? '&basic=true' : '';

    try {
      const res = await fetch(`${API_BASE}/components/search?q=${encodeURIComponent(q)}&limit=30${basicParam}${pkgParam}`);
      const data = await res.json();
      const results = data.results || [];

      if (results.length > 0) {
        // Populate category filter
        const libCategorySelect = document.getElementById('jlcpcb-lib-category') as HTMLSelectElement;
        const categories = [...new Set(results.map((c: any) => c.category || '').filter(Boolean))] as string[];
        libCategorySelect.innerHTML = '<option value="">All Categories</option>' + categories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
        libCategorySelect.value = '';

        jlcpcbLibResults.innerHTML = results.map((c: any) => `
          <div class="jlcpcb-item jlcpcb-lib-result" data-lcsc="${c.lcscPartNumber}" data-name="${(c.name || '').replace(/"/g, '&quot;')}" data-desc="${(c.description || '').replace(/"/g, '&quot;')}" data-mpn="${c.mpn || ''}" data-mfr="${c.manufacturer || ''}" data-stock="${c.stock}" data-price="${c.price ?? ''}" data-basic="${c.basic ? 'true' : 'false'}" data-package="${c.package || ''}" data-category="${(c.category || '').replace(/"/g, '&quot;')}">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
              <div class="jlcpcb-name">${c.name || c.lcscPartNumber}</div>
              <div style="display: flex; gap: 4px; align-items: center;">
                ${c.category ? `<div class="category-badge">${c.category}</div>` : ''}
                ${c.package ? `<div class="jlcpcb-badge package-badge">${c.package}</div>` : ''}
                ${c.basic ? '<div class="jlcpcb-badge sourcing-basic" style="font-size:9px;padding:1px 5px;">Basic</div>' : ''}
              </div>
            </div>
            ${c.description ? `<div class="jlcpcb-desc">${c.description}</div>` : ''}
            <div class="jlcpcb-meta" style="margin-top: 4px;">LCSC: ${c.lcscPartNumber} · Stock: ${c.stock > 0 ? c.stock.toLocaleString() : '0'}${c.price != null ? ` · $${Number(c.price).toFixed(4)}` : ''}</div>
            ${c.mpn && c.mpn !== c.name ? `<div class="jlcpcb-meta">${c.mpn} (${c.manufacturer || ''})</div>` : ''}
            <div class="jlcpcb-add-hint">Click to add to schematic</div>
          </div>
        `).join('');

        // Bind click handlers
        jlcpcbLibResults.querySelectorAll('.jlcpcb-lib-result').forEach(el => {
          el.addEventListener('click', async () => {
            const ds = (el as HTMLElement).dataset;
            const builtinId = inferBuiltinSymbol(ds.name || '', ds.desc || '');

            // For simple 2-pin passives, use the built-in symbol directly (fast path)
            const simplePassives = ['res_generic', 'cap_generic', 'cap_polarized', 'ind_generic', 'diode_generic', 'zener_generic', 'led_generic'];
            const isSimplePassive = simplePassives.includes(builtinId);

            let newDef: ComponentDefinition;

            if (!isSimplePassive && ds.lcsc) {
              // For ICs and complex components, resolve real pin data from EasyEDA
              // Show a loading indicator on the clicked item
              (el as HTMLElement).innerHTML = '<p class="hint" style="padding:8px 0;">Resolving component pins…</p>';

              try {
                const mpnParam = ds.mpn ? `&mpn=${encodeURIComponent(ds.mpn)}` : '';
                const resolveRes = await fetch(`${API_BASE}/components/resolve?lcsc=${encodeURIComponent(ds.lcsc)}${mpnParam}`);
                if (resolveRes.ok) {
                  const resolved: ResolvedComponentResponse = await resolveRes.json();
                  if (resolved.pins?.length > 0) {
                    newDef = resolvedToComponentDef(resolved, ds.name || ds.mpn || resolved.mpn);
                    // Merge in pricing/sourcing data from our search results (may be more up-to-date)
                    newDef.properties = {
                      ...newDef.properties,
                      lcsc: ds.lcsc || resolved.lcsc || '',
                      mpn: ds.mpn || resolved.mpn || '',
                      manufacturer: ds.mfr || resolved.manufacturer || '',
                      stock: ds.stock || String(resolved.stock || 0),
                      price: ds.price || String(resolved.price || 0),
                      basic: ds.basic || String(resolved.basic || false),
                      package: ds.package || resolved.packageName || '',
                      description: ds.desc || '',
                      category: ds.category || '',
                      jlcpcbName: ds.name || '',
                    };
                    newDef.id = `jlcpcb_${ds.lcsc}`;
                    newDef.lcscPartNumber = ds.lcsc;

                    // Register the EasyEDA footprint (with packageUuid) so it's available at export time
                    if (resolved.footprint) {
                      const fpDef = resolvedFootprintToDefinition(
                        resolved.footprint,
                        ds.lcsc || resolved.lcsc,
                        resolved.pins
                      );
                      footprintLibrary.register(ds.lcsc || resolved.lcsc, fpDef);
                    }
                  } else {
                    // Resolution returned 0 pins — fall back to built-in
                    newDef = buildFallbackDef(ds, builtinId);
                  }
                } else {
                  // Resolution failed — fall back to built-in
                  newDef = buildFallbackDef(ds, builtinId);
                }
              } catch {
                // Network error — fall back to built-in
                newDef = buildFallbackDef(ds, builtinId);
              }
            } else {
              // Simple passive — use built-in symbol directly
              newDef = buildFallbackDef(ds, builtinId);
            }

            // Register in library map so renderer can find it
            libraryMap.set(newDef.id, newDef);
            renderer.setLibraryMap(libraryMap);

            // Persist to server-side component library
            saveComponentsToLibrary([newDef]);

            // Close modal and enter placement mode
            jlcpcbLibModal.style.display = 'none';
            renderer.startPlacingComponent(newDef);
          });
        });
      } else {
        jlcpcbLibResults.innerHTML = '<p class="hint">No results found.</p>';
      }
    } catch {
      jlcpcbLibResults.innerHTML = '<p class="hint">Search failed. Is the server running?</p>';
    }
  }, 400);
});

// ----- File Menu Toggle -----
const menuDropdown = document.getElementById('menu-dropdown')!;
document.getElementById('btn-menu')!.addEventListener('click', (e) => {
  e.stopPropagation();
  menuDropdown.classList.toggle('open');
});

// Close menu when clicking outside
document.addEventListener('click', (e) => {
  const wrapper = document.getElementById('menu-wrapper')!;
  if (!wrapper.contains(e.target as Node)) {
    menuDropdown.classList.remove('open');
  }
});

// ----- Import -----
document.getElementById('menu-import')!.addEventListener('click', () => {
  menuDropdown.classList.remove('open');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json, .eprj';
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.name.endsWith('.eprj')) {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const { doc: newDoc, library: newLib, footprintMap: newFpMap } = await importFromEasyEDAPro(reader.result as ArrayBuffer);
          applyImportedDoc(newDoc, newLib, newFpMap);
        } catch (err) {
          console.error('Failed to import Pro file:', err);
          alert('Failed to parse EasyEDA Pro .eprj file.');
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result as string);

          let newDoc: CircuitDocument;
          let newLib: Map<string, ComponentDefinition>;

          if (Array.isArray(parsed)) {
            // Multi-doc array — filter all schematic pages (docType '1')
            const schematicDocs = parsed.filter((d: EasyEDADocument) => d.docType === '1');
            if (schematicDocs.length > 1) {
              ({ doc: newDoc, library: newLib } = importMultipleFromEasyEDA(schematicDocs));
            } else {
              const singleDoc = schematicDocs[0] || parsed[0];
              ({ doc: newDoc, library: newLib } = importFromEasyEDA(singleDoc));
            }
          } else if (parsed.docType === '5' && Array.isArray(parsed.schematics)) {
            // SCHEMATIC_LIST wrapper (docType 5) — extract embedded schematics
            ({ doc: newDoc, library: newLib } = importMultipleFromEasyEDA(parsed.schematics));
          } else {
            // Single schematic document
            ({ doc: newDoc, library: newLib } = importFromEasyEDA(parsed));
          }

          applyImportedDoc(newDoc, newLib);
        } catch (err) {
          console.error('Failed to import standard file:', err);
          alert('Failed to parse EasyEDA JSON file.');
        }
      };
      reader.readAsText(file);
    }

    function applyImportedDoc(newDoc: CircuitDocument, newLib: Map<string, ComponentDefinition>, importedFpMap?: Map<string, FootprintDefinition>) {
      doc.sheets = newDoc.sheets;
      doc.name = newDoc.name;
      doc.metadata = newDoc.metadata;
      
      const defs: ComponentDefinition[] = [];
      for (const [id, def] of newLib.entries()) {
        libraryMap.set(id, def);
        defs.push(def);
      }
      
      // Persist to server-side component library
      saveComponentsToLibrary(defs);
      
      commandStack.setDocument(doc);
      renderer.setDocument(doc);
      renderer.centerView();
      activeSheetIndex = 0;
      renderer.setActiveSheetIndex(0);
      
      // Refresh properties panel
      updatePropertiesPanel([]);
      renderSheetTabs();

      // Register imported footprints for PCB rendering
      if (importedFpMap) {
        for (const [uuid, fpDef] of importedFpMap.entries()) {
          footprintLibrary.register(uuid, fpDef);
        }
      }

      // If the imported doc has a PCB layout, reset PCB view so it re-initializes
      if (newDoc.pcbLayout) {
        pcbRenderer = null;
        componentDrawer = null;
        document.getElementById('pcb-container')!.innerHTML = '';
      }
    }
  };
  input.click();
});

// ----- Export -----
document.getElementById('menu-export')!.addEventListener('click', () => {
  menuDropdown.classList.remove('open');

  // Build footprint map for export (keyed by LCSC or library ID)
  const exportFpMap = new Map<string, any>();
  for (const sheet of doc.sheets) {
    for (const comp of sheet.components) {
      const def = libraryMap.get(comp.libraryId);
      if (!def) continue;
      const lcsc = comp.properties?.lcsc || def.properties?.lcsc || '';
      const key = lcsc || comp.libraryId;
      if (exportFpMap.has(key)) continue;
      const fp = footprintLibrary.getFootprint(
        { definitionId: comp.libraryId, properties: comp.properties },
        def
      );
      exportFpMap.set(key, fp);
    }
  }

  const easyEdaDoc = serializeToEasyEDA(doc, libraryMap, exportFpMap);
  const blob = new Blob([JSON.stringify(easyEdaDoc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${doc.name}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ----- Export KiCad -----
document.getElementById('menu-export-kicad')!.addEventListener('click', () => {
  menuDropdown.classList.remove('open');
  const kicadSch = serializeToKiCad(doc, libraryMap);
  const blob = new Blob([kicadSch], { type: 'application/x-kicad-schematic' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${doc.name}.kicad_sch`;
  a.click();
  URL.revokeObjectURL(url);
});

// ----- Export EasyEDA (Include PCB) -----
document.getElementById('menu-export-easyeda-pcb')!.addEventListener('click', () => {
  menuDropdown.classList.remove('open');

  // Build footprint map (same as schematic export)
  const exportFpMap = new Map<string, any>();
  for (const sheet of doc.sheets) {
    for (const comp of sheet.components) {
      const def = libraryMap.get(comp.libraryId);
      if (!def) continue;
      const lcsc = comp.properties?.lcsc || def.properties?.lcsc || '';
      const key = lcsc || comp.libraryId;
      if (exportFpMap.has(key)) continue;
      const fp = footprintLibrary.getFootprint(
        { definitionId: comp.libraryId, properties: comp.properties },
        def
      );
      exportFpMap.set(key, fp);
    }
  }

  // Export schematic document
  const schematicDoc = serializeToEasyEDA(doc, libraryMap, exportFpMap);

  // Build multi-doc array: schematic + PCB (if available)
  const documents: any[] = [schematicDoc];

  if (doc.pcbLayout && doc.pcbLayout.components.length > 0) {
    try {
      const pcbDoc = serializeToEasyEDAPCB(doc, libraryMap, exportFpMap);
      documents.push(pcbDoc);
    } catch (err) {
      console.warn('Failed to serialize PCB layout:', err);
    }
  }

  const blob = new Blob([JSON.stringify(documents, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${doc.name}_with_pcb.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ----- Toast Notification -----
const appToast = document.getElementById('app-toast')!;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(message: string, type: 'success' | 'error' = 'success', durationMs = 3000) {
  if (toastTimer) clearTimeout(toastTimer);
  appToast.textContent = message;
  appToast.className = `app-toast ${type} visible`;
  toastTimer = setTimeout(() => {
    appToast.classList.remove('visible');
    toastTimer = null;
  }, durationMs);
}

// ----- Project Name in Header -----
function updateProjectName() {
  const el = document.getElementById('project-name');
  if (el) {
    el.textContent = doc.name || 'Untitled';
    el.title = doc.name || 'Untitled';
  }
}

// ----- New Project -----
function resetToNewProject() {
  doc = createDocument('Untitled');
  commandStack = new CommandStack(doc);
  toolExecutor.setDocument(doc, commandStack);
  renderer.setDocument(doc);
  renderer.centerView();
  activeSheetIndex = 0;
  renderer.setActiveSheetIndex(0);
  updatePropertiesPanel([]);
  updateProjectName();
  renderSheetTabs();
  // Reset PCB state
  if (pcbRenderer) {
    pcbRenderer = null;
    componentDrawer = null;
  }
  const pcbContainer = document.getElementById('pcb-container')!;
  pcbContainer.innerHTML = '';
  switchView('schematic');
}

document.getElementById('menu-new')!.addEventListener('click', () => {
  menuDropdown.classList.remove('open');
  // Confirm if there are unsaved changes
  if (doc.sheets.some(s => s.components.length > 0 || s.wires.length > 0)) {
    if (!confirm('Create a new project? Any unsaved changes will be lost.')) return;
  }
  resetToNewProject();
  showToast('New project created');
});

// ----- Save / Load Projects -----
const saveModal = document.getElementById('save-modal')!;
const saveNameInput = document.getElementById('save-name-input') as HTMLInputElement;

async function doSaveProject() {
  try {
    const savedDoc = await saveProject(doc);
    doc = savedDoc;
    commandStack.setDocument(doc);
    toolExecutor.setDocument(doc);
    updateProjectName();
    showToast(`"${doc.name}" saved successfully`, 'success');
  } catch (err) {
    console.error('Failed to save project:', err);
    showToast('Failed to save project. Is the server running?', 'error', 5000);
  }
}

document.getElementById('menu-save')!.addEventListener('click', async () => {
  menuDropdown.classList.remove('open');
  if (doc.name === 'New Circuit' || doc.name === 'Untitled') {
    saveNameInput.value = '';
    saveModal.style.display = 'flex';
    saveNameInput.focus();
  } else {
    await doSaveProject();
  }
});

document.getElementById('save-close')!.addEventListener('click', () => {
  saveModal.style.display = 'none';
});

document.getElementById('save-cancel')!.addEventListener('click', () => {
  saveModal.style.display = 'none';
});

document.getElementById('save-confirm')!.addEventListener('click', async () => {
  const name = saveNameInput.value.trim();
  if (!name) return;
  doc.name = name;
  saveModal.style.display = 'none';
  await doSaveProject();
});

saveNameInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const name = saveNameInput.value.trim();
    if (!name) return;
    doc.name = name;
    saveModal.style.display = 'none';
    await doSaveProject();
  } else if (e.key === 'Escape') {
    saveModal.style.display = 'none';
  }
});

// ----- Open Project -----
const loadModal = document.getElementById('load-modal')!;
const projectSearchInput = document.getElementById('project-search-input') as HTMLInputElement;
let allProjects: Awaited<ReturnType<typeof listProjects>> = [];

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function renderProjectList(projects: typeof allProjects) {
  const listContainer = document.getElementById('load-list')!;
  if (projects.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-projects">
        <svg width="48" height="48" viewBox="0 0 16 16" fill="none" stroke="var(--text-dim)" stroke-width="0.8" style="margin-bottom: 8px;">
          <path d="M2 5a1 1 0 011-1h4l2 2h4a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1V5z"/>
        </svg>
        <div class="empty-projects-title">No projects found</div>
        <div class="empty-projects-sub">Save a project to see it here</div>
      </div>
    `;
    return;
  }

  listContainer.innerHTML = projects.map(p => `
    <div class="project-card" data-id="${p.id}">
      <div class="project-card-icon">
        <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" stroke-width="1.2">
          <path d="M3 2h6l4 4v7a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/>
          <path d="M9 2v4h4" opacity="0.5"/>
        </svg>
      </div>
      <div class="project-card-body">
        <div class="project-card-name">${p.name}</div>
        <div class="project-card-meta">
          <span class="project-card-date">${timeAgo(p.updatedAt)}</span>
          <span class="project-card-dot">·</span>
          <span class="project-card-count">${p.componentCount || 0} component${(p.componentCount || 0) !== 1 ? 's' : ''}</span>
        </div>
      </div>
      <button class="project-card-delete" data-id="${p.id}" data-name="${p.name.replace(/"/g, '&quot;')}" title="Delete project">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 4h10M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M6 7v5M10 7v5M4 4l1 9a1 1 0 001 1h4a1 1 0 001-1l1-9"/>
        </svg>
      </button>
    </div>
  `).join('');

  // Wire up click-to-open
  listContainer.querySelectorAll('.project-card').forEach(card => {
    card.addEventListener('click', async (e) => {
      // Don't load if they clicked the delete button
      if ((e.target as HTMLElement).closest('.project-card-delete')) return;
      const id = (card as HTMLElement).dataset.id;
      if (!id) return;
      // Show loading state on the card
      card.classList.add('loading');
      try {
        const loadedDoc = await getProject(id);
        doc = loadedDoc;
        // Restore imported library definitions from server
        await restoreCustomLibrary(doc);
        commandStack = new CommandStack(doc);
        toolExecutor.setDocument(doc, commandStack);
        renderer.setDocument(doc);
        renderer.centerView();
        activeSheetIndex = 0;
        renderer.setActiveSheetIndex(0);
        updatePropertiesPanel([]);
        updateProjectName();
        renderSheetTabs();
        // Reset PCB so it re-initializes on next switch
        pcbRenderer = null;
        componentDrawer = null;
        document.getElementById('pcb-container')!.innerHTML = '';
        switchView('schematic');
        loadModal.style.display = 'none';
        showToast(`Opened "${doc.name}"`);
      } catch (err) {
        console.error('Failed to load project:', err);
        card.classList.remove('loading');
        showToast('Failed to open project', 'error');
      }
    });
  });

  // Wire up delete buttons
  listContainer.querySelectorAll('.project-card-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.id;
      const name = (btn as HTMLElement).dataset.name;
      if (!id) return;
      if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
      try {
        await deleteProject(id);
        allProjects = allProjects.filter(p => p.id !== id);
        renderProjectList(filterProjects(projectSearchInput.value));
        showToast(`"${name}" deleted`);
      } catch (err) {
        console.error('Failed to delete project:', err);
        showToast('Failed to delete project', 'error');
      }
    });
  });
}

function filterProjects(query: string) {
  const q = query.toLowerCase().trim();
  if (!q) return allProjects;
  return allProjects.filter(p => p.name.toLowerCase().includes(q));
}

projectSearchInput.addEventListener('input', () => {
  renderProjectList(filterProjects(projectSearchInput.value));
});

document.getElementById('menu-load')!.addEventListener('click', async () => {
  menuDropdown.classList.remove('open');
  loadModal.style.display = 'flex';
  projectSearchInput.value = '';
  const listContainer = document.getElementById('load-list')!;
  listContainer.innerHTML = `
    <div class="empty-projects">
      <div class="loading-spinner"></div>
      <div style="margin-top: 12px;">Loading projects…</div>
    </div>
  `;

  try {
    allProjects = await listProjects();
    renderProjectList(allProjects);
    projectSearchInput.focus();
  } catch (err) {
    console.error('Failed to list projects:', err);
    listContainer.innerHTML = `
      <div class="empty-projects">
        <div class="empty-projects-title">Connection Error</div>
        <div class="empty-projects-sub">Could not reach the server. Is it running?</div>
      </div>
    `;
  }
});

document.getElementById('load-close')!.addEventListener('click', () => {
  loadModal.style.display = 'none';
});

// ----- Bill of Materials -----
const bomModal = document.getElementById('bom-modal')!;
const bomBody = document.getElementById('bom-body')!;

document.getElementById('menu-bom')!.addEventListener('click', () => {
  menuDropdown.classList.remove('open');
  bomModal.style.display = 'flex';

  const sheet = getActiveSheet();
  const groups = new Map<string, {
    name: string; value: string; lcsc: string; package: string;
    stock: number; price: number; basic: boolean; designators: string[];
  }>();

  for (const comp of sheet.components) {
    const def = libraryMap.get(comp.libraryId);
    const lcsc = comp.properties?.lcsc || def?.properties?.lcsc || '';
    const key = lcsc || `${comp.libraryId}::${comp.value}`;

    if (!groups.has(key)) {
      const stock = parseInt(comp.properties?.stock || def?.properties?.stock || '0', 10) || 0;
      const price = parseFloat(comp.properties?.price || def?.properties?.price || '0') || 0;
      const basic = (comp.properties?.basic || def?.properties?.basic || '') === 'true';
      const pkg = comp.properties?.package || def?.properties?.package || '';
      const name = def?.name || comp.libraryId;
      groups.set(key, { name, value: comp.value, lcsc, package: pkg, stock, price, basic, designators: [] });
    }
    groups.get(key)!.designators.push(comp.designator);
  }

  if (groups.size === 0) {
    bomBody.innerHTML = '<p class="hint">No components in the schematic.</p>';
    return;
  }

  const sorted = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  let totalCost = 0;
  let totalQty = 0;

  const rows = sorted.map(g => {
    const qty = g.designators.length;
    const lineTotal = g.price * qty;
    totalCost += lineTotal;
    totalQty += qty;

    const stockColor = g.stock > 100 ? '#10b981' : g.stock > 0 ? '#f59e0b' : '#e94560';
    const badgeClass = g.basic ? 'sourcing-basic' : 'sourcing-extended';
    const badgeLabel = g.basic ? 'Basic' : 'Extended';
    const mappedDot = g.lcsc
      ? `<span class="sourcing-dot sourcing-mapped" style="display:inline-block;width:6px;height:6px;margin-right:4px;"></span>`
      : `<span class="sourcing-dot sourcing-unmapped" style="display:inline-block;width:6px;height:6px;margin-right:4px;"></span>`;

    return `<tr>
      <td style="max-width:160px;">${mappedDot}${g.name}</td>
      <td>${g.value}</td>
      <td>${g.package || '\u2014'}</td>
      <td class="bom-designators">${g.designators.join(', ')}</td>
      <td class="bom-num">${qty}</td>
      <td style="color:${stockColor}" class="bom-num">${g.stock > 0 ? g.stock.toLocaleString() : '\u2014'}</td>
      <td class="bom-num">$${g.price.toFixed(4)}</td>
      <td class="bom-num">$${lineTotal.toFixed(4)}</td>
      <td>${g.lcsc ? `<span class="sourcing-badge ${badgeClass}">${badgeLabel}</span>` : '<span style="color:var(--text-dim)">\u2014</span>'}</td>
    </tr>`;
  }).join('');

  bomBody.innerHTML = `
    <div class="bom-table-wrapper">
      <table class="bom-table">
        <thead>
          <tr>
            <th>Part</th><th>Value</th><th>Package</th><th>Designators</th>
            <th>Qty</th><th>Stock</th><th>Unit $</th><th>Total $</th><th>Type</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="bom-summary">
      <span>${sorted.length} unique part${sorted.length !== 1 ? 's' : ''}</span>
      <span>${totalQty} total component${totalQty !== 1 ? 's' : ''}</span>
      <span class="bom-total-cost">Total: $${totalCost.toFixed(4)}</span>
    </div>
  `;
});

document.getElementById('bom-close')!.addEventListener('click', () => {
  bomModal.style.display = 'none';
});

// ----- Map JLCPCB Modal -----
const mapModal = document.getElementById('map-modal')!;
const mapSearchInput = document.getElementById('map-search-input') as HTMLInputElement;
const mapPackageInput = document.getElementById('map-package-input') as HTMLInputElement;
const mapResultsContainer = document.getElementById('map-results')!;
let mapTargetComponentId: string | null = null;
let mapSearchTimeout: ReturnType<typeof setTimeout>;

function openMapModal(componentId: string) {
  mapTargetComponentId = componentId;
  mapModal.style.display = 'flex';

  const comp = getActiveSheet().components.find(c => c.id === componentId);
  let initialSearch = '';
  if (comp) {
    const def = libraryMap.get(comp.libraryId);
    let namePart = def ? def.name : '';
    let valPart = comp.value;
    
    // Attempt to formulate a good search string from value/name
    if (valPart && valPart !== comp.designator && valPart !== 'undefined') {
      if (namePart && !namePart.toLowerCase().includes('generic') && !valPart.toLowerCase().includes(namePart.toLowerCase())) {
         initialSearch = namePart + ' ' + valPart;
      } else {
         initialSearch = valPart;
      }
    } else if (namePart) {
      initialSearch = namePart;
    }
  }

  mapSearchInput.value = initialSearch;
  mapPackageInput.value = '';
  mapResultsContainer.innerHTML = '';
  (document.getElementById('map-basic-filter') as HTMLInputElement).checked = false;
  (document.getElementById('map-category-filter') as HTMLSelectElement).innerHTML = '<option value="">All Categories</option>';
  mapSearchInput.focus();

  if (initialSearch) {
    mapSearchInput.dispatchEvent(new Event('input'));
  }
}

document.getElementById('map-basic-filter')?.addEventListener('change', () => {
  if (mapSearchInput.value.trim().length >= 2) {
    mapSearchInput.dispatchEvent(new Event('input'));
  }
});

mapPackageInput.addEventListener('input', () => {
  if (mapSearchInput.value.trim().length >= 2) {
    mapSearchInput.dispatchEvent(new Event('input'));
  }
});

document.getElementById('map-category-filter')!.addEventListener('change', () => {
  const selected = (document.getElementById('map-category-filter') as HTMLSelectElement).value;
  mapResultsContainer.querySelectorAll('.map-result-item').forEach(el => {
    const cat = (el as HTMLElement).dataset.category || '';
    (el as HTMLElement).style.display = (!selected || cat === selected) ? '' : 'none';
  });
});

document.getElementById('map-close')!.addEventListener('click', () => {
  mapModal.style.display = 'none';
  mapTargetComponentId = null;
});

mapSearchInput.addEventListener('input', () => {
  clearTimeout(mapSearchTimeout);
  mapSearchTimeout = setTimeout(async () => {
    const q = mapSearchInput.value.trim();
    if (q.length < 2) {
      mapResultsContainer.innerHTML = '';
      return;
    }

    mapResultsContainer.innerHTML = '<p class="hint">Searching JLCPCB...</p>';
    
    const pkg = mapPackageInput.value.trim();
    const pkgParam = pkg ? `&package=${encodeURIComponent(pkg)}` : '';
    
    try {
      const isBasicOnly = (document.getElementById('map-basic-filter') as HTMLInputElement).checked;
      const basicParam = isBasicOnly ? '&basic=true' : '';
      const res = await fetch(`${API_BASE}/components/search?q=${encodeURIComponent(q)}&limit=40${basicParam}${pkgParam}`);
      const data = await res.json();
      
      let results = data.results || [];
      
      if (results.length > 0) {
        // Populate category filter
        const mapCategorySelect = document.getElementById('map-category-filter') as HTMLSelectElement;
        const mapCategories = [...new Set(results.map((c: any) => c.category || '').filter(Boolean))] as string[];
        mapCategorySelect.innerHTML = '<option value="">All Categories</option>' + mapCategories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
        mapCategorySelect.value = '';

        mapResultsContainer.innerHTML = results.map((c: any) => `
          <div class="jlcpcb-item map-result-item" data-lcsc="${c.lcscPartNumber}" data-mpn="${c.mpn || ''}" data-mfr="${c.manufacturer || ''}" data-stock="${c.stock}" data-price="${c.price}" data-basic="${c.basic ? 'true' : 'false'}" data-package="${c.package || ''}" data-category="${(c.category || '').replace(/"/g, '&quot;')}" data-desc="${(c.description || '').replace(/"/g, '&quot;')}" data-name="${(c.name || '').replace(/"/g, '&quot;')}">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
              <div class="jlcpcb-name">${c.name || c.lcscPartNumber}</div>
              <div style="display: flex; gap: 4px; align-items: center;">
                ${c.category ? `<div class="category-badge">${c.category}</div>` : ''}
                ${c.package ? `<div class="jlcpcb-badge package-badge">${c.package}</div>` : ''}
              </div>
            </div>
            ${c.description ? `<div class="jlcpcb-desc">${c.description}</div>` : ''}
            <div class="jlcpcb-meta" style="margin-top: 4px;">LCSC: ${c.lcscPartNumber} · Stock: ${c.stock > 0 ? c.stock.toLocaleString() : '0'}${c.price ? ` · $${Number(c.price).toFixed(4)}` : ''}</div>
            ${c.mpn && c.mpn !== c.name ? `<div class="jlcpcb-meta">${c.mpn} (${c.manufacturer || ''})</div>` : ''}
          </div>
        `).join('');

        mapResultsContainer.querySelectorAll('.map-result-item').forEach(el => {
          el.addEventListener('click', () => {
            if (!mapTargetComponentId) return;
            // Update the component's properties
            const comp = getActiveSheet().components.find(c => c.id === mapTargetComponentId);
            if (comp) {
              const dataset = (el as HTMLElement).dataset;
              comp.properties = comp.properties || {};
              comp.properties.lcsc = dataset.lcsc || '';
              comp.properties.mpn = dataset.mpn || '';
              comp.properties.manufacturer = dataset.mfr || '';
              comp.properties.stock = dataset.stock || '0';
              comp.properties.price = dataset.price || '0';
              comp.properties.basic = dataset.basic || 'false';
              comp.properties.package = dataset.package || '';
              comp.properties.description = dataset.desc || '';
              comp.properties.category = dataset.category || '';
              comp.properties.jlcpcbName = dataset.name || '';
              
              localStorage.setItem('sc_document', JSON.stringify(doc));
              renderer.setDocument(doc);
              updatePropertiesPanel([mapTargetComponentId]);
            }
            mapModal.style.display = 'none';
            mapTargetComponentId = null;
          });
        });
      } else {
        mapResultsContainer.innerHTML = '<p class="hint">No results found.</p>';
      }
    } catch {
      mapResultsContainer.innerHTML = '<p class="hint">Search failed. Is the server running?</p>';
    }
  }, 400);
});

// ----- Welcome Modal on Startup -----
(async function showWelcomeModal() {
  // Build the welcome overlay
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'welcome-modal';
  overlay.innerHTML = `
    <div class="modal-content welcome-modal-content">
      <div class="welcome-header">
        <span class="welcome-logo">⚡</span>
        <h1 class="welcome-title">Smart Circuit</h1>
        <p class="welcome-subtitle">Electronic Design Automation</p>
      </div>
      <div class="welcome-actions">
        <button id="welcome-new" class="welcome-new-btn">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>
          <div>
            <div class="welcome-btn-label">New Project</div>
            <div class="welcome-btn-desc">Start with a blank schematic</div>
          </div>
        </button>
      </div>
      <div class="welcome-recent-header">
        <span>Recent Projects</span>
      </div>
      <div id="welcome-projects" class="welcome-projects">
        <div class="empty-projects"><div class="loading-spinner"></div></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Close helper
  function closeWelcome() {
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 200);
  }

  // New project button
  document.getElementById('welcome-new')!.addEventListener('click', () => {
    closeWelcome();
  });

  // Load recent projects
  const container = document.getElementById('welcome-projects')!;
  try {
    const projects = await listProjects();
    if (projects.length === 0) {
      container.innerHTML = `
        <div class="empty-projects" style="padding: 20px;">
          <div class="empty-projects-sub">No recent projects</div>
        </div>
      `;
      return;
    }

    container.innerHTML = projects.slice(0, 6).map(p => `
      <div class="welcome-project-card" data-id="${p.id}">
        <div class="project-card-icon">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" stroke-width="1.2">
            <path d="M3 2h6l4 4v7a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/>
            <path d="M9 2v4h4" opacity="0.5"/>
          </svg>
        </div>
        <div class="project-card-body">
          <div class="project-card-name">${p.name}</div>
          <div class="project-card-meta">
            <span class="project-card-date">${timeAgo(p.updatedAt)}</span>
            <span class="project-card-dot">·</span>
            <span class="project-card-count">${p.componentCount || 0} component${(p.componentCount || 0) !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.welcome-project-card').forEach(card => {
      card.addEventListener('click', async () => {
        const id = (card as HTMLElement).dataset.id;
        if (!id) return;
        card.classList.add('loading');
        try {
          const loadedDoc = await getProject(id);
          doc = loadedDoc;
          // Restore imported library definitions from server
          await restoreCustomLibrary(doc);
          commandStack = new CommandStack(doc);
          toolExecutor.setDocument(doc, commandStack);
          renderer.setDocument(doc);
          renderer.centerView();
          activeSheetIndex = 0;
          renderer.setActiveSheetIndex(0);
          updatePropertiesPanel([]);
          updateProjectName();
          renderSheetTabs();
          pcbRenderer = null;
          componentDrawer = null;
          document.getElementById('pcb-container')!.innerHTML = '';
          switchView('schematic');
          closeWelcome();
          showToast(`Opened "${doc.name}"`);
        } catch (err) {
          console.error('Failed to load project:', err);
          card.classList.remove('loading');
          showToast('Failed to open project', 'error');
        }
      });
    });
  } catch {
    container.innerHTML = `
      <div class="empty-projects" style="padding: 20px;">
        <div class="empty-projects-sub">Could not load recent projects</div>
      </div>
    `;
  }
})();
