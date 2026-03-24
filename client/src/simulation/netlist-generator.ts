// ============================================================
// Smart Circuit — SPICE Netlist Generator
// ============================================================
// Converts a CircuitDocument into a valid ngspice netlist string.
// Scope: R, C, L + voltage/current sources (V, I).

import type { CircuitDocument, PinInstance, ComponentDefinition } from '../core/types';
import { parseSpiceValue } from './spice-value-parser';

// ----- Public Types -----

export interface SimulationConfig {
  analysis: 'transient' | 'ac' | 'dc' | 'op';
  // Transient
  stepTime?: string;  // e.g. "1u" = 1µs
  stopTime?: string;  // e.g. "10m" = 10ms
  // AC
  acType?: 'dec' | 'oct' | 'lin';
  acPoints?: number;
  fStart?: string;    // e.g. "1" = 1Hz
  fStop?: string;     // e.g. "1Meg"
  // DC
  dcSource?: string;  // designator of source to sweep
  dcStart?: string;
  dcStop?: string;
  dcStep?: string;
}

export interface NetlistResult {
  netlist: string;
  nodeMap: Map<string, string>;  // net name → SPICE node number/name
  errors: string[];              // fatal: "No ground node found"
  warnings: string[];            // non-fatal: "R3 is floating"
}

// ----- Supported Prefix Types -----

const SUPPORTED_PREFIXES = new Set(['R', 'C', 'L', 'V', 'I', 'D', 'Q']);

// ----- Main Generator -----

/**
 * Generate a SPICE netlist from a CircuitDocument.
 *
 * @param doc - The circuit document to convert
 * @param config - Simulation analysis configuration
 * @param libraryMap - Map of libraryId → ComponentDefinition (for pin name lookup)
 * @returns NetlistResult with the netlist string, node map, errors, and warnings
 */
export function generateNetlist(
  doc: CircuitDocument,
  config: SimulationConfig,
  libraryMap: Map<string, ComponentDefinition>
): NetlistResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (doc.sheets.length === 0) {
    errors.push('No sheet found in document.');
    return { netlist: '', nodeMap: new Map(), errors, warnings };
  }

  // Gather data from all sheets (they share one physical circuit)
  const allComponents = doc.sheets.flatMap(s => s.components);
  const allWires = doc.sheets.flatMap(s => s.wires);
  const allNets = doc.sheets.flatMap(s => s.nets);
  const allLabels = doc.sheets.flatMap(s => s.labels);

  // ----- Step 1: Build node map -----
  // Collect all unique net identifiers and assign SPICE node names.
  // A net can be identified by:
  //   a) Its Net.id (from sheet.nets)
  //   b) A NetLabel.netName (labels with the same name share a net)

  // First, build a union-find-like mapping: netId → canonical SPICE node name
  const nodeMap = new Map<string, string>(); // net name/id → SPICE node name
  let nodeCounter = 1;
  let hasGround = false;

  // Map to merge net IDs that share the same label name
  // labelName → list of netIds connected by that label
  const labelToNetIds = new Map<string, Set<string>>();

  // Process labels to find which nets they connect
  for (const label of allLabels) {
    const labelName = label.netName;
    if (!labelToNetIds.has(labelName)) {
      labelToNetIds.set(labelName, new Set());
    }

    // Find which pin (and hence which net) this label is attached to
    for (const comp of allComponents) {
      for (const pin of comp.pins) {
        if (pin.absolutePosition.x === label.position.x &&
            pin.absolutePosition.y === label.position.y &&
            pin.netId) {
          labelToNetIds.get(labelName)!.add(pin.netId);
        }
      }
    }
  }

  // Build canonical net ID → SPICE node name mapping
  // Union nets that share labels
  const netIdToCanonical = new Map<string, string>(); // netId → canonical netId

  // For each label group, pick a canonical net ID
  for (const [labelName, netIds] of labelToNetIds) {
    const isGround = labelName === 'GND' || labelName === 'gnd' || labelName === '0';

    if (isGround) {
      hasGround = true;
      // All nets connected by GND label map to node 0
      for (const netId of netIds) {
        netIdToCanonical.set(netId, '0');
      }
      nodeMap.set(labelName, '0');
      continue;
    }

    // Pick the label name as the SPICE node name (more readable)
    const spiceNode = labelName;
    for (const netId of netIds) {
      netIdToCanonical.set(netId, spiceNode);
    }
    nodeMap.set(labelName, spiceNode);
  }

  // Process all nets
  for (const net of allNets) {
    if (netIdToCanonical.has(net.id)) continue; // Already mapped via label

    const isGround = net.name === 'GND' || net.name === 'gnd' || net.name === '0';
    if (isGround) {
      hasGround = true;
      netIdToCanonical.set(net.id, '0');
      nodeMap.set(net.name, '0');
    } else {
      const spiceNode = String(nodeCounter++);
      netIdToCanonical.set(net.id, spiceNode);
      nodeMap.set(net.name, spiceNode);
    }
  }

  // Also check for GND power symbol components (libraryId 'pwr_gnd')
  for (const comp of allComponents) {
    if (comp.libraryId === 'pwr_gnd') {
      hasGround = true;

      for (const pin of comp.pins) {
        // Collect all net IDs connected to this GND pin:
        // 1) Direct pin.netId assignment
        // 2) Wire endpoints touching this pin's absolutePosition
        const connectedNetIds = new Set<string>();

        if (pin.netId) {
          connectedNetIds.add(pin.netId);
        }

        // Walk wires to find any whose endpoint touches this GND pin
        for (const wire of allWires) {
          if (!wire.segments.length) continue;
          const firstSeg = wire.segments[0];
          const lastSeg = wire.segments[wire.segments.length - 1];
          const endpoints = [firstSeg.start, lastSeg.end];
          for (const ep of endpoints) {
            if (ep.x === pin.absolutePosition.x && ep.y === pin.absolutePosition.y) {
              if (wire.netId) {
                connectedNetIds.add(wire.netId);
              }
              // Also find nets that reference this wire
              for (const net of allNets) {
                if (net.wireIds?.includes(wire.id)) {
                  connectedNetIds.add(net.id);
                }
              }
            }
          }
        }

        // Also check if any other component's pin shares the same position (direct connection)
        for (const otherComp of allComponents) {
          if (otherComp.id === comp.id) continue;
          for (const otherPin of otherComp.pins) {
            if (otherPin.absolutePosition.x === pin.absolutePosition.x &&
                otherPin.absolutePosition.y === pin.absolutePosition.y &&
                otherPin.netId) {
              connectedNetIds.add(otherPin.netId);
            }
          }
        }

        // Map all connected nets to GND (node 0)
        for (const netId of connectedNetIds) {
          if (!netIdToCanonical.has(netId)) {
            netIdToCanonical.set(netId, '0');
          } else if (netIdToCanonical.get(netId) !== '0') {
            // Override to GND
            const oldNode = netIdToCanonical.get(netId)!;
            netIdToCanonical.set(netId, '0');
            // Update all other netIds pointing to same old node
            for (const [nid, node] of netIdToCanonical) {
              if (node === oldNode) netIdToCanonical.set(nid, '0');
            }
          }
        }

        // If no connections found at all, create a virtual GND net
        // so at least the ground reference exists
        if (connectedNetIds.size === 0) {
          const virtualNetId = `pwr_gnd_${comp.id}`;
          pin.netId = virtualNetId;
          netIdToCanonical.set(virtualNetId, '0');
          nodeMap.set('GND', '0');
        }
      }
    }
  }

  // Check for labels named GND/gnd that aren't connected to any net yet
  // (they imply ground even without a formal Net object)
  for (const label of allLabels) {
    if (label.netName === 'GND' || label.netName === 'gnd' || label.netName === '0') {
      hasGround = true;
    }
  }

  // ----- Step 1b: Handle labels without explicit nets -----
  // Labels that match pin positions but pins have no netId create implicit connections
  // Build: labelName → set of (componentId, pinDefinitionId) pairs
  const labelPinConnections = new Map<string, Array<{ compId: string; pinDefId: string }>>();

  for (const label of allLabels) {
    for (const comp of allComponents) {
      for (const pin of comp.pins) {
        if (pin.absolutePosition.x === label.position.x &&
            pin.absolutePosition.y === label.position.y) {
          if (!labelPinConnections.has(label.netName)) {
            labelPinConnections.set(label.netName, []);
          }
          labelPinConnections.get(label.netName)!.push({
            compId: comp.id,
            pinDefId: pin.definitionId,
          });

          // If pin has no netId, create a virtual net for it
          if (!pin.netId) {
            const isGnd = label.netName === 'GND' || label.netName === 'gnd' || label.netName === '0';
            const virtualNetId = `label_net_${label.netName}`;
            pin.netId = virtualNetId;

            if (isGnd) {
              hasGround = true;
              netIdToCanonical.set(virtualNetId, '0');
              nodeMap.set(label.netName, '0');
            } else if (!netIdToCanonical.has(virtualNetId)) {
              const spiceNode = label.netName; // Use label name as node name
              netIdToCanonical.set(virtualNetId, spiceNode);
              nodeMap.set(label.netName, spiceNode);
            }
          }
        }
      }
    }
  }

  // ----- Ground check -----
  if (!hasGround) {
    errors.push('No ground node found. Add a GND net label.');
    return { netlist: '', nodeMap, errors, warnings };
  }

  // ----- Step 2: Map component pins to nodes -----
  // Helper to get SPICE node for a pin
  function getNodeForPin(pin: PinInstance): string | null {
    if (!pin.netId) return null;
    return netIdToCanonical.get(pin.netId) || null;
  }

  // ----- Step 3: Emit component lines -----
  const componentLines: string[] = [];

  for (const comp of allComponents) {
    // Skip power symbols (they're not real components — handled in Step 3b)
    if (comp.designator.startsWith('#PWR') || comp.libraryId?.startsWith('pwr_')) continue;

    const prefix = getDesignatorPrefix(comp.designator);

    if (!SUPPORTED_PREFIXES.has(prefix)) {
      warnings.push(`${comp.designator}: no SPICE model, skipping`);
      componentLines.push(`* ${comp.designator} (unsupported)`);
      continue;
    }

    const def = libraryMap.get(comp.libraryId);
    const pinDefs = def?.symbol.pins || [];

    // Get ordered pin nodes
    const pinNodes: Array<{ name: string; node: string | null; defId: string }> = [];
    for (const pin of comp.pins) {
      const node = getNodeForPin(pin);
      const pinDef = pinDefs.find(p => p.id === pin.definitionId);
      const pinName = pinDef?.name || pin.definitionId;
      pinNodes.push({ name: pinName, node, defId: pin.definitionId });
    }

    // Check for floating pins
    for (const pn of pinNodes) {
      if (!pn.node) {
        warnings.push(`${comp.designator} pin ${pn.name} is not connected`);
      }
    }

    // Parse the component value
    const spiceValue = parseSpiceValue(comp.value);

    // Emit based on prefix
    switch (prefix) {
      case 'R':
      case 'C':
      case 'L': {
        // Two-terminal: <designator> <pin1_node> <pin2_node> <value>
        const n1 = pinNodes[0]?.node || '0';
        const n2 = pinNodes[1]?.node || '0';
        componentLines.push(`${comp.designator} ${n1} ${n2} ${spiceValue}`);
        break;
      }
      case 'V':
      case 'I': {
        // Source: <designator> <+_node> <-_node> <value>
        // Pin order: first pin = +, second pin = -
        // For sources with named pins, try to find + and - pins
        let posNode: string;
        let negNode: string;

        const posPinIdx = pinNodes.findIndex(p =>
          p.name === '+' || p.name === 'plus' || p.name === 'p' || p.name === '1'
        );
        const negPinIdx = pinNodes.findIndex(p =>
          p.name === '-' || p.name === '−' || p.name === 'minus' || p.name === 'n' || p.name === '2'
        );

        if (posPinIdx >= 0 && negPinIdx >= 0) {
          posNode = pinNodes[posPinIdx].node || '0';
          negNode = pinNodes[negPinIdx].node || '0';
        } else {
          // Fall back to pin order
          posNode = pinNodes[0]?.node || '0';
          negNode = pinNodes[1]?.node || '0';
        }

        // If value doesn't start with a SPICE source keyword, prepend DC
        const upperValue = spiceValue.toUpperCase();
        const hasKeyword = ['DC', 'AC', 'PULSE', 'SIN', 'EXP', 'PWL', 'SFFM']
          .some(kw => upperValue.startsWith(kw));
        const sourceValue = hasKeyword ? spiceValue : `DC ${spiceValue}`;

        componentLines.push(`${comp.designator} ${posNode} ${negNode} ${sourceValue}`);
        break;
      }
      case 'D': {
        // Diode: D<name> <anode> <cathode> <model>
        // Pin order: first = Anode (A), second = Cathode (K)
        const anodePinIdx = pinNodes.findIndex(p =>
          p.name === 'Anode' || p.name === 'A' || p.name === '+' || p.name === '1'
        );
        const cathodePinIdx = pinNodes.findIndex(p =>
          p.name === 'Cathode' || p.name === 'K' || p.name === '-' || p.name === '2'
        );

        const anodeNode = anodePinIdx >= 0 ? (pinNodes[anodePinIdx].node || '0') : (pinNodes[0]?.node || '0');
        const cathodeNode = cathodePinIdx >= 0 ? (pinNodes[cathodePinIdx].node || '0') : (pinNodes[1]?.node || '0');

        // Determine model name based on value
        const dValue = comp.value.toLowerCase();
        let modelName: string;
        if (dValue.includes('led') || dValue === 'red' || dValue === 'green' || dValue === 'blue' ||
            dValue === 'white' || dValue === 'yellow' || dValue === 'orange') {
          modelName = 'DLED';
        } else if (dValue.includes('zener') || comp.libraryId === 'zener_generic') {
          modelName = 'DZENER';
        } else {
          modelName = 'DDEF';
        }
        componentLines.push(`${comp.designator} ${anodeNode} ${cathodeNode} ${modelName}`);
        break;
      }
      case 'Q': {
        // BJT: Q<name> <collector> <base> <emitter> <model>
        // MOSFET: M<name> <drain> <gate> <source> <body> <model>
        const isPNP = comp.libraryId === 'pnp_generic' || comp.value.toUpperCase().includes('PNP') || comp.value.includes('2N2907');
        const isMOS = comp.libraryId === 'nmos_generic' || comp.value.toUpperCase().includes('MOS') || comp.value.includes('2N7000');

        if (isMOS) {
          // MOSFET — M<name> <drain> <gate> <source> <body> <model>
          const drainIdx = pinNodes.findIndex(p => p.name === 'Drain' || p.name === 'D');
          const gateIdx = pinNodes.findIndex(p => p.name === 'Gate' || p.name === 'G');
          const sourceIdx = pinNodes.findIndex(p => p.name === 'Source' || p.name === 'S');

          const drain = drainIdx >= 0 ? (pinNodes[drainIdx].node || '0') : (pinNodes[0]?.node || '0');
          const gate = gateIdx >= 0 ? (pinNodes[gateIdx].node || '0') : (pinNodes[1]?.node || '0');
          const source = sourceIdx >= 0 ? (pinNodes[sourceIdx].node || '0') : (pinNodes[2]?.node || '0');

          componentLines.push(`M${comp.designator.slice(1)} ${drain} ${gate} ${source} ${source} NMOS`);
        } else {
          // BJT — Q<name> <collector> <base> <emitter> <model>
          const collIdx = pinNodes.findIndex(p => p.name === 'Collector' || p.name === 'C');
          const baseIdx = pinNodes.findIndex(p => p.name === 'Base' || p.name === 'B');
          const emitIdx = pinNodes.findIndex(p => p.name === 'Emitter' || p.name === 'E');

          const coll = collIdx >= 0 ? (pinNodes[collIdx].node || '0') : (pinNodes[0]?.node || '0');
          const base = baseIdx >= 0 ? (pinNodes[baseIdx].node || '0') : (pinNodes[1]?.node || '0');
          const emit = emitIdx >= 0 ? (pinNodes[emitIdx].node || '0') : (pinNodes[2]?.node || '0');

          const bjtModel = isPNP ? 'QPNP' : 'QNPN';
          componentLines.push(`${comp.designator} ${coll} ${base} ${emit} ${bjtModel}`);
        }
        break;
      }
    }
  }

  // ----- Step 3b: Emit synthetic voltage sources for power symbols -----
  // Power symbols (pwr_vcc, pwr_5v, pwr_3v3) are not real components but they
  // imply a voltage source driving their net. We emit one V source per unique
  // power rail so ngspice has something to simulate.
  const POWER_SOURCES: Record<string, { voltage: string; netName: string }> = {
    'pwr_vcc': { voltage: '5', netName: 'VCC' },
    'pwr_5v':  { voltage: '5', netName: '+5V' },
    'pwr_3v3': { voltage: '3.3', netName: '+3V3' },
  };

  const emittedPowerRails = new Set<string>();

  for (const comp of allComponents) {
    const powerDef = POWER_SOURCES[comp.libraryId];
    if (!powerDef) continue;
    if (emittedPowerRails.has(comp.libraryId)) continue; // Only one source per rail
    emittedPowerRails.add(comp.libraryId);

    // Find the SPICE node name for this power net
    let powerNode: string | null = null;

    // Check if a pin on this component has a net assigned
    for (const pin of comp.pins) {
      if (pin.netId) {
        powerNode = netIdToCanonical.get(pin.netId) || null;
        if (powerNode) break;
      }
    }

    // Fallback: use the expected net name (from labels or canonical mapping)
    if (!powerNode) {
      powerNode = nodeMap.get(powerDef.netName) || null;
    }

    // Last resort: create a node using the net name
    if (!powerNode) {
      powerNode = powerDef.netName;
      nodeMap.set(powerDef.netName, powerNode);
    }

    // Skip if the power node maps to ground (nonsensical)
    if (powerNode === '0') {
      warnings.push(`${comp.libraryId}: power rail node is ground, skipping source`);
      continue;
    }

    const sourceName = `V${comp.libraryId.replace('pwr_', '')}`;
    // For AC analysis, add an AC stimulus so ngspice has a signal to analyze
    const acSuffix = config.analysis === 'ac' ? ' AC 1' : '';
    componentLines.push(`${sourceName} ${powerNode} 0 DC ${powerDef.voltage}${acSuffix}`);
  }

  // ----- Step 4: Emit default SPICE models for semiconductors -----
  const modelLines: string[] = [];
  const netlistSoFar = componentLines.join('\n');

  if (netlistSoFar.includes(' DDEF'))  modelLines.push('.model DDEF D');
  if (netlistSoFar.includes(' DLED'))  modelLines.push('.model DLED D(IS=1e-20 N=1.8 BV=5 IBV=100u)');
  if (netlistSoFar.includes(' DZENER')) modelLines.push('.model DZENER D(IS=1e-12 BV=5.1 IBV=1m)');
  if (netlistSoFar.includes(' QNPN')) modelLines.push('.model QNPN NPN(BF=100 IS=1e-14)');
  if (netlistSoFar.includes(' QPNP')) modelLines.push('.model QPNP PNP(BF=100 IS=1e-14)');
  if (netlistSoFar.includes(' NMOS')) modelLines.push('.model NMOS NMOS(VTO=2 KP=0.5)');

  // ----- Step 5: Emit analysis command -----
  const analysisLine = buildAnalysisLine(config);

  // ----- Step 6: Assemble netlist -----
  // NOTE: We do NOT include .control/.endc blocks because eecircuit-engine
  // runs ngspice in shared/library mode where control blocks crash the WASM.
  // The engine handles 'run' internally via sim.runSim().
  const lines: string[] = [];
  lines.push(`* ${doc.name || 'Untitled Circuit'}`);
  lines.push('');

  if (componentLines.length > 0) {
    lines.push('* --- Components ---');
    lines.push(...componentLines);
    lines.push('');
  }

  if (modelLines.length > 0) {
    lines.push('* --- Models ---');
    lines.push(...modelLines);
    lines.push('');
  }

  lines.push('* --- Analysis ---');
  lines.push(analysisLine);
  lines.push('');

  lines.push('.end');

  const netlist = lines.join('\n');

  return { netlist, nodeMap, errors, warnings };
}

// ----- Helpers -----

/**
 * Extract the alphabetic prefix from a designator (e.g., "R1" → "R", "C12" → "C").
 */
function getDesignatorPrefix(designator: string): string {
  const match = designator.match(/^([A-Za-z]+)/);
  return match ? match[1] : '';
}

/**
 * Build the SPICE analysis command line.
 */
function buildAnalysisLine(config: SimulationConfig): string {
  switch (config.analysis) {
    case 'transient':
      return `.tran ${config.stepTime || '1u'} ${config.stopTime || '10m'}`;
    case 'ac':
      return `.ac ${config.acType || 'dec'} ${config.acPoints || 10} ${config.fStart || '1'} ${config.fStop || '1Meg'}`;
    case 'dc':
      return `.dc ${config.dcSource || 'V1'} ${config.dcStart || '0'} ${config.dcStop || '5'} ${config.dcStep || '0.1'}`;
    case 'op':
      return '.op';
  }
}

/**
 * Build SPICE .control block.
 */
function buildControlBlock(config: SimulationConfig): string {
  const lines: string[] = [];
  lines.push('.control');
  lines.push('run');

  switch (config.analysis) {
    case 'transient':
      lines.push('plot all');
      break;
    case 'ac':
      lines.push('plot all');
      break;
    case 'dc':
      lines.push('plot all');
      break;
    case 'op':
      lines.push('print all');
      break;
  }

  lines.push('.endc');
  return lines.join('\n');
}
