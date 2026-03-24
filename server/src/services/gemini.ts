import { GoogleGenAI, Type } from '@google/genai';
import { promises as fs } from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'gemini.log');

async function logGemini(endpoint: string, request: unknown, response: unknown) {
  try {
    const timestamp = new Date().toISOString();
    const logEntry = `\n--- [${timestamp}] ${endpoint} ---\nREQUEST:\n${JSON.stringify(request, null, 2)}\n\nRESPONSE:\n${JSON.stringify(response, null, 2)}\n----------------------------------------\n`;
    await fs.appendFile(LOG_FILE, logEntry, 'utf8');
  } catch (err) {
    console.error('[Gemini] Failed to write log:', err);
  }
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface CircuitContext {
  components?: { designator: string; value: string; libraryId: string; pins?: string[] }[];
  nets?: { name: string; pins: string[] }[];
  currentSheet?: string;
  pcbLayout?: {
    board: { width: number; height: number };
    placedComponents: { designator: string; x: number; y: number; layer: string }[];
    unplacedCount: number;
  } | null;
}

interface StreamCallbacks {
  onText: (text: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

const JLCPCB_API = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood';
const JLCSEARCH_BASE = 'https://jlcsearch.tscircuit.com';

const SYSTEM_PROMPT = `You are an expert electronics design assistant integrated into Smart Circuit, a web-based schematic editor. You help users design circuits by:

1. Recommending components based on requirements
2. Generating subcircuits with proper supporting components
3. Reviewing designs for common errors
4. Answering electronics questions
5. Mapping schematic components to real JLCPCB parts for manufacturing
6. Auto-placing components on the PCB board based on circuit topology

CONTEXT: You will receive the current circuit state including all components, nets, and connections. Use this to give contextual advice.

CONSTRAINTS:
- Prefer commonly available JLCPCB parts
- Always include required decoupling capacitors
- Consider thermal requirements
- Suggest alternatives when a part may be hard to source
- Use standard designator prefixes (R, C, U, D, Q, L, etc.)

IMPORTANT — AVAILABLE LIBRARY COMPONENTS:
The following libraryId values are available. You MUST use one of these when adding components:
- "res_generic" — Resistor (pins: 1, 2)
- "cap_generic" — Capacitor (pins: 1, 2)
- "cap_polarized" — Electrolytic Capacitor (pins: +, -)
- "ind_generic" — Inductor (pins: 1, 2)
- "diode_generic" — Diode (pins: A, K)
- "zener_generic" — Zener Diode (pins: A, K)
- "led_generic" — LED (pins: A, K)
- "npn_generic" — NPN Transistor (pins: B, C, E)
- "pnp_generic" — PNP Transistor (pins: B, C, E)
- "nmos_generic" — N-MOSFET (pins: G, D, S)
- "ic_generic" — Generic IC (pins: VIN, GND, OUT) — only as fallback; prefer using "mpn" for real ICs
- "opamp_generic" — Op-Amp (pins: +in, -in, out, V+, V-)
- "header_1x2" — 2-Pin Header (pins: 1, 2)
- "header_1x4" — 4-Pin Header (pins: 1, 2, 3, 4)
- "vsource_ac" — Voltage Source for simulation (pins: +, -). Value is SPICE source spec, e.g. "DC 5", "AC 1", "DC 5 AC 1", "PULSE(0 5 0 1n 1n 5u 10u)", "SIN(0 1 1k)"
- "pwr_gnd" — GND power symbol (pin: GND)
- "pwr_vcc" — VCC power symbol (pin: VCC)
- "pwr_3v3" — +3.3V power symbol (pin: +3V3)
- "pwr_5v" — +5V power symbol (pin: +5V)

IMPORTANT — POWER SUPPLY:
- For schematic power rails, use power symbols: "pwr_vcc", "pwr_5v", "pwr_3v3", and "pwr_gnd". These automatically generate voltage sources in simulation.
- For circuits intended for SPICE simulation (e.g. "test with ngspice", "simulate", "frequency response"), use "vsource_ac" instead. It gives the user explicit control over the source parameters.
- Power symbols MUST use the "#PWR" designator prefix (e.g. "#PWR1", "#PWR2"). Voltage sources use "V" prefix (e.g. "V1", "V2").
- Connect power symbols/voltage sources to component pins using the connections array with a netName (e.g. "VCC", "GND").
- For example, to build a simulatable RC filter: add a vsource_ac (designator "V1", value "AC 1"), connect V1 pin "+" to R1 pin "1", and connect V1 pin "-" to GND via a pwr_gnd symbol.

IMPORTANT — JLCPCB PART MAPPING:
- When asked to recommend or assign JLCPCB parts to components, use the map_jlcpcb_part tool
- The tool will search JLCPCB and return available parts — pick the best match based on value, package, and stock
- You can map multiple components in one response by calling the tool multiple times
- Prefer "Basic" parts over "Extended" for lower assembly fees
- Consider package size appropriateness (e.g. 0402/0603 for compact designs, 0805 for hand-soldering)

IMPORTANT — IC COMPONENTS:
- When adding any IC (designator U*), you MUST include the "mpn" field with a real manufacturer part number (e.g. "NE555DR", "LM7805CT", "ATmega328P-AU")
- The system uses the MPN to automatically look up the correct pin definitions from the JLCPCB/EasyEDA library
- Also include a "pins" array as fallback, listing every physical pin with its name and electrical type
- Pin types: "input", "output", "bidirectional", "passive", "power"
- Always list ALL pins including power pins (VCC, GND, etc.)
- Reference your pin names in the connections array

IMPORTANT — PIN NAMES:
- When the circuit context lists pin names for a component, you MUST use those EXACT pin names in your connections array
- Do NOT guess or use alternative pin names (e.g. use "RST" not "RESET" if the pin is listed as "RST")
- For new components you are adding, reference the pin names you provide in the "pins" array

IMPORTANT — NET LABELS:
- When generating netlabels (via the "netName" field in connections) for a power component or net, use short names like GND, +3V3, +5V, +3V3D, VCC, etc.

IMPORTANT — SUBCIRCUIT LAYOUT:
When using add_subcircuit, provide x, y coordinates and rotation for EVERY component to suggest schematic placement:
- Use a grid of multiples of 10 (e.g. 0, 10, 20, 100, 200)
- Place the main IC near center (e.g. x:0, y:0)
- Arrange input-side components (connectors, input caps) to the LEFT of the IC (negative x)
- Arrange output-side components (output caps, load resistors) to the RIGHT (positive x)
- Keep decoupling capacitors close to their associated IC power pins
- Follow left-to-right signal flow
- Use rotation 0 for horizontal components, 90 for vertical. Passives like capacitors often look best at rotation 0 or 90 depending on context
- Space components at least 120 units apart to leave room for wires
- Example: IC at (0,0), input cap at (-200, 0), output cap at (200, 0), decoupling cap at (0, -120)

IMPORTANT — PCB LAYOUT:
When using layout_pcb_components, follow these rules to ensure the JSON response is valid:
- MUST use only whole integer numbers for x and y coordinates (e.g., 10, 25, -5). Do not use decimals or floating-point numbers.
- Ensure x and y keep components within the board dimensions (default 100x80).
- Layer must be either "F.Cu" (top) or "B.Cu" (bottom). Use "F.Cu" by default.
- Group related components (e.g., decoupling caps near their ICs, keeping power paths short).`;

const TOOL_DECLARATIONS = [
  {
    name: 'add_component',
    description: 'Add a component to the schematic',
    parameters: {
      type: Type.OBJECT,
      properties: {
        libraryId: { type: Type.STRING, description: 'Component library ID' },
        designator: { type: Type.STRING, description: 'e.g. "R1", "U3"' },
        value: { type: Type.STRING, description: 'e.g. "10kΩ", "AMS1117-3.3"' },
        mpn: { type: Type.STRING, description: 'Manufacturer part number for ICs, e.g. "NE555DR"' },
        pins: {
          type: Type.ARRAY,
          description: 'Fallback pin definitions for ICs (used if MPN lookup fails)',
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING, description: 'Pin name, e.g. "VCC", "GND", "OUT"' },
              type: { type: Type.STRING, description: 'Pin type: input, output, bidirectional, passive, power' }
            },
            required: ['name', 'type']
          }
        },
        sheet: { type: Type.STRING, description: 'Target sheet name' }
      },
      required: ['designator', 'value']
    }
  },
  {
    name: 'add_subcircuit',
    description: 'Add a group of connected components',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'Subcircuit name' },
        components: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              designator: { type: Type.STRING },
              value: { type: Type.STRING },
              libraryId: { type: Type.STRING },
              mpn: { type: Type.STRING, description: 'Manufacturer part number for ICs' },
              x: { type: Type.INTEGER, description: 'Suggested X position for schematic layout (grid of 10)' },
              y: { type: Type.INTEGER, description: 'Suggested Y position for schematic layout (grid of 10)' },
              rotation: { type: Type.INTEGER, description: 'Rotation in degrees: 0, 90, 180, or 270' },
              pins: {
                type: Type.ARRAY,
                description: 'Fallback pin definitions for ICs',
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    type: { type: Type.STRING }
                  },
                  required: ['name', 'type']
                }
              }
            },
            required: ['designator', 'value']
          }
        },
        connections: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              fromDesignator: { type: Type.STRING },
              fromPin: { type: Type.STRING },
              toDesignator: { type: Type.STRING },
              toPin: { type: Type.STRING },
              netName: { type: Type.STRING }
            },
            required: ['fromDesignator', 'fromPin', 'toDesignator', 'toPin']
          }
        }
      },
      required: ['name', 'components']
    }
  },
  {
    name: 'modify_component',
    description: 'Change a property of an existing component',
    parameters: {
      type: Type.OBJECT,
      properties: {
        designator: { type: Type.STRING, description: 'Which component to modify' },
        newValue: { type: Type.STRING, description: 'New value' },
        newFootprint: { type: Type.STRING, description: 'New footprint' }
      },
      required: ['designator']
    }
  },
  {
    name: 'remove_component',
    description: 'Remove a component and its connections',
    parameters: {
      type: Type.OBJECT,
      properties: {
        designator: { type: Type.STRING }
      },
      required: ['designator']
    }
  },
  {
    name: 'map_jlcpcb_part',
    description: 'Search JLCPCB for a component and associate the best matching part with a schematic component. Returns search results from JLCPCB with pricing and stock info. Use this when the user asks to recommend, assign, or map JLCPCB parts to their components.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        designator: { type: Type.STRING, description: 'The designator of the component to map, e.g. "R1", "C3", "U2"' },
        searchQuery: { type: Type.STRING, description: 'Search query for JLCPCB, e.g. "10K 0603 resistor", "100nF capacitor", "AMS1117-3.3"' },
        packageFilter: { type: Type.STRING, description: 'Optional package filter, e.g. "0603", "0805", "SOT-23"' },
        selectedLcsc: { type: Type.STRING, description: 'The LCSC part number selected from search results, e.g. "C25804". Only set this after reviewing search results.' }
      },
      required: ['designator', 'searchQuery']
    }
  },
  {
    name: 'layout_pcb_components',
    description: 'Place components on the PCB board in a layout optimized for the circuit topology. Groups related components together (e.g. power supply section, analog section, digital section), minimizes trace lengths between connected components, and follows PCB design best practices. Decoupling capacitors should be placed near their associated ICs. Power components should be kept separate from sensitive analog circuitry.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        boardWidth: { type: Type.INTEGER, description: 'Board width in mm (default 100)' },
        boardHeight: { type: Type.INTEGER, description: 'Board height in mm (default 80)' },
        placements: {
          type: Type.ARRAY,
          description: 'List of components and their X/Y placements on the board',
          items: {
            type: Type.OBJECT,
            properties: {
              designator: { type: Type.STRING, description: 'Component designator, e.g. R1, U1' },
              x: { type: Type.INTEGER, description: 'X coordinate' },
              y: { type: Type.INTEGER, description: 'Y coordinate' },
              rotation: { type: Type.INTEGER, description: 'Rotation in degrees (0, 90, 180, 270)' },
              layer: { type: Type.STRING, description: 'Layer: F.Cu or B.Cu' }
            },
            required: ['designator', 'x', 'y']
          }
        }
      },
      required: ['placements']
    }
  }
];

export class GeminiService {
  private getClient() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
    return new GoogleGenAI({ apiKey });
  }

  async streamChat(messages: ChatMessage[], circuitContext: CircuitContext | undefined, callbacks: StreamCallbacks): Promise<void> {
    const client = this.getClient();

    const contextStr = circuitContext ? this.buildContextString(circuitContext) : '';
    const systemInstruction = SYSTEM_PROMPT + (contextStr ? `\n\n## Current Circuit State\n${contextStr}` : '');

    // Convert messages to Gemini format
    const contents: { role: 'user' | 'model'; parts: Record<string, unknown>[] }[] = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' as const : 'user' as const,
        parts: [{ text: m.content }]
      }));

    const streamConfig = {
      systemInstruction,
      temperature: 0.3,
      tools: [{ functionDeclarations: TOOL_DECLARATIONS as any }],
      thinkingConfig: { thinkingBudget: 16384 },
    };

    try {
      const response = await client.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents,
        config: streamConfig,
      });

      // Collect function calls from the stream so we can auto-respond
      const collectedFunctionCalls: { name: string; args: Record<string, unknown>; id?: string }[] = [];
      let fullResponseText = '';

      let chunkCount = 0;
      let lastFinishReason = '';
      let emittedAnyContent = false;
      let rawChunks: any[] = []; // Store raw chunks for debugging malformed calls
      let lastUsageMetadata: any = null;

      for await (const chunk of response) {
        chunkCount++;
        rawChunks.push(chunk);
        if (chunk.usageMetadata) lastUsageMetadata = chunk.usageMetadata;
        
        const candidate = chunk.candidates?.[0];
        const finishReason = candidate?.finishReason;
        if (finishReason) {
          lastFinishReason = finishReason;
          if (finishReason !== 'STOP') {
            console.warn(`[Gemini] Non-STOP finishReason: ${finishReason}`);
            if (finishReason === 'MALFORMED_FUNCTION_CALL') {
              console.warn(`[Gemini] Raw chunk leading to MALFORMED_FUNCTION_CALL:`, JSON.stringify(chunk, null, 2));
            }
          }
        }
        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts) {
            if ((part as any).thought) {
              // Thinking part — skip silently
              continue;
            }
            if (part.text) {
              fullResponseText += part.text;
              emittedAnyContent = true;
              callbacks.onText(part.text);
            }
            if (part.functionCall && part.functionCall.name) {
              emittedAnyContent = true;
              const fc = {
                name: part.functionCall.name,
                args: (part.functionCall.args || {}) as Record<string, unknown>,
                id: (part.functionCall as any).id,
              };
              collectedFunctionCalls.push(fc);
              console.log(`[Gemini] Tool call: ${fc.name}`, JSON.stringify(fc.args).slice(0, 500));
              callbacks.onToolCall(fc.name, fc.args);
            }
          }
        }
      }
      console.log(`[Gemini] Stream completed: ${chunkCount} chunks, ${collectedFunctionCalls.length} function calls, finishReason: ${lastFinishReason}`);
      if (lastUsageMetadata) {
        console.log(`[Gemini] Tokens — prompt: ${lastUsageMetadata.promptTokenCount ?? '?'}, candidates: ${lastUsageMetadata.candidatesTokenCount ?? '?'}, thoughts: ${lastUsageMetadata.thoughtsTokenCount ?? '?'}, total: ${lastUsageMetadata.totalTokenCount ?? '?'}`);
      }

      // Handle MALFORMED_FUNCTION_CALL: retry with a hint to simplify
      if (lastFinishReason === 'MALFORMED_FUNCTION_CALL' && !emittedAnyContent) {
        console.log('[Gemini] Retrying with simplified prompt after MALFORMED_FUNCTION_CALL...');
        const retryContents = [
          ...contents,
          {
            role: 'user' as const,
            parts: [{
              text: 'IMPORTANT: Your previous function call was malformed and could not be parsed. ' +
                'Please try again and ensure all JSON values are properly formatted. ' +
                'If you are adding a subcircuit, simplify the connections. ' +
                'If you are placing PCB components, double-check that all X/Y coordinates are valid numbers.'
            }],
          },
        ];

        try {
          const retryResponse = await client.models.generateContentStream({
            model: 'gemini-flash-latest',
            contents: retryContents,
            config: streamConfig,
          });

          let retryUsage: any = null;
          for await (const chunk of retryResponse) {
            if (chunk.usageMetadata) retryUsage = chunk.usageMetadata;
            const candidate = chunk.candidates?.[0];
            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if ((part as any).thought) continue;
                if (part.text) {
                  fullResponseText += part.text;
                  emittedAnyContent = true;
                  callbacks.onText(part.text);
                }
                if (part.functionCall && part.functionCall.name) {
                  emittedAnyContent = true;
                  const fc = {
                    name: part.functionCall.name,
                    args: (part.functionCall.args || {}) as Record<string, unknown>,
                    id: (part.functionCall as any).id,
                  };
                  collectedFunctionCalls.push(fc);
                  console.log(`[Gemini] Retry tool call: ${fc.name}`, JSON.stringify(fc.args).slice(0, 200));
                  callbacks.onToolCall(fc.name, fc.args);
                }
              }
            }
          }
          if (retryUsage) {
            console.log(`[Gemini] Retry tokens — prompt: ${retryUsage.promptTokenCount ?? '?'}, candidates: ${retryUsage.candidatesTokenCount ?? '?'}, thoughts: ${retryUsage.thoughtsTokenCount ?? '?'}, total: ${retryUsage.totalTokenCount ?? '?'}`);
          }
        } catch (retryErr) {
          console.warn('[Gemini] Retry threw error:', retryErr);
        }

        if (!emittedAnyContent) {
          const fallback = '⚠️ I tried to process your request but the generated data was too complex and failed. Try asking for a simpler version first, or do it in smaller steps.';
          fullResponseText += fallback;
          callbacks.onText(fallback);
          emittedAnyContent = true;
        }
      }

      // If the model produced function calls, send back functionResponse
      // and make a follow-up call so the model can produce its text summary.
      if (collectedFunctionCalls.length > 0) {
        // Build the model turn that contained the function calls
        const modelFunctionCallParts = collectedFunctionCalls.map(fc => ({
          functionCall: { name: fc.name, args: fc.args, ...(fc.id ? { id: fc.id } : {}) },
        }));

        // Execute server-side tool calls (e.g. JLCPCB search) and build responses
        const functionResponseParts = await Promise.all(collectedFunctionCalls.map(async fc => {
          let response: Record<string, unknown> = { success: true, message: `${fc.name} executed successfully` };

          // Execute JLCPCB search for map_jlcpcb_part calls
          if (fc.name === 'map_jlcpcb_part') {
            try {
              response = await this.executeJlcpcbSearch(
                fc.args.searchQuery as string,
                fc.args.packageFilter as string | undefined
              );
            } catch (err) {
              response = { success: false, error: `JLCPCB search failed: ${err instanceof Error ? err.message : 'unknown'}` };
            }
          }

          return {
            functionResponse: {
              name: fc.name,
              ...(fc.id ? { id: fc.id } : {}),
              response,
            },
          };
        }));

        // Extend the conversation: model's function call turn + our function response turn
        const followUpContents = [
          ...contents,
          { role: 'model' as const, parts: modelFunctionCallParts },
          { role: 'user' as const, parts: functionResponseParts },
        ];

        try {
          const followUp = await client.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: followUpContents,
            config: streamConfig,
          });

          let followUpUsage: any = null;
          for await (const chunk of followUp) {
            if (chunk.usageMetadata) followUpUsage = chunk.usageMetadata;
            if (chunk.candidates?.[0]?.content?.parts) {
              for (const part of chunk.candidates[0].content.parts) {
                if ((part as any).thought) continue;
                if (part.text) {
                  fullResponseText += part.text;
                  callbacks.onText(part.text);
                }
                // If the model calls more functions in the follow-up,
                // emit them but don't recurse further to avoid infinite loops.
                // Skip map_jlcpcb_part — the initial call already created the card
                // with cached search results; follow-up calls are duplicates.
                if (part.functionCall && part.functionCall.name && part.functionCall.name !== 'map_jlcpcb_part') {
                  callbacks.onToolCall(
                    part.functionCall.name,
                    (part.functionCall.args || {}) as Record<string, unknown>
                  );
                }
              }
            }
          }
          if (followUpUsage) {
            console.log(`[Gemini] Follow-up tokens — prompt: ${followUpUsage.promptTokenCount ?? '?'}, candidates: ${followUpUsage.candidatesTokenCount ?? '?'}, thoughts: ${followUpUsage.thoughtsTokenCount ?? '?'}, total: ${followUpUsage.totalTokenCount ?? '?'}`);
          }
        } catch (followUpErr) {
          // Don't fail the whole request if the follow-up text fails
          console.warn('[Gemini] Follow-up text generation failed:', followUpErr);
        }
      }

      const logPayload: any = { text: fullResponseText, toolCalls: collectedFunctionCalls };
      if (lastFinishReason === 'MALFORMED_FUNCTION_CALL') {
        logPayload.malformedChunks = rawChunks.filter(c => c.candidates?.[0]?.finishReason === 'MALFORMED_FUNCTION_CALL');
      }
      await logGemini('streamChat', { messages, circuitContext }, logPayload);
      callbacks.onDone();
    } catch (err) {
      callbacks.onError(err instanceof Error ? err.message : 'Unknown Gemini error');
    }
  }

  async suggestParts(requirement: string, constraints?: Record<string, unknown>, existingCircuit?: CircuitContext) {
    const client = this.getClient();
    const contextStr = existingCircuit ? this.buildContextString(existingCircuit) : '';

    const prompt = `Suggest components for the following requirement: "${requirement}"
${constraints ? `Constraints: ${JSON.stringify(constraints)}` : ''}
${contextStr ? `Current circuit:\n${contextStr}` : ''}

Respond with JSON: { "suggestions": [{ "name": "", "mpn": "", "whyChosen": "" }], "reasoning": "" }`;

    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.3
      }
    });
    if (response.usageMetadata) {
      const u = response.usageMetadata;
      console.log(`[Gemini] suggestParts tokens — prompt: ${u.promptTokenCount ?? '?'}, candidates: ${u.candidatesTokenCount ?? '?'}, total: ${u.totalTokenCount ?? '?'}`);
    }

    let result;
    try {
      const text = response.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      result = jsonMatch ? JSON.parse(jsonMatch[0]) : { suggestions: [], reasoning: text };
    } catch {
      result = { suggestions: [], reasoning: response.text || '' };
    }

    await logGemini('suggestParts', { requirement, constraints }, result);
    return result;
  }

  async reviewCircuit(document: Record<string, unknown>, focusAreas?: string[]) {
    const client = this.getClient();

    const prompt = `Review this circuit document and identify issues:
${JSON.stringify(document, null, 2)}
${focusAreas ? `Focus areas: ${focusAreas.join(', ')}` : ''}

Respond with JSON: { "issues": [{ "severity": "error|warning|info", "category": "", "message": "", "suggestedFix": "" }], "suggestions": [], "overallAssessment": "" }`;

    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.3
      }
    });
    if (response.usageMetadata) {
      const u = response.usageMetadata;
      console.log(`[Gemini] reviewCircuit tokens — prompt: ${u.promptTokenCount ?? '?'}, candidates: ${u.candidatesTokenCount ?? '?'}, total: ${u.totalTokenCount ?? '?'}`);
    }

    let result;
    try {
      const text = response.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      result = jsonMatch ? JSON.parse(jsonMatch[0]) : { issues: [], suggestions: [], overallAssessment: text };
    } catch {
      result = { issues: [], suggestions: [], overallAssessment: response.text || '' };
    }

    await logGemini('reviewCircuit', { document, focusAreas }, result);
    return result;
  }

  private buildContextString(ctx: CircuitContext): string {
    const lines: string[] = [];
    if (ctx.components?.length) {
      lines.push(`Components (${ctx.components.length}):`);
      for (const c of ctx.components) {
        const pinStr = c.pins?.length ? ` (pins: ${c.pins.join(', ')})` : '';
        lines.push(`  - ${c.designator}: ${c.value} [${c.libraryId}]${pinStr}`);
      }
    }
    if (ctx.nets?.length) {
      lines.push(`Nets (${ctx.nets.length}):`);
      for (const n of ctx.nets) {
        lines.push(`  - ${n.name}: ${n.pins.join(', ')}`);
      }
    }
    if (ctx.currentSheet) {
      lines.push(`Current sheet: ${ctx.currentSheet}`);
    }
    if (ctx.pcbLayout) {
      const pcb = ctx.pcbLayout;
      lines.push(`PCB Board: ${pcb.board.width}mm x ${pcb.board.height}mm`);
      lines.push(`PCB Placed Components: ${pcb.placedComponents.length}`);
      lines.push(`PCB Unplaced Components: ${pcb.unplacedCount}`);
      if (pcb.placedComponents.length > 0) {
        for (const c of pcb.placedComponents) {
          lines.push(`  - ${c.designator}: (${Math.round(c.x)}, ${Math.round(c.y)}) on ${c.layer}`);
        }
      }
      if (ctx.components?.length) {
        const placedDesignators = new Set(pcb.placedComponents.map(c => c.designator));
        const unplaced = ctx.components.filter(c => !placedDesignators.has(c.designator));
        if (unplaced.length > 0) {
          lines.push(`Unplaced designators available for placement: ${unplaced.map(c => c.designator).join(', ')}`);
        }
      }
    } else if (ctx.components?.length) {
      // PCB not initialized yet — still tell the model what's available for placement
      lines.push(`PCB: Not yet initialized. You can still call layout_pcb_components to place all components.`);
      lines.push(`Default board size is 100mm x 80mm. All ${ctx.components.length} schematic components are available for placement.`);
      lines.push(`Available designators: ${ctx.components.map(c => c.designator).join(', ')}`);
    }
    return lines.join('\n');
  }

  /**
   * Execute a JLCPCB search and return normalized results.
   * Uses official JLCPCB API with fallback to jlcsearch.
   */
  private async executeJlcpcbSearch(query: string, packageFilter?: string): Promise<Record<string, unknown>> {
    let keyword = query;
    if (packageFilter) keyword += ` ${packageFilter}`;

    // Try official JLCPCB API first
    try {
      const body: Record<string, unknown> = {
        keyword,
        pageSize: 10,
        currentPage: 1,
        stockFlag: true, // Only in-stock items
      };

      const response = await fetch(`${JLCPCB_API}/selectSmtComponentList`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) throw new Error(`JLCPCB API returned ${response.status}`);

      const data = await response.json() as {
        data?: { componentPageInfo?: { list?: any[] } };
      };
      const list = data?.data?.componentPageInfo?.list || [];

      if (list.length > 0) {
        const results = list.slice(0, 5).map((comp: any) => {
          const price = comp.componentPrices?.[0]?.productPrice;
          return {
            lcsc: comp.componentCode || '',
            mpn: comp.componentModelEn || '',
            manufacturer: comp.componentBrandEn || '',
            description: comp.describe || '',
            package: comp.componentSpecificationEn || '',
            stock: comp.stockCount || 0,
            price: price ?? 0,
            basic: comp.componentLibraryType === 'base',
          };
        });

        return { success: true, results, message: `Found ${results.length} in-stock parts on JLCPCB` };
      }
    } catch (err) {
      console.warn('[Gemini] Official JLCPCB search failed, trying fallback:', (err as Error).message);
    }

    // Fallback to jlcsearch
    try {
      const params = new URLSearchParams({ q: query, limit: '10' });
      if (packageFilter) params.set('package', packageFilter);

      const fallbackRes = await fetch(`${JLCSEARCH_BASE}/api/search?${params}`);
      if (!fallbackRes.ok) throw new Error(`Fallback returned ${fallbackRes.status}`);

      const fallbackData = await fallbackRes.json() as { components?: any[] };
      const components = (fallbackData.components || []).filter((c: any) => c.stock > 0).slice(0, 5);

      const results = components.map((c: any) => ({
        lcsc: c.lcsc || '',
        mpn: c.mfr || '',
        manufacturer: c.manufacturer || '',
        description: c.description || '',
        package: c.package || '',
        stock: c.stock || 0,
        price: c.price1 || 0,
        basic: c.is_basic ?? c.basic ?? false,
      }));

      return { success: true, results, message: `Found ${results.length} in-stock parts` };
    } catch (err) {
      return { success: false, results: [], error: `Search failed: ${(err as Error).message}` };
    }
  }
}
