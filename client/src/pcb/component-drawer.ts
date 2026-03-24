// ============================================================
// Smart Circuit — PCB Component Drawer
// A DOM-based side panel listing unplaced components that
// need to be placed on the PCB board.
// ============================================================

import type { CircuitDocument, ComponentDefinition } from '../core/types';

/**
 * Side panel that lists PCB components not yet placed on the board.
 * Grouped by component type (Resistors, Capacitors, ICs, Other).
 */
export class ComponentDrawer {
  private container: HTMLElement;
  private listEl: HTMLElement;

  /** Callback when user starts dragging a component from the drawer */
  onDragStart: ((pcbComponentId: string, schematicComponentId: string) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    // Header
    const header = document.createElement('h3');
    header.textContent = 'Unplaced Components';
    header.style.padding = '12px 12px 8px';
    header.style.fontSize = '12px';
    header.style.fontWeight = '600';
    header.style.textTransform = 'uppercase';
    header.style.letterSpacing = '0.5px';
    header.style.color = '#8888aa';
    header.style.margin = '0';
    this.container.appendChild(header);

    // Scrollable list
    this.listEl = document.createElement('div');
    this.listEl.style.flex = '1';
    this.listEl.style.overflowY = 'auto';
    this.container.appendChild(this.listEl);
  }

  /**
   * Update the drawer based on current document state.
   * Call this whenever the document changes or a component is placed.
   */
  update(doc: CircuitDocument, libraryMap: Map<string, ComponentDefinition>): void {
    this.listEl.innerHTML = '';

    if (!doc.pcbLayout) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'No PCB layout initialized.';
      this.listEl.appendChild(hint);
      return;
    }

    const unplaced = doc.pcbLayout.components.filter(c => !c.isPlaced);

    if (unplaced.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'All components placed! ✓';
      this.listEl.appendChild(hint);
      return;
    }

    // Group by designator prefix
    const groups = new Map<string, typeof unplaced>();
    for (const pcbComp of unplaced) {
      const schComp = this.findSchematicComponent(doc, pcbComp.schematicComponentId);
      const prefix = schComp
        ? this.getDesignatorPrefix(schComp.designator)
        : 'Other';
      const groupName = this.prefixToGroupName(prefix);
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName)!.push(pcbComp);
    }

    // Render groups in a fixed order
    const groupOrder = ['Resistors', 'Capacitors', 'Inductors', 'ICs', 'Connectors', 'Other'];
    for (const groupName of groupOrder) {
      const items = groups.get(groupName);
      if (!items || items.length === 0) continue;

      // Group header
      const sectionHeader = document.createElement('h4');
      sectionHeader.textContent = `${groupName} (${items.length})`;
      sectionHeader.style.padding = '6px 12px';
      sectionHeader.style.fontSize = '11px';
      sectionHeader.style.fontWeight = '600';
      sectionHeader.style.color = '#555577';
      sectionHeader.style.textTransform = 'uppercase';
      sectionHeader.style.letterSpacing = '0.3px';
      sectionHeader.style.margin = '0';
      this.listEl.appendChild(sectionHeader);

      // Items
      for (const pcbComp of items) {
        const schComp = this.findSchematicComponent(doc, pcbComp.schematicComponentId);
        if (!schComp) continue;

        const def = libraryMap.get(schComp.libraryId);

        const item = document.createElement('button');
        item.className = 'lib-item';
        item.style.display = 'flex';
        item.style.flexDirection = 'column';
        item.style.gap = '2px';
        item.style.width = 'calc(100% - 16px)';
        item.style.textAlign = 'left';

        // Top row: designator + package badge
        const topRow = document.createElement('div');
        topRow.style.display = 'flex';
        topRow.style.alignItems = 'center';
        topRow.style.gap = '6px';

        const designator = document.createElement('span');
        designator.textContent = schComp.designator;
        designator.style.fontWeight = '600';
        designator.style.fontFamily = '"JetBrains Mono", monospace';
        designator.style.fontSize = '12px';
        topRow.appendChild(designator);

        // Package badge
        const packageName = def?.properties?.['package'] || schComp.properties?.['package'] || '';
        if (packageName) {
          const badge = document.createElement('span');
          badge.className = 'package-badge';
          badge.textContent = packageName;
          topRow.appendChild(badge);
        }

        item.appendChild(topRow);

        // Value row
        if (schComp.value) {
          const valueEl = document.createElement('div');
          valueEl.textContent = schComp.value;
          valueEl.style.fontSize = '11px';
          valueEl.style.color = '#8888aa';
          valueEl.style.fontFamily = '"JetBrains Mono", monospace';
          item.appendChild(valueEl);
        }

        // Drag behavior
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.onDragStart?.(pcbComp.id, pcbComp.schematicComponentId);
        });

        // Cursor hint
        item.style.cursor = 'grab';

        this.listEl.appendChild(item);
      }
    }
  }

  // ----- Helpers -----

  private findSchematicComponent(doc: CircuitDocument, schematicId: string) {
    for (const sheet of doc.sheets) {
      const comp = sheet.components.find(c => c.id === schematicId);
      if (comp) return comp;
    }
    return null;
  }

  private getDesignatorPrefix(designator: string): string {
    const match = designator.match(/^[A-Za-z]+/);
    return match ? match[0].toUpperCase() : 'Other';
  }

  private prefixToGroupName(prefix: string): string {
    switch (prefix) {
      case 'R': return 'Resistors';
      case 'C': return 'Capacitors';
      case 'L': return 'Inductors';
      case 'U': case 'IC': return 'ICs';
      case 'J': case 'P': case 'CN': return 'Connectors';
      default: return 'Other';
    }
  }
}
