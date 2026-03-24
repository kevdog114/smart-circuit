// ============================================================
// Smart Circuit — Built-in Component Library
// ============================================================

import type { ComponentDefinition } from '../core/types';

export const builtinLibrary: ComponentDefinition[] = [
  // ───────────────────────────────────────────────────────────
  // PASSIVES
  // ───────────────────────────────────────────────────────────

  {
    id: 'res_generic', name: 'Resistor', description: 'Generic resistor',
    category: 'passives', designatorPrefix: 'R', defaultValue: '10kΩ',
    properties: {}, tags: ['passive'],
    symbol: {
      id: 'sym_res', name: 'Resistor', width: 60, height: 20,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -15 },
      valuePosition: { x: 0, y: 20 },
      pins: [
        { id: '1', name: '1', type: 'passive', position: { x: -30, y: 0 }, orientation: 'left', length: 10 },
        { id: '2', name: '2', type: 'passive', position: { x: 30, y: 0 }, orientation: 'right', length: 10 }
      ],
      graphics: [
        { type: 'rect', properties: { x: 0, y: 0, width: 40, height: 14, fill: '#2d2d44' } },
        { type: 'line', properties: { x1: -30, y1: 0, x2: -20, y2: 0 } },
        { type: 'line', properties: { x1: 20, y1: 0, x2: 30, y2: 0 } }
      ]
    }
  },

  {
    id: 'cap_generic', name: 'Capacitor', description: 'Generic capacitor',
    category: 'passives', designatorPrefix: 'C', defaultValue: '100nF',
    properties: {}, tags: ['passive'],
    symbol: {
      id: 'sym_cap', name: 'Capacitor', width: 30, height: 40,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -20 },
      valuePosition: { x: 0, y: 25 },
      pins: [
        { id: '1', name: '1', type: 'passive', position: { x: 0, y: -20 }, orientation: 'up', length: 10 },
        { id: '2', name: '2', type: 'passive', position: { x: 0, y: 20 }, orientation: 'down', length: 10 }
      ],
      graphics: [
        { type: 'line', properties: { x1: -10, y1: -4, x2: 10, y2: -4 } },
        { type: 'line', properties: { x1: -10, y1: 4, x2: 10, y2: 4 } },
        { type: 'line', properties: { x1: 0, y1: -20, x2: 0, y2: -4 } },
        { type: 'line', properties: { x1: 0, y1: 4, x2: 0, y2: 20 } }
      ]
    }
  },

  {
    id: 'cap_polarized', name: 'Electrolytic Cap', description: 'Polarized electrolytic capacitor',
    category: 'passives', designatorPrefix: 'C', defaultValue: '10µF',
    properties: {}, tags: ['passive', 'polarized'],
    symbol: {
      id: 'sym_cap_pol', name: 'Electrolytic Cap', width: 30, height: 40,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -25 },
      valuePosition: { x: 0, y: 30 },
      pins: [
        { id: '+', name: '+', type: 'passive', position: { x: 0, y: -20 }, orientation: 'up', length: 10 },
        { id: '-', name: '−', type: 'passive', position: { x: 0, y: 20 }, orientation: 'down', length: 10 }
      ],
      graphics: [
        // Straight plate (positive side)
        { type: 'line', properties: { x1: -10, y1: -4, x2: 10, y2: -4 } },
        // Curved plate (negative side) — approximated with polyline arc
        { type: 'polyline', properties: { points: [
          { x: -10, y: 4 }, { x: -6, y: 6 }, { x: 0, y: 7 }, { x: 6, y: 6 }, { x: 10, y: 4 }
        ] } },
        // Lead wires
        { type: 'line', properties: { x1: 0, y1: -20, x2: 0, y2: -4 } },
        { type: 'line', properties: { x1: 0, y1: 7, x2: 0, y2: 20 } },
        // Plus sign
        { type: 'text', properties: { x: 14, y: -8, text: '+', fontSize: 9 } }
      ]
    }
  },

  {
    id: 'ind_generic', name: 'Inductor', description: 'Generic inductor',
    category: 'passives', designatorPrefix: 'L', defaultValue: '10µH',
    properties: {}, tags: ['passive'],
    symbol: {
      id: 'sym_ind', name: 'Inductor', width: 60, height: 20,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -15 },
      valuePosition: { x: 0, y: 18 },
      pins: [
        { id: '1', name: '1', type: 'passive', position: { x: -30, y: 0 }, orientation: 'left', length: 10 },
        { id: '2', name: '2', type: 'passive', position: { x: 30, y: 0 }, orientation: 'right', length: 10 }
      ],
      graphics: [
        // Lead wires
        { type: 'line', properties: { x1: -30, y1: 0, x2: -20, y2: 0 } },
        { type: 'line', properties: { x1: 20, y1: 0, x2: 30, y2: 0 } },
        // Coil bumps (4 arcs approximated via polylines)
        { type: 'arc', properties: { cx: -15, cy: 0, r: 5, startAngle: Math.PI, endAngle: 0 } },
        { type: 'arc', properties: { cx: -5, cy: 0, r: 5, startAngle: Math.PI, endAngle: 0 } },
        { type: 'arc', properties: { cx: 5, cy: 0, r: 5, startAngle: Math.PI, endAngle: 0 } },
        { type: 'arc', properties: { cx: 15, cy: 0, r: 5, startAngle: Math.PI, endAngle: 0 } }
      ]
    }
  },

  // ───────────────────────────────────────────────────────────
  // SEMICONDUCTORS
  // ───────────────────────────────────────────────────────────

  {
    id: 'diode_generic', name: 'Diode', description: 'Generic diode',
    category: 'semiconductors', designatorPrefix: 'D', defaultValue: '1N4148',
    properties: {}, tags: ['semiconductor'],
    symbol: {
      id: 'sym_diode', name: 'Diode', width: 30, height: 40,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -25 },
      valuePosition: { x: 0, y: 30 },
      pins: [
        { id: 'A', name: 'Anode', type: 'passive', position: { x: 0, y: -20 }, orientation: 'up', length: 10 },
        { id: 'K', name: 'Cathode', type: 'passive', position: { x: 0, y: 20 }, orientation: 'down', length: 10 }
      ],
      graphics: [
        // Triangle (anode side, pointing down)
        { type: 'polygon', properties: { points: [
          { x: -10, y: -6 }, { x: 10, y: -6 }, { x: 0, y: 6 }
        ], fill: '#2d2d44' } },
        // Cathode bar
        { type: 'line', properties: { x1: -10, y1: 6, x2: 10, y2: 6 } },
        // Lead wires
        { type: 'line', properties: { x1: 0, y1: -20, x2: 0, y2: -6 } },
        { type: 'line', properties: { x1: 0, y1: 6, x2: 0, y2: 20 } }
      ]
    }
  },

  {
    id: 'zener_generic', name: 'Zener Diode', description: 'Zener diode',
    category: 'semiconductors', designatorPrefix: 'D', defaultValue: '5.1V',
    properties: {}, tags: ['semiconductor'],
    symbol: {
      id: 'sym_zener', name: 'Zener Diode', width: 30, height: 40,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -25 },
      valuePosition: { x: 0, y: 30 },
      pins: [
        { id: 'A', name: 'Anode', type: 'passive', position: { x: 0, y: -20 }, orientation: 'up', length: 10 },
        { id: 'K', name: 'Cathode', type: 'passive', position: { x: 0, y: 20 }, orientation: 'down', length: 10 }
      ],
      graphics: [
        // Triangle (anode side, pointing down)
        { type: 'polygon', properties: { points: [
          { x: -10, y: -6 }, { x: 10, y: -6 }, { x: 0, y: 6 }
        ], fill: '#2d2d44' } },
        // Zener bar (bent ends)
        { type: 'polyline', properties: { points: [
          { x: -13, y: 3 }, { x: -10, y: 6 }, { x: 10, y: 6 }, { x: 13, y: 9 }
        ] } },
        // Lead wires
        { type: 'line', properties: { x1: 0, y1: -20, x2: 0, y2: -6 } },
        { type: 'line', properties: { x1: 0, y1: 6, x2: 0, y2: 20 } }
      ]
    }
  },

  {
    id: 'led_generic', name: 'LED', description: 'Light-emitting diode',
    category: 'semiconductors', designatorPrefix: 'D', defaultValue: 'Red',
    properties: {}, tags: ['semiconductor'],
    symbol: {
      id: 'sym_led', name: 'LED', width: 30, height: 40,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -25 },
      valuePosition: { x: 0, y: 30 },
      pins: [
        { id: 'A', name: 'Anode', type: 'passive', position: { x: 0, y: -20 }, orientation: 'up', length: 10 },
        { id: 'K', name: 'Cathode', type: 'passive', position: { x: 0, y: 20 }, orientation: 'down', length: 10 }
      ],
      graphics: [
        // Triangle (pointing down)
        { type: 'polygon', properties: { points: [
          { x: -10, y: -5 }, { x: 10, y: -5 }, { x: 0, y: 8 }
        ], fill: '#2d2d44' } },
        // Cathode bar
        { type: 'line', properties: { x1: -10, y1: 8, x2: 10, y2: 8 } },
        // Lead wires
        { type: 'line', properties: { x1: 0, y1: -20, x2: 0, y2: -5 } },
        { type: 'line', properties: { x1: 0, y1: 8, x2: 0, y2: 20 } },
        // Light arrows (emission indicators)
        { type: 'line', properties: { x1: 8, y1: -4, x2: 14, y2: -10 } },
        { type: 'line', properties: { x1: 12, y1: -10, x2: 14, y2: -10 } },
        { type: 'line', properties: { x1: 14, y1: -10, x2: 14, y2: -8 } },
        { type: 'line', properties: { x1: 11, y1: -1, x2: 17, y2: -7 } },
        { type: 'line', properties: { x1: 15, y1: -7, x2: 17, y2: -7 } },
        { type: 'line', properties: { x1: 17, y1: -7, x2: 17, y2: -5 } }
      ]
    }
  },

  {
    id: 'npn_generic', name: 'NPN Transistor', description: 'NPN bipolar junction transistor',
    category: 'semiconductors', designatorPrefix: 'Q', defaultValue: '2N2222',
    properties: {}, tags: ['semiconductor', 'transistor'],
    symbol: {
      id: 'sym_npn', name: 'NPN BJT', width: 40, height: 60,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 15, y: -25 },
      valuePosition: { x: 15, y: 30 },
      pins: [
        { id: 'B', name: 'Base', type: 'input', position: { x: -20, y: 0 }, orientation: 'left', length: 10 },
        { id: 'C', name: 'Collector', type: 'output', position: { x: 20, y: -20 }, orientation: 'up', length: 10 },
        { id: 'E', name: 'Emitter', type: 'output', position: { x: 20, y: 20 }, orientation: 'down', length: 10 }
      ],
      graphics: [
        // Base vertical line
        { type: 'line', properties: { x1: -4, y1: -10, x2: -4, y2: 10 } },
        // Base lead
        { type: 'line', properties: { x1: -20, y1: 0, x2: -4, y2: 0 } },
        // Collector line
        { type: 'line', properties: { x1: -4, y1: -6, x2: 20, y2: -20 } },
        // Emitter line
        { type: 'line', properties: { x1: -4, y1: 6, x2: 20, y2: 20 } },
        // Emitter arrow (pointing away from base)
        { type: 'polygon', properties: { points: [
          { x: 20, y: 20 }, { x: 12, y: 14 }, { x: 16, y: 10 }
        ], fill: '#e2e2e2' } },
        // Circle (optional BJT body)
        { type: 'circle', properties: { cx: 4, cy: 0, r: 18 } }
      ]
    }
  },

  {
    id: 'pnp_generic', name: 'PNP Transistor', description: 'PNP bipolar junction transistor',
    category: 'semiconductors', designatorPrefix: 'Q', defaultValue: '2N2907',
    properties: {}, tags: ['semiconductor', 'transistor'],
    symbol: {
      id: 'sym_pnp', name: 'PNP BJT', width: 40, height: 60,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 15, y: -25 },
      valuePosition: { x: 15, y: 30 },
      pins: [
        { id: 'B', name: 'Base', type: 'input', position: { x: -20, y: 0 }, orientation: 'left', length: 10 },
        { id: 'C', name: 'Collector', type: 'output', position: { x: 20, y: 20 }, orientation: 'down', length: 10 },
        { id: 'E', name: 'Emitter', type: 'output', position: { x: 20, y: -20 }, orientation: 'up', length: 10 }
      ],
      graphics: [
        // Base vertical line
        { type: 'line', properties: { x1: -4, y1: -10, x2: -4, y2: 10 } },
        // Base lead
        { type: 'line', properties: { x1: -20, y1: 0, x2: -4, y2: 0 } },
        // Emitter line (top)
        { type: 'line', properties: { x1: -4, y1: -6, x2: 20, y2: -20 } },
        // Collector line (bottom)
        { type: 'line', properties: { x1: -4, y1: 6, x2: 20, y2: 20 } },
        // Emitter arrow (pointing toward base — PNP)
        { type: 'polygon', properties: { points: [
          { x: -4, y: -6 }, { x: 6, y: -14 }, { x: 8, y: -8 }
        ], fill: '#e2e2e2' } },
        // Circle (BJT body)
        { type: 'circle', properties: { cx: 4, cy: 0, r: 18 } }
      ]
    }
  },

  {
    id: 'nmos_generic', name: 'N-MOSFET', description: 'N-channel MOSFET',
    category: 'semiconductors', designatorPrefix: 'Q', defaultValue: '2N7000',
    properties: {}, tags: ['semiconductor', 'transistor', 'mosfet'],
    symbol: {
      id: 'sym_nmos', name: 'N-MOSFET', width: 40, height: 60,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 18, y: -25 },
      valuePosition: { x: 18, y: 30 },
      pins: [
        { id: 'G', name: 'Gate', type: 'input', position: { x: -20, y: 0 }, orientation: 'left', length: 10 },
        { id: 'D', name: 'Drain', type: 'passive', position: { x: 20, y: -20 }, orientation: 'up', length: 10 },
        { id: 'S', name: 'Source', type: 'passive', position: { x: 20, y: 20 }, orientation: 'down', length: 10 }
      ],
      graphics: [
        // Gate lead
        { type: 'line', properties: { x1: -20, y1: 0, x2: -6, y2: 0 } },
        // Gate insulator (vertical line)
        { type: 'line', properties: { x1: -6, y1: -10, x2: -6, y2: 10 } },
        // Channel (3 stubs)
        { type: 'line', properties: { x1: -2, y1: -10, x2: -2, y2: -4 } },
        { type: 'line', properties: { x1: -2, y1: -2, x2: -2, y2: 2 } },
        { type: 'line', properties: { x1: -2, y1: 4, x2: -2, y2: 10 } },
        // Drain connection
        { type: 'line', properties: { x1: -2, y1: -8, x2: 20, y2: -8 } },
        { type: 'line', properties: { x1: 20, y1: -20, x2: 20, y2: -8 } },
        // Source connection
        { type: 'line', properties: { x1: -2, y1: 8, x2: 20, y2: 8 } },
        { type: 'line', properties: { x1: 20, y1: 8, x2: 20, y2: 20 } },
        // Body connection (center to source)
        { type: 'line', properties: { x1: -2, y1: 0, x2: 20, y2: 0 } },
        { type: 'line', properties: { x1: 20, y1: 0, x2: 20, y2: 8 } },
        // Arrow on body (pointing inward = N-channel)
        { type: 'polygon', properties: { points: [
          { x: 6, y: 0 }, { x: 2, y: -3 }, { x: 2, y: 3 }
        ], fill: '#e2e2e2' } }
      ]
    }
  },

  // ───────────────────────────────────────────────────────────
  // ICs / ANALOG
  // ───────────────────────────────────────────────────────────

  {
    id: 'ic_generic', name: 'IC', description: 'Generic integrated circuit',
    category: 'ics_digital', designatorPrefix: 'U', defaultValue: 'IC',
    properties: {}, tags: ['ic'],
    symbol: {
      id: 'sym_ic', name: 'IC', width: 80, height: 60,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -35 },
      valuePosition: { x: 0, y: 40 },
      pins: [
        { id: '1', name: 'VIN', type: 'power', position: { x: -40, y: -15 }, orientation: 'left', length: 10 },
        { id: '2', name: 'GND', type: 'power', position: { x: -40, y: 15 }, orientation: 'left', length: 10 },
        { id: '3', name: 'OUT', type: 'output', position: { x: 40, y: 0 }, orientation: 'right', length: 10 }
      ],
      graphics: [
        { type: 'rect', properties: { x: 0, y: 0, width: 60, height: 50, fill: '#2d2d44' } }
      ]
    }
  },

  {
    id: 'opamp_generic', name: 'Op-Amp', description: 'Operational amplifier',
    category: 'ics_analog', designatorPrefix: 'U', defaultValue: 'LM358',
    properties: {}, tags: ['ic', 'analog', 'opamp'],
    symbol: {
      id: 'sym_opamp', name: 'Op-Amp', width: 60, height: 60,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -35 },
      valuePosition: { x: 0, y: 40 },
      pins: [
        { id: '+in', name: '+', type: 'input', position: { x: -40, y: 10 }, orientation: 'left', length: 10 },
        { id: '-in', name: '−', type: 'input', position: { x: -40, y: -10 }, orientation: 'left', length: 10 },
        { id: 'out', name: 'Out', type: 'output', position: { x: 40, y: 0 }, orientation: 'right', length: 10 },
        { id: 'V+', name: 'V+', type: 'power', position: { x: 0, y: -20 }, orientation: 'up', length: 10 },
        { id: 'V-', name: 'V−', type: 'power', position: { x: 0, y: 20 }, orientation: 'down', length: 10 }
      ],
      graphics: [
        // Triangle body
        { type: 'polygon', properties: { points: [
          { x: -20, y: -25 }, { x: -20, y: 25 }, { x: 25, y: 0 }
        ], fill: '#2d2d44' } },
        // Input lead wires
        { type: 'line', properties: { x1: -40, y1: -10, x2: -20, y2: -10 } },
        { type: 'line', properties: { x1: -40, y1: 10, x2: -20, y2: 10 } },
        // Output lead wire
        { type: 'line', properties: { x1: 25, y1: 0, x2: 40, y2: 0 } },
        // "−" label (non-inverting)
        { type: 'text', properties: { x: -14, y: -7, text: '−', fontSize: 12 } },
        // "+" label (inverting)
        { type: 'text', properties: { x: -14, y: 13, text: '+', fontSize: 12 } }
      ]
    }
  },

  // ───────────────────────────────────────────────────────────
  // CONNECTORS
  // ───────────────────────────────────────────────────────────

  {
    id: 'header_1x2', name: '2-Pin Header', description: '1×2 pin header connector',
    category: 'connectors', designatorPrefix: 'J', defaultValue: '1×2',
    properties: {}, tags: ['connector', 'header'],
    symbol: {
      id: 'sym_hdr2', name: '2-Pin Header', width: 60, height: 40,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -25 },
      valuePosition: { x: 0, y: 30 },
      pins: [
        { id: '1', name: '1', type: 'passive', position: { x: -40, y: -10 }, orientation: 'left', length: 10 },
        { id: '2', name: '2', type: 'passive', position: { x: -40, y: 10 }, orientation: 'left', length: 10 }
      ],
      graphics: [
        { type: 'rect', properties: { x: 0, y: 0, width: 40, height: 40, fill: '#2d2d44' } },
        // Pin labels
        { type: 'text', properties: { x: 0, y: -7, text: '1', fontSize: 9 } },
        { type: 'text', properties: { x: 0, y: 13, text: '2', fontSize: 9 } },
        // Lead wires
        { type: 'line', properties: { x1: -40, y1: -10, x2: -20, y2: -10 } },
        { type: 'line', properties: { x1: -40, y1: 10, x2: -20, y2: 10 } }
      ]
    }
  },

  {
    id: 'header_1x4', name: '4-Pin Header', description: '1×4 pin header connector',
    category: 'connectors', designatorPrefix: 'J', defaultValue: '1×4',
    properties: {}, tags: ['connector', 'header'],
    symbol: {
      id: 'sym_hdr4', name: '4-Pin Header', width: 60, height: 80,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -45 },
      valuePosition: { x: 0, y: 50 },
      pins: [
        { id: '1', name: '1', type: 'passive', position: { x: -40, y: -30 }, orientation: 'left', length: 10 },
        { id: '2', name: '2', type: 'passive', position: { x: -40, y: -10 }, orientation: 'left', length: 10 },
        { id: '3', name: '3', type: 'passive', position: { x: -40, y: 10 }, orientation: 'left', length: 10 },
        { id: '4', name: '4', type: 'passive', position: { x: -40, y: 30 }, orientation: 'left', length: 10 }
      ],
      graphics: [
        { type: 'rect', properties: { x: 0, y: 0, width: 40, height: 80, fill: '#2d2d44' } },
        // Pin labels
        { type: 'text', properties: { x: 0, y: -27, text: '1', fontSize: 9 } },
        { type: 'text', properties: { x: 0, y: -7, text: '2', fontSize: 9 } },
        { type: 'text', properties: { x: 0, y: 13, text: '3', fontSize: 9 } },
        { type: 'text', properties: { x: 0, y: 33, text: '4', fontSize: 9 } },
        // Lead wires
        { type: 'line', properties: { x1: -40, y1: -30, x2: -20, y2: -30 } },
        { type: 'line', properties: { x1: -40, y1: -10, x2: -20, y2: -10 } },
        { type: 'line', properties: { x1: -40, y1: 10, x2: -20, y2: 10 } },
        { type: 'line', properties: { x1: -40, y1: 30, x2: -20, y2: 30 } }
      ]
    }
  },

  // ───────────────────────────────────────────────────────────
  // SOURCES (for SPICE simulation)
  // ───────────────────────────────────────────────────────────

  {
    id: 'vsource_ac', name: 'Voltage Source', description: 'AC/DC voltage source for simulation',
    category: 'sources', designatorPrefix: 'V', defaultValue: 'AC 1',
    properties: {}, tags: ['source', 'simulation'],
    symbol: {
      id: 'sym_vsrc', name: 'Voltage Source', width: 30, height: 50,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 20, y: -10 },
      valuePosition: { x: 20, y: 10 },
      pins: [
        { id: '+', name: '+', type: 'passive', position: { x: 0, y: -25 }, orientation: 'up', length: 10 },
        { id: '-', name: '−', type: 'passive', position: { x: 0, y: 25 }, orientation: 'down', length: 10 }
      ],
      graphics: [
        // Circle body
        { type: 'circle', properties: { cx: 0, cy: 0, r: 14 } },
        // Lead wires
        { type: 'line', properties: { x1: 0, y1: -25, x2: 0, y2: -14 } },
        { type: 'line', properties: { x1: 0, y1: 14, x2: 0, y2: 25 } },
        // Sine wave inside circle (approximated with polyline)
        { type: 'polyline', properties: { points: [
          { x: -8, y: 0 }, { x: -5, y: -6 }, { x: 0, y: 0 }, { x: 5, y: 6 }, { x: 8, y: 0 }
        ] } },
        // + and - labels
        { type: 'text', properties: { x: 0, y: -18, text: '+', fontSize: 8 } },
        { type: 'text', properties: { x: 0, y: 22, text: '−', fontSize: 8 } }
      ]
    }
  },

  // ───────────────────────────────────────────────────────────
  // POWER SYMBOLS
  // ───────────────────────────────────────────────────────────

  {
    id: 'pwr_gnd', name: 'GND', description: 'Ground power symbol',
    category: 'power', designatorPrefix: '#PWR', defaultValue: 'GND',
    properties: {}, tags: ['power'],
    symbol: {
      id: 'sym_gnd', name: 'GND', width: 20, height: 20,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: 20 },
      valuePosition: { x: 0, y: 20 },
      pins: [
        { id: '1', name: 'GND', type: 'power', position: { x: 0, y: -10 }, orientation: 'up', length: 10 }
      ],
      graphics: [
        { type: 'line', properties: { x1: 0, y1: -10, x2: 0, y2: 0 } },
        { type: 'line', properties: { x1: -12, y1: 0, x2: 12, y2: 0 } },
        { type: 'line', properties: { x1: -8, y1: 4, x2: 8, y2: 4 } },
        { type: 'line', properties: { x1: -4, y1: 8, x2: 4, y2: 8 } }
      ]
    }
  },

  {
    id: 'pwr_vcc', name: 'VCC', description: 'VCC power symbol',
    category: 'power', designatorPrefix: '#PWR', defaultValue: 'VCC',
    properties: {}, tags: ['power'],
    symbol: {
      id: 'sym_vcc', name: 'VCC', width: 20, height: 20,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -15 },
      valuePosition: { x: 0, y: -15 },
      pins: [
        { id: '1', name: 'VCC', type: 'power', position: { x: 0, y: 10 }, orientation: 'down', length: 10 }
      ],
      graphics: [
        { type: 'line', properties: { x1: 0, y1: 10, x2: 0, y2: 0 } },
        { type: 'line', properties: { x1: -8, y1: 0, x2: 0, y2: -8 } },
        { type: 'line', properties: { x1: 0, y1: -8, x2: 8, y2: 0 } }
      ]
    }
  },

  {
    id: 'pwr_3v3', name: '+3V3', description: '+3.3V power rail',
    category: 'power', designatorPrefix: '#PWR', defaultValue: '+3V3',
    properties: {}, tags: ['power'],
    symbol: {
      id: 'sym_3v3', name: '+3V3', width: 20, height: 20,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -15 },
      valuePosition: { x: 0, y: -15 },
      pins: [
        { id: '1', name: '+3V3', type: 'power', position: { x: 0, y: 10 }, orientation: 'down', length: 10 }
      ],
      graphics: [
        { type: 'line', properties: { x1: 0, y1: 10, x2: 0, y2: 0 } },
        { type: 'line', properties: { x1: -8, y1: 0, x2: 0, y2: -8 } },
        { type: 'line', properties: { x1: 0, y1: -8, x2: 8, y2: 0 } },
        { type: 'text', properties: { x: 0, y: -14, text: '+3V3', fontSize: 9 } }
      ]
    }
  },

  {
    id: 'pwr_5v', name: '+5V', description: '+5V power rail',
    category: 'power', designatorPrefix: '#PWR', defaultValue: '+5V',
    properties: {}, tags: ['power'],
    symbol: {
      id: 'sym_5v', name: '+5V', width: 20, height: 20,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -15 },
      valuePosition: { x: 0, y: -15 },
      pins: [
        { id: '1', name: '+5V', type: 'power', position: { x: 0, y: 10 }, orientation: 'down', length: 10 }
      ],
      graphics: [
        { type: 'line', properties: { x1: 0, y1: 10, x2: 0, y2: 0 } },
        { type: 'line', properties: { x1: -8, y1: 0, x2: 0, y2: -8 } },
        { type: 'line', properties: { x1: 0, y1: -8, x2: 8, y2: 0 } },
        { type: 'text', properties: { x: 0, y: -14, text: '+5V', fontSize: 9 } }
      ]
    }
  }
];
