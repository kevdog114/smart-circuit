import { Router, Request, Response } from 'express';
import { EasyEDAService } from '../services/easyeda.js';
import { saveComponentDef, saveComponentDefs, getComponentDef, getComponentDefs } from '../services/component-library.js';

export const componentsRouter = Router();

const JLCSEARCH_BASE = 'https://jlcsearch.tscircuit.com';
const easyeda = new EasyEDAService();

const JLCPCB_API = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood';

interface JLCSearchResult {
  lcsc: string;
  mfr: string;
  package: string;
  description: string;
  stock: number;
  price1: number;
  manufacturer: string;
  basic?: boolean;
  is_basic?: boolean;
  [key: string]: unknown;
}

interface JLCPCBOfficialResult {
  componentCode: string;
  componentModelEn: string;
  componentBrandEn: string;
  componentSpecificationEn: string;
  describe: string;
  stockCount: number;
  componentLibraryType: string;
  componentPrices?: { startNumber: number; endNumber: number; productPrice: number }[];
  [key: string]: unknown;
}

// Full-text search — uses official JLCPCB API with fallback to jlcsearch
componentsRouter.get('/search', async (req: Request, res: Response) => {
  const { q, package: pkg, basic, limit = '20', inStockOnly } = req.query;

  if (!q || typeof q !== 'string') {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'q parameter is required' } });
    return;
  }

  try {
    // Build search keyword, include package filter if provided
    let keyword = q;
    if (pkg && typeof pkg === 'string') keyword += ` ${pkg}`;

    const body: Record<string, unknown> = {
      keyword,
      pageSize: parseInt(String(limit), 10),
      currentPage: 1,
    };
    if (basic === 'true') {
      body.componentLibraryType = 'base';
    }
    if (inStockOnly !== 'false') {
      body.stockFlag = true;
    }

    const response = await fetch(`${JLCPCB_API}/selectSmtComponentList`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`JLCPCB API returned ${response.status}`);

    const data = await response.json() as {
      data?: { componentPageInfo?: { list?: JLCPCBOfficialResult[] } };
    };
    const list = data?.data?.componentPageInfo?.list || [];

    const results = list.map(normalizeOfficialComponent);

    res.json({ results, total: results.length });
  } catch (err) {
    // Fallback to jlcsearch third-party API
    console.warn('[components/search] Official JLCPCB API failed, falling back to jlcsearch:', (err as Error).message);
    try {
      const params = new URLSearchParams({ q, limit: String(limit) });
      if (pkg && typeof pkg === 'string') params.set('package', pkg);
      if (basic === 'true') params.set('is_basic', 'true');

      const fallbackRes = await fetch(`${JLCSEARCH_BASE}/api/search?${params}`);
      if (!fallbackRes.ok) throw new Error(`Fallback search returned ${fallbackRes.status}`);

      const fallbackData = await fallbackRes.json() as { components?: JLCSearchResult[] };
      const components = fallbackData.components || [];
      res.json({
        results: components.map(normalizeFallbackComponent),
        total: components.length,
      });
    } catch (fallbackErr) {
      const message = fallbackErr instanceof Error ? fallbackErr.message : 'Unknown error';
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
    }
  }
});

function normalizeOfficialComponent(comp: JLCPCBOfficialResult) {
  const price = comp.componentPrices?.[0]?.productPrice;
  const isBasic = comp.componentLibraryType === 'base';

  return {
    lcscPartNumber: comp.componentCode || '',
    name: comp.componentModelEn || '',
    description: comp.describe || '',
    category: (comp as any).componentTypeEn || '',
    package: comp.componentSpecificationEn || '',
    manufacturer: comp.componentBrandEn || '',
    mpn: comp.componentModelEn || '',
    price: price ?? undefined,
    stock: comp.stockCount || 0,
    basic: isBasic,
    datasheet: undefined,
  };
}

/**
 * Parse component specs from the MPN string for fallback descriptions.
 * Extracts explicit values like "10K" → 10kΩ, tolerance ±1%, power 1/4W, etc.
 */
function parseMPNDescription(mpn: string): string | null {
  const parts: string[] = [];
  const upper = mpn.toUpperCase();

  const explicitR = upper.match(/(\d+(?:\.\d+)?)\s*([KMR])\s*(?:Ω|OHM)?/i);
  if (explicitR) {
    const val = parseFloat(explicitR[1]);
    const mult = explicitR[2].toUpperCase();
    if (mult === 'K') parts.push(`${val}kΩ`);
    else if (mult === 'M') parts.push(`${val}MΩ`);
    else if (mult === 'R') parts.push(`${val}Ω`);
  }

  const explicitC = upper.match(/(\d+(?:\.\d+)?)\s*(UF|NF|PF)/i);
  if (explicitC && parts.length === 0) {
    const val = parseFloat(explicitC[1]);
    const unit = explicitC[2].toUpperCase();
    if (unit === 'UF') parts.push(`${val}µF`);
    else if (unit === 'NF') parts.push(`${val}nF`);
    else if (unit === 'PF') parts.push(`${val}pF`);
  }

  const tolMatch = upper.match(/[±](\d+(?:\.\d+)?)%/);
  if (tolMatch) parts.push(`±${tolMatch[1]}%`);

  const powerMatch = upper.match(/(\d+(?:\/\d+)?)\s*W(?:ATT)?/);
  if (powerMatch) {
    const pw = powerMatch[1];
    if (pw.includes('/')) {
      const [n, d] = pw.split('/');
      parts.push(`${parseInt(n) / parseInt(d)}W`);
    } else {
      parts.push(`${pw}W`);
    }
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Infer a human-readable category from the component name and description.
 * Used when the API doesn't return an explicit category (e.g. jlcsearch fallback).
 */
function inferCategory(name: string, description: string): string {
  const text = `${name} ${description}`.toLowerCase();
  if (/\bresistor|\bres\b|\bohm/.test(text)) return 'Resistors';
  if (/\bcapacitor|\bcap\b|\bmlcc|\belectrolytic|\btantalum/.test(text)) return 'Capacitors';
  if (/\binductor|\bferrite|\bchoke/.test(text)) return 'Inductors';
  if (/\bled\b|light.emit/.test(text)) return 'LEDs';
  if (/\bdiode|\brectifier|\bschottky|\bzener/.test(text)) return 'Diodes';
  if (/\btransistor|\bmosfet|\bnmos|\bpmos|\bnpn|\bpnp|\bbjt|\bfet\b/.test(text)) return 'Transistors';
  if (/\bop.?amp|\bcomparator/.test(text)) return 'Op Amps';
  if (/\bmcu|\bmicrocontroller/.test(text)) return 'MCUs';
  if (/\bconnector|\bheader|\bterminal|\bjack\b|\bplug\b|\bsocket\b/.test(text)) return 'Connectors';
  if (/\bcrystal|\boscillator|\bresonator/.test(text)) return 'Crystals & Oscillators';
  if (/\bvoltage.reg|\bldo|\bdc.dc|\bconverter|\bregulator/.test(text)) return 'Power ICs';
  if (/\bic\b|\bdriver|\bcontroller|\bamplifier|\binterface|\bgate\b|\bflip.flop|\bmux\b/.test(text)) return 'ICs';
  if (/\bfuse\b|\bvaristor|\bptc|\bntc|\bthermistor/.test(text)) return 'Protection';
  if (/\brelay|\bswitch/.test(text)) return 'Switches & Relays';
  if (/\btransformer|\bcoupl/.test(text)) return 'Transformers';
  return '';
}

function normalizeFallbackComponent(comp: JLCSearchResult) {
  // Build a synthetic description from MPN when API description is empty
  let description = comp.description || '';
  if (!description && comp.mfr) {
    description = parseMPNDescription(comp.mfr) || '';
  }

  return {
    lcscPartNumber: comp.lcsc || '',
    name: comp.mfr || '',
    description,
    category: (comp as any).category || inferCategory(comp.mfr || '', description),
    package: comp.package || '',
    manufacturer: comp.manufacturer || '',
    mpn: comp.mfr || '',
    price: comp.price1 || undefined,
    stock: comp.stock || 0,
    basic: comp.is_basic ?? comp.basic ?? false,
    datasheet: undefined,
  };
}

// Resolve component by MPN or LCSC → returns full pin data from EasyEDA
componentsRouter.get('/resolve', async (req: Request, res: Response) => {
  const { mpn, lcsc } = req.query;

  if ((!mpn || typeof mpn !== 'string') && (!lcsc || typeof lcsc !== 'string')) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'mpn or lcsc parameter is required' } });
    return;
  }

  try {
    let resolved;
    if (lcsc && typeof lcsc === 'string') {
      // Direct LCSC resolution — skip JLCPCB search
      resolved = await easyeda.fetchByLCSC(lcsc, (mpn as string) || undefined);
    } else {
      resolved = await easyeda.resolveByMPN(mpn as string);
    }

    if (!resolved) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `Could not resolve component` } });
      return;
    }

    res.json(resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
  }
});

// ─── Component Library (persistent cache) ───

// GET /api/components/library/:id — fetch a single cached definition
componentsRouter.get('/library/:id', async (req: Request, res: Response) => {
  const def = await getComponentDef(req.params.id as string);
  if (!def) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Component not in library' } });
    return;
  }
  res.json(def);
});

// POST /api/components/library — save one or more definitions
// Body: single def { id, ... } or array [{ id, ... }, ...]
componentsRouter.post('/library', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (Array.isArray(body)) {
      const saved = await saveComponentDefs(body);
      res.json({ saved });
    } else if (body && body.id) {
      await saveComponentDef(body);
      res.json({ saved: 1 });
    } else {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Body must be a definition or array of definitions' } });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
  }
});

// POST /api/components/library/batch — fetch multiple definitions by IDs
// Body: { ids: ["id1", "id2", ...] }
componentsRouter.post('/library/batch', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'ids must be an array' } });
      return;
    }
    const defs = await getComponentDefs(ids);
    res.json({ definitions: defs });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
  }
});
