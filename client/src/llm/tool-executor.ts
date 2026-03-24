import { API_BASE } from '../config';
import type { CircuitDocument, ComponentDefinition, Point, Sheet } from '../core/types';
import { layoutSubcircuit } from './subcircuit-layout';
import { renderSubcircuitPreview, createPreviewPlaceholder } from './subcircuit-preview';
import { AddComponentCommand, DeleteComponentCommand, AddSubcircuitCommand } from '../core/document';
import type { SubcircuitConnectionInput } from '../core/document';
import { createPCBLayout, PlacePCBComponentCommand, MovePCBComponentCommand, InitializePCBFromSchematicCommand } from '../core/pcb-document';
import { CommandStack } from '../core/command-stack';
import { resolvedToComponentDef, createFallbackIC } from '../library/easyeda-parser';
import type { ResolvedComponentResponse } from '../library/easyeda-parser';

// ----- Types -----

interface ToolCallArgs {
  [key: string]: unknown;
}

interface PinArg {
  name: string;
  type: string;
}

interface AddComponentArgs {
  libraryId?: string;
  designator: string;
  value: string;
  mpn?: string;
  pins?: PinArg[];
  sheet?: string;
}

interface AddSubcircuitArgs {
  name: string;
  components: {
    designator: string;
    value: string;
    libraryId?: string;
    mpn?: string;
    x?: number;
    y?: number;
    rotation?: number;
    pins?: PinArg[];
  }[];
  connections?: {
    fromDesignator: string;
    fromPin: string;
    toDesignator: string;
    toPin: string;
    netName?: string;
  }[];
}

interface ModifyComponentArgs {
  designator: string;
  newValue?: string;
  newFootprint?: string;
}

interface RemoveComponentArgs {
  designator: string;
}

interface MapJlcpcbPartArgs {
  designator: string;
  searchQuery: string;
  packageFilter?: string;
  selectedLcsc?: string;
}

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

// ----- Executor -----

export class ToolExecutor {
  private doc: CircuitDocument;
  private commandStack: CommandStack;
  private libraryMap: Map<string, ComponentDefinition>;
  private messagesContainer: HTMLElement;
  private activeSheetIndex: number = 0;

  // Cache resolved components to avoid redundant API calls
  private resolveCache = new Map<string, ComponentDefinition>();

  constructor(opts: {
    doc: CircuitDocument;
    commandStack: CommandStack;
    libraryMap: Map<string, ComponentDefinition>;
    messagesContainer: HTMLElement;
  }) {
    this.doc = opts.doc;
    this.commandStack = opts.commandStack;
    this.libraryMap = opts.libraryMap;
    this.messagesContainer = opts.messagesContainer;
  }

  /** Update the document reference (call after save/load/new project). */
  setDocument(doc: CircuitDocument, commandStack?: CommandStack) {
    this.doc = doc;
    if (commandStack) this.commandStack = commandStack;
  }

  /** Set the active sheet index (call when the user switches tabs). */
  setActiveSheetIndex(idx: number) {
    this.activeSheetIndex = idx;
  }

  /** Get the currently active sheet. */
  private getActiveSheet(): Sheet {
    return this.doc.sheets[this.activeSheetIndex];
  }

  /**
   * Handle an incoming tool call from the LLM SSE stream.
   * Renders a preview card into the chat and returns the card element.
   */
  handleToolCall(name: string, args: ToolCallArgs): HTMLElement {
    switch (name) {
      case 'add_component':
        return this.renderAddComponent(args as unknown as AddComponentArgs);
      case 'add_subcircuit':
        return this.renderAddSubcircuit(args as unknown as AddSubcircuitArgs);
      case 'modify_component':
        return this.renderModifyComponent(args as unknown as ModifyComponentArgs);
      case 'remove_component':
        return this.renderRemoveComponent(args as unknown as RemoveComponentArgs);
      case 'map_jlcpcb_part':
        return this.renderMapJlcpcbPart(args as unknown as MapJlcpcbPartArgs);
      case 'layout_pcb_components':
        return this.renderLayoutPCB(args as unknown as LayoutPCBArgs);
      default:
        return this.renderUnknown(name, args);
    }
  }

  // ----- Card Renderers -----

  private renderAddComponent(args: AddComponentArgs): HTMLElement {
    const { designator, value, libraryId, mpn, pins } = args;

    const details: { label: string; value: string }[] = [
      { label: 'Designator', value: designator },
      { label: 'Value', value: value },
    ];
    if (mpn) details.push({ label: 'MPN', value: mpn });
    if (libraryId) details.push({ label: 'Library', value: libraryId });
    if (pins?.length) details.push({ label: 'Pins', value: `${pins.length} pins` });

    const card = this.createCard({
      icon: '📦',
      title: 'Add Component',
      details,
    });

    this.attachActions(card, {
      onAccept: async () => {
        this.markLoading(card, 'Resolving component...');
        try {
          const def = await this.resolveComponentDef(libraryId, designator, mpn, pins, value);
          const pos = this.findOpenPosition();
          const cmd = new AddComponentCommand(
            this.getActiveSheet().id, def, pos, value, designator
          );
          this.commandStack.execute(cmd);
          this.markAccepted(card, `Added ${designator} (${def.symbol.pins.length} pins)`);
        } catch (err) {
          this.markRejected(card, `Error: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      },
      onReject: () => {
        this.markRejected(card);
      },
    });

    this.messagesContainer.appendChild(card);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    return card;
  }

  private renderAddSubcircuit(args: AddSubcircuitArgs): HTMLElement {
    const { name, components, connections } = args;

    // Create the preview placeholder — we'll swap it for a canvas once defs resolve
    const previewPlaceholder = createPreviewPlaceholder();

    const card = this.createCard({
      icon: '🔌',
      title: `Add Subcircuit — ${name}`,
      details: [
        { label: 'Components', value: `${components.length} parts` },
        ...(connections?.length
          ? [{ label: 'Connections', value: `${connections.length} wire${connections.length > 1 ? 's' : ''}` }]
          : []),
      ],
      previewContainer: previewPlaceholder,
    });

    // Eagerly resolve defs to render the preview canvas
    let cachedDefs: ComponentDefinition[] | null = null;

    (async () => {
      try {
        const results = await Promise.allSettled(
          components.map(c =>
            this.resolveComponentDef(c.libraryId, c.designator, c.mpn, c.pins, c.value)
          )
        );

        cachedDefs = results.map((r, i) => {
          if (r.status === 'fulfilled' && r.value) return r.value;
          if (r.status === 'rejected') {
            console.warn(`[Preview] Failed to resolve ${components[i].designator}:`, r.reason);
          }
          // Return a generic fallback def based on designator prefix
          return this.getGenericFallback(components[i].designator);
        });

        // Render the mini schematic preview
        const canvas = renderSubcircuitPreview(components, connections || [], cachedDefs);
        previewPlaceholder.replaceWith(canvas);
      } catch (err) {
        console.warn('[Preview] Subcircuit preview rendering failed:', err);
        previewPlaceholder.textContent = '⚠️ Preview unavailable';
        previewPlaceholder.classList.add('subcircuit-preview-error');
      }
    })();

    this.attachActions(card, {
      onAccept: async () => {
        this.markLoading(card, 'Placing components...');
        try {
          let baseX = 200;
          let baseY = 200;
          const existing = this.getActiveSheet().components;
          if (existing.length > 0) {
            baseX = Math.max(...existing.map(c => c.position.x)) + 160;
            baseY = existing[0].position.y;
          }

          // Use cached defs if available, otherwise re-resolve with resilience
          let resolvedDefs: ComponentDefinition[];
          if (cachedDefs) {
            resolvedDefs = cachedDefs;
          } else {
            const results = await Promise.allSettled(
              components.map(c =>
                this.resolveComponentDef(c.libraryId, c.designator, c.mpn, c.pins, c.value)
              )
            );
            resolvedDefs = results.map((r, i) => {
              if (r.status === 'fulfilled' && r.value) return r.value;
              return this.getGenericFallback(components[i].designator);
            });
          }

          // Use connection-aware layout
          const compInputs = layoutSubcircuit(
            components, connections || [], resolvedDefs,
            { x: baseX, y: baseY }
          );

          const connInputs: SubcircuitConnectionInput[] = (connections || []).map(c => ({
            fromDesignator: c.fromDesignator,
            fromPin: c.fromPin,
            toDesignator: c.toDesignator,
            toPin: c.toPin,
            netName: c.netName,
          }));

          // Build map of definitions for existing components targeted by connections
          const existingDefs: Record<string, ComponentDefinition> = {};
          for (const conn of connections || []) {
            const targets = [conn.fromDesignator, conn.toDesignator];
            for (const t of targets) {
              // Only load it if it's not part of the *new* subcircuit components
              if (!components.some(c => c.designator === t)) {
                const existingComp = this.getActiveSheet().components.find(c => c.designator === t);
                if (existingComp) {
                  const def = this.libraryMap.get(existingComp.libraryId || existingComp.footprintId || '');
                  if (def) existingDefs[t] = def;
                }
              }
            }
          }

          const cmd = new AddSubcircuitCommand(
            this.getActiveSheet().id, compInputs, connInputs, existingDefs
          );
          this.commandStack.execute(cmd);

          const icCount = resolvedDefs.filter(d => d.category === 'ics_resolved').length;
          const connRequested = connInputs.length;
          const connMade = cmd.connectionsCreated;
          let statusMsg = `Added ${components.length} components`;
          if (icCount > 0) statusMsg += ` (${icCount} resolved from EasyEDA)`;
          if (connMade > 0) statusMsg += ` with ${connMade} connection${connMade > 1 ? 's' : ''}`;
          if (connMade < connRequested) {
            statusMsg += ` ⚠️ ${connRequested - connMade} connection${connRequested - connMade > 1 ? 's' : ''} failed (pin mismatch)`;
          }
          this.markAccepted(card, statusMsg, cmd.failedConnections);
        } catch (err) {
          this.markRejected(card, `Error: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      },
      onReject: () => {
        this.markRejected(card);
      },
    });

    this.messagesContainer.appendChild(card);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    return card;
  }

  private renderModifyComponent(args: ModifyComponentArgs): HTMLElement {
    const { designator, newValue, newFootprint } = args;
    const comp = this.getActiveSheet().components.find(c => c.designator === designator);

    const details: { label: string; value: string }[] = [
      { label: 'Component', value: designator },
    ];
    if (newValue) {
      details.push({ label: 'Value', value: `${comp?.value ?? '?'} → ${newValue}` });
    }
    if (newFootprint) {
      details.push({ label: 'Footprint', value: `→ ${newFootprint}` });
    }

    const card = this.createCard({
      icon: '✏️',
      title: 'Modify Component',
      details,
    });

    this.attachActions(card, {
      onAccept: () => {
        if (!comp) {
          this.markRejected(card, `Component ${designator} not found`);
          return;
        }
        // Direct mutation (no dedicated command yet)
        if (newValue) comp.value = newValue;
        if (newFootprint) comp.footprintId = newFootprint;
        this.doc.updatedAt = new Date().toISOString();
        this.markAccepted(card, `Modified ${designator}`);
      },
      onReject: () => {
        this.markRejected(card);
      },
    });

    this.messagesContainer.appendChild(card);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    return card;
  }

  private renderRemoveComponent(args: RemoveComponentArgs): HTMLElement {
    const { designator } = args;
    const comp = this.getActiveSheet().components.find(c => c.designator === designator);

    const card = this.createCard({
      icon: '🗑️',
      title: 'Remove Component',
      details: [
        { label: 'Designator', value: designator },
        { label: 'Value', value: comp?.value ?? 'unknown' },
      ],
    });

    this.attachActions(card, {
      onAccept: () => {
        if (!comp) {
          this.markRejected(card, `Component ${designator} not found`);
          return;
        }
        const cmd = new DeleteComponentCommand(this.getActiveSheet().id, comp.id);
        this.commandStack.execute(cmd);
        this.markAccepted(card, `Removed ${designator}`);
      },
      onReject: () => {
        this.markRejected(card);
      },
    });

    this.messagesContainer.appendChild(card);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    return card;
  }

  private renderLayoutPCB(args: LayoutPCBArgs): HTMLElement {
    const { boardWidth, boardHeight, placements } = args;

    const details: { label: string; value: string }[] = [
      { label: 'Components', value: `${placements.length} placements` },
    ];
    if (boardWidth || boardHeight) {
      details.push({ label: 'Board', value: `${boardWidth ?? 100}mm × ${boardHeight ?? 80}mm` });
    }

    const card = this.createCard({
      icon: '🗺️',
      title: 'Auto Layout PCB',
      details,
    });

    this.attachActions(card, {
      onAccept: () => {
        try {
          // Ensure PCB layout exists and is initialized from schematic
          if (!this.doc.pcbLayout) {
            this.doc.pcbLayout = createPCBLayout(
              boardWidth ?? 100,
              boardHeight ?? 80
            );
            // Initialize PCB components from the schematic so designator lookups work
            const initCmd = new InitializePCBFromSchematicCommand();
            this.commandStack.execute(initCmd);
          }

          let placed = 0;
          let moved = 0;
          let notFoundList: string[] = [];

          for (const p of placements) {
            // Find the schematic component by designator (trim and case-insensitive)
            const targetDes = (p.designator || '').trim().toLowerCase();
            const schComp = this.getActiveSheet().components.find(
              c => c.designator.toLowerCase() === targetDes
            );
            if (!schComp) {
              notFoundList.push(p.designator);
              continue;
            }

            const layer = p.layer ?? 'F.Cu';
            const position = { x: p.x, y: p.y };

            // Find existing PCB component for this schematic component
            const existingPcb = this.doc.pcbLayout.components.find(
              c => c.schematicComponentId === schComp.id
            );

            if (existingPcb && existingPcb.isPlaced) {
              // Already placed — move it
              const cmd = new MovePCBComponentCommand(existingPcb.id, position);
              this.commandStack.execute(cmd);
              // Update rotation and layer directly
              existingPcb.rotation = p.rotation ?? 0;
              existingPcb.layer = layer;
              moved++;
            } else if (existingPcb && !existingPcb.isPlaced) {
              // Exists but unplaced — place it by updating in-place
              existingPcb.position = { ...position };
              existingPcb.rotation = p.rotation ?? 0;
              existingPcb.layer = layer;
              existingPcb.isPlaced = true;
              placed++;
            } else {
              // Doesn't exist — create a new PCBComponent entry
              const cmd = new PlacePCBComponentCommand(
                schComp.id,
                schComp.footprintId || '',
                position,
                layer
              );
              this.commandStack.execute(cmd);
              // Update rotation on the newly placed component
              const newest = this.doc.pcbLayout!.components[
                this.doc.pcbLayout!.components.length - 1
              ];
              if (newest) newest.rotation = p.rotation ?? 0;
              placed++;
            }
          }

          // Auto-place any remaining unplaced PCB components so they are
          // visible on the board instead of being invisible at (0,0).
          let autoPlaced = 0;
          const bw = boardWidth ?? 100;
          const bh = boardHeight ?? 80;
          const unplaced = this.doc.pcbLayout.components.filter(c => !c.isPlaced);
          if (unplaced.length > 0) {
            // Stagger in a grid along the bottom portion of the board
            const cols = Math.max(1, Math.floor(bw / 10));
            for (let i = 0; i < unplaced.length; i++) {
              const col = i % cols;
              const row = Math.floor(i / cols);
              unplaced[i].position = { x: 5 + col * 10, y: bh - 5 - row * 10 };
              unplaced[i].isPlaced = true;
              unplaced[i].layer = 'F.Cu';
              autoPlaced++;
            }
          }

          this.doc.updatedAt = new Date().toISOString();

          let statusMsg = `Placed ${placed + moved} components on PCB`;
          if (moved > 0) statusMsg += ` (${moved} repositioned)`;
          if (autoPlaced > 0) statusMsg += ` (${autoPlaced} auto-placed)`;
          if (notFoundList.length > 0) statusMsg += ` ⚠️ Missing in schematic: ${notFoundList.join(', ')}`;
          this.markAccepted(card, statusMsg);
        } catch (err) {
          this.markRejected(card, `Error: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      },
      onReject: () => {
        this.markRejected(card);
      },
    });

    this.messagesContainer.appendChild(card);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    return card;
  }

  private renderUnknown(name: string, args: ToolCallArgs): HTMLElement {
    const card = this.createCard({
      icon: '⚙️',
      title: `Tool: ${name}`,
      details: Object.entries(args).map(([k, v]) => ({
        label: k,
        value: String(v),
      })),
    });

    // No actions for unknown tools
    const actions = card.querySelector('.tool-card-actions');
    if (actions) {
      actions.innerHTML = '<span class="tool-card-badge tool-card-badge-info">ℹ️ Info only</span>';
    }

    this.messagesContainer.appendChild(card);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    return card;
  }

  private renderMapJlcpcbPart(args: MapJlcpcbPartArgs): HTMLElement {
    const { designator, searchQuery, selectedLcsc } = args;
    const comp = this.getActiveSheet().components.find(c => c.designator === designator);

    const details: { label: string; value: string }[] = [
      { label: 'Component', value: designator + (comp ? ` (${comp.value})` : '') },
      { label: 'Search', value: searchQuery },
    ];
    if (selectedLcsc) details.push({ label: 'Selected', value: selectedLcsc });

    const card = this.createCard({
      icon: '🔍',
      title: 'Map JLCPCB Part',
      details,
    });

    // Eagerly fetch and cache the best match so Accept doesn't re-search
    let cachedMatch: Record<string, unknown> | null = null;

    (async () => {
      try {
        const params = new URLSearchParams({
          q: selectedLcsc || searchQuery,
          limit: '20',
        });
        const res = await fetch(`${API_BASE}/components/search?${params}`);
        const data = await res.json();
        const results: any[] = data.results || [];

        if (results.length > 0) {
          // Prefer exact LCSC match → first Basic part → first result
          cachedMatch = selectedLcsc
            ? results.find((r: any) => r.lcscPartNumber === selectedLcsc)
            : null;
          if (!cachedMatch) {
            cachedMatch = results.find((r: any) => r.basic) || results[0];
          }

          // Show resolved part details on the card
          if (cachedMatch) {
            const m = cachedMatch as any;
            const priceStr = m.price ? `$${Number(m.price).toFixed(4)}` : '—';
            const basicStr = m.basic ? 'Basic' : 'Extended';
            const detailsDiv = card.querySelector('.tool-card-details');
            if (detailsDiv) {
              detailsDiv.innerHTML += `
                <div class="tool-card-detail-row">
                  <span class="tool-card-label">Part</span>
                  <span class="tool-card-value">${m.lcscPartNumber} · ${m.mpn || m.name || ''}</span>
                </div>
                <div class="tool-card-detail-row">
                  <span class="tool-card-label">Info</span>
                  <span class="tool-card-value">${priceStr} · ${basicStr} · Stock: ${(m.stock || 0).toLocaleString()}</span>
                </div>
              `;
            }
          }
        }
      } catch {
        // Will fall back to searching on Accept
      }
    })();

    this.attachActions(card, {
      onAccept: async () => {
        if (!comp) {
          this.markRejected(card, `Component ${designator} not found`);
          return;
        }

        // Use cached match; only re-search if cache is empty
        let match = cachedMatch as any;
        if (!match) {
          this.markLoading(card, 'Searching JLCPCB...');
          try {
            const params = new URLSearchParams({
              q: selectedLcsc || searchQuery,
              limit: '20',
            });
            const res = await fetch(`${API_BASE}/components/search?${params}`);
            const data = await res.json();
            const results: any[] = data.results || [];
            match = selectedLcsc
              ? results.find((r: any) => r.lcscPartNumber === selectedLcsc)
              : null;
            if (!match) {
              match = results.find((r: any) => r.basic) || results[0];
            }
          } catch (err) {
            this.markRejected(card, `Error: ${err instanceof Error ? err.message : 'unknown'}`);
            return;
          }
        }

        if (!match) {
          this.markRejected(card, 'No matching JLCPCB part found');
          return;
        }

        // Apply part properties to the component
        comp.properties = comp.properties || {};
        comp.properties.lcsc = match.lcscPartNumber || '';
        comp.properties.mpn = match.mpn || '';
        comp.properties.manufacturer = match.manufacturer || '';
        comp.properties.stock = String(match.stock || 0);
        comp.properties.price = String(match.price || 0);
        comp.properties.basic = match.basic ? 'true' : 'false';
        comp.properties.package = match.package || '';

        this.doc.updatedAt = new Date().toISOString();

        const priceStr = match.price ? ` · $${Number(match.price).toFixed(4)}` : '';
        const basicStr = match.basic ? ' · Basic' : '';
        this.markAccepted(
          card,
          `Mapped ${designator} → ${match.lcscPartNumber} (${match.mpn || match.name || 'unknown'})${priceStr}${basicStr}`
        );
      },
      onReject: () => {
        this.markRejected(card);
      },
    });

    this.messagesContainer.appendChild(card);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    return card;
  }

  // ----- DOM Builders -----

  private createCard(opts: {
    icon: string;
    title: string;
    details: { label: string; value: string }[];
    listItems?: string[];
    footer?: string;
    previewContainer?: HTMLElement;
  }): HTMLElement {
    const card = document.createElement('div');
    card.className = 'tool-call-card';

    let html = `
      <div class="tool-card-header">
        <span class="tool-card-icon">${opts.icon}</span>
        <span class="tool-card-title">${opts.title}</span>
      </div>
      <div class="tool-card-details">
        ${opts.details.map(d => `
          <div class="tool-card-detail-row">
            <span class="tool-card-label">${d.label}</span>
            <span class="tool-card-value">${d.value}</span>
          </div>
        `).join('')}
      </div>
      <div class="tool-card-preview-slot"></div>
    `;

    if (opts.listItems?.length) {
      html += `
        <div class="tool-card-subcircuit-list">
          ${opts.listItems.map(item => `<div class="tool-card-list-item">• ${item}</div>`).join('')}
        </div>
      `;
    }

    if (opts.footer) {
      html += `<div class="tool-card-footer">${opts.footer}</div>`;
    }

    html += `
      <div class="tool-card-actions">
        <button class="tool-card-btn tool-card-accept">✓ Accept</button>
        <button class="tool-card-btn tool-card-reject">✕ Reject</button>
      </div>
    `;

    card.innerHTML = html;

    // Insert preview element into the slot if provided
    if (opts.previewContainer) {
      const slot = card.querySelector('.tool-card-preview-slot');
      if (slot) slot.appendChild(opts.previewContainer);
    }

    return card;
  }

  private attachActions(card: HTMLElement, handlers: { onAccept: () => void | Promise<void>; onReject: () => void }) {
    const acceptBtn = card.querySelector('.tool-card-accept') as HTMLButtonElement;
    const rejectBtn = card.querySelector('.tool-card-reject') as HTMLButtonElement;

    acceptBtn.addEventListener('click', async () => {
      try {
        await handlers.onAccept();
      } catch (err) {
        this.markRejected(card, `Error: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    });

    rejectBtn.addEventListener('click', () => {
      handlers.onReject();
    });
  }

  private markLoading(card: HTMLElement, statusText: string) {
    const actions = card.querySelector('.tool-card-actions');
    if (actions) {
      actions.innerHTML = `<span class="tool-card-badge tool-card-badge-loading">⏳ ${statusText}</span>`;
    }
  }

  private markAccepted(card: HTMLElement, statusText: string, details?: string[]) {
    card.classList.add('tool-card-accepted');
    const actions = card.querySelector('.tool-card-actions');
    if (actions) {
      let html = `<span class="tool-card-badge tool-card-badge-accept">✓ ${statusText}</span>`;
      if (details && details.length > 0) {
        html += `<div class="tool-card-error-details" style="margin-top: 8px; font-size: 0.85em; color: var(--color-danger); text-align: left; padding: 4px; border-radius: 4px; background-color: rgba(255,0,0,0.05); width: 100%;">
          ${details.map(d => `<div style="margin-bottom: 2px;">• ${d}</div>`).join('')}
        </div>`;
      }
      actions.innerHTML = html;
      
      if (details && details.length > 0) {
         actions.setAttribute('style', 'display: flex; flex-direction: column; align-items: flex-start; gap: 4px;');
      }
    }
  }

  private markRejected(card: HTMLElement, reason?: string) {
    card.classList.add('tool-card-rejected');
    const actions = card.querySelector('.tool-card-actions');
    if (actions) {
      actions.innerHTML = `<span class="tool-card-badge tool-card-badge-reject">✕ ${reason || 'User rejected this action'}</span>`;
    }
  }

  // ----- Component Resolution Pipeline -----

  /**
   * Resolve a component definition using the priority chain:
   * 1. MPN → server /api/components/resolve → EasyEDA real pin data
   * 2. LLM-provided pins → dynamic IC generator
   * 3. libraryId → builtin library
   * 4. designator prefix fallback → ic_generic / res_generic
   */
  private async resolveComponentDef(
    libraryId: string | undefined,
    designator: string,
    mpn?: string,
    pins?: PinArg[],
    value?: string,
  ): Promise<ComponentDefinition> {

    // 1. Try MPN resolution via EasyEDA
    if (mpn) {
      // Check cache first
      const cacheKey = mpn.toLowerCase();
      const cached = this.resolveCache.get(cacheKey);
      if (cached) return cached;

      try {
        const res = await fetch(`${API_BASE}/components/resolve?mpn=${encodeURIComponent(mpn)}`);
        if (res.ok) {
          const resolved: ResolvedComponentResponse = await res.json();
          if (resolved.pins?.length > 0) {
            const def = resolvedToComponentDef(resolved, value);
            this.resolveCache.set(cacheKey, def);
            // Also register in libraryMap so the renderer can look it up
            this.libraryMap.set(def.id, def);
            return def;
          }
        }
      } catch {
        // EasyEDA lookup failed — fall through to next strategy
      }
    }

    // 2. LLM-provided pins fallback
    if (pins && pins.length > 0) {
      const def = createFallbackIC(
        mpn || value || designator,
        value || designator,
        pins
      );
      this.libraryMap.set(def.id, def);
      return def;
    }

    // 3. Known library ID
    if (libraryId) {
      const def = this.libraryMap.get(libraryId);
      if (def) return def;
    }

    // 4. Designator prefix fallback
    const def = this.getGenericFallback(designator);
    return def;
  }

  /**
   * Find an open position on the canvas that doesn't overlap existing components.
   */
  private findOpenPosition(): Point {
    const existing = this.getActiveSheet().components;
    if (existing.length === 0) return { x: 200, y: 200 };

    const maxX = Math.max(...existing.map(c => c.position.x));
    const avgY = existing.reduce((sum, c) => sum + c.position.y, 0) / existing.length;
    return { x: maxX + 160, y: Math.round(avgY / 10) * 10 };
  }

  /**
   * Return a generic fallback component definition based on designator prefix.
   * Used when component resolution fails during preview rendering.
   */
  private getGenericFallback(designator: string): ComponentDefinition {
    const prefix = (designator || '').replace(/\d+$/, '').toUpperCase();
    const prefixMap: Record<string, string> = {
      R: 'res_generic', C: 'cap_generic', D: 'led_generic',
      U: 'ic_generic', L: 'ind_generic', Q: 'npn_generic',
    };
    const fallbackId = prefixMap[prefix] || 'res_generic';
    const fromLib = this.libraryMap.get(fallbackId);
    if (fromLib) return fromLib;

    // Last-resort: create an inline minimal IC def
    return createFallbackIC(designator, designator, [
      { name: '1', type: 'passive' },
      { name: '2', type: 'passive' },
    ]);
  }
}
