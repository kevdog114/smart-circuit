import { describe, it, expect } from 'vitest';
import { importFromEasyEDA, importMultipleFromEasyEDA } from '../easyeda-importer';
import type { EasyEDADocument } from '../../export/easyeda-serializer';

function makeDoc(shape: string[], title = ''): EasyEDADocument {
  return {
    docType: '1',
    head: { docType: '1', editorVersion: '6.5.40', title, description: '', c_para: {}, x: '0', y: '0', hasId498: true },
    canvas: '',
    title,
    BBox: { x: 0, y: 0, width: 1000, height: 1000 },
    colors: {},
    routerRule: {},
    netColors: {},
    shape,
  };
}

describe('easyeda-importer', () => {
  it('should parse an empty EasyEDA document', () => {
    const result = importFromEasyEDA(makeDoc([], 'Empty Doc'));
    expect(result.doc.name).toBe('Empty Doc');
    expect(result.doc.sheets[0].components).toHaveLength(0);
    expect(result.doc.sheets[0].wires).toHaveLength(0);
    expect(result.library.size).toBe(0);
  });

  it('should parse a component with old LIB format', () => {
    // Old format: LIB~x~y~package~rotation~importFlag~id~locked~mirror~designator
    // Pins in old format: P~show~electric~spicePinNum~posX~posY~x2~y2~color~pinName~pinNumber
    const doc = makeDoc([
      `LIB~100~200~R0603~90~~comp-1~0~0~R1~#@$P~1~4~1~90~200~80~200~#880000~1~1#@$P~1~4~2~110~200~120~200~#880000~2~2#@$R~90~195~0~0~20~10~#FFFFFF~1~0~solid~rect-1~0#@$T~P~100~180~0~#000080~Arial~~~~~comment~R1~1~start~text-desig#@$T~N~100~220~0~#000080~Arial~~~~~comment~10k~1~start~text-val`
    ]);

    const result = importFromEasyEDA(doc);
    expect(result.doc.sheets[0].components).toHaveLength(1);

    const comp = result.doc.sheets[0].components[0];
    expect(comp.id).toBe('comp-1');
    expect(comp.position.x).toBe(100);
    expect(comp.position.y).toBe(200);
    expect(comp.rotation).toBe(90);
    expect(comp.designator).toBe('R1');
    expect(comp.value).toBe('10k');

    expect(result.library.size).toBe(1);
    const def = Array.from(result.library.values())[0];
    expect(def.name).toBe('R0603');
    expect(def.symbol.pins).toHaveLength(2);
    // Pin positions should use posX/posY (index 4,5), NOT spicePinNum (index 3)
    expect(def.symbol.pins[0].position.x).toBe(90 - 100);  // posX - offsetX
    expect(def.symbol.pins[0].position.y).toBe(200 - 200);  // posY - offsetY
  });

  it('should parse a component with new backtick LIB format', () => {
    // Official new format from EasyEDA docs:
    // LIB~x~y~package`C1`nameAlias`...`~~rotation~id~locked
    const doc = makeDoc([
      `LIB~220~140~package\`C1\`nameAlias\`Value(F)\`Value(F)\`1u\`spicePre\`C\`spiceSymbolName\`Capacitor\`~~0~gge66#@$T~N~214~129~0~#000080~Arial~~~~~comment~1u~1~start~gge68#@$T~P~214~120~0~#000080~Arial~~~~~comment~C1~1~start~gge69#@$PL~218 148 218 132~#A00000~1~0~none~gge70#@$P~show~0~1~200~120~180~gge71^^200~140^^M 210 140 h -10~#800^^0~214~140~0~1~start~~^^0~206~136~0~1~end~~^^^^#@$P~show~0~2~210~120~0~gge74^^240~140^^M 230 140 h 10~#800^^0~226~140~0~2~end~~^^0~234~136~0~2~start~~^^^^`
    ]);

    const result = importFromEasyEDA(doc);
    expect(result.doc.sheets[0].components).toHaveLength(1);

    const comp = result.doc.sheets[0].components[0];
    expect(comp.id).toBe('gge66');
    expect(comp.position).toEqual({ x: 220, y: 140 });
    expect(comp.rotation).toBe(0);
    expect(comp.designator).toBe('C1');
    expect(comp.value).toBe('1u');

    const def = Array.from(result.library.values())[0];
    expect(def.symbol.pins).toHaveLength(2);
    // Pin positions should come from the pin dot (section[1] of ^^ format)
    expect(def.symbol.pins[0].position).toEqual({ x: 200 - 220, y: 140 - 140 });
    expect(def.symbol.pins[1].position).toEqual({ x: 240 - 220, y: 140 - 140 });
    // Pin name extracted from section[3], pin number from section[4]
    expect(def.symbol.pins[0].name).toBe('1');
    expect(def.symbol.pins[1].name).toBe('2');
    expect(def.symbol.pins[0].id).toBe('1');
    expect(def.symbol.pins[1].id).toBe('2');
  });

  it('should parse a wire with correct id', () => {
    // Official format: W~points~strokeColor~strokeWidth~strokeStyle~fillColor~id
    const doc = makeDoc([
      `W~100 200 150 200 150 250~#008800~1~0~none~gge19`
    ]);

    const result = importFromEasyEDA(doc);
    expect(result.doc.sheets[0].wires).toHaveLength(1);

    const wire = result.doc.sheets[0].wires[0];
    expect(wire.id).toBe('gge19');
    expect(wire.segments).toHaveLength(2);
    expect(wire.segments[0].start).toEqual({ x: 100, y: 200 });
    expect(wire.segments[0].end).toEqual({ x: 150, y: 200 });
    expect(wire.segments[1].start).toEqual({ x: 150, y: 200 });
    expect(wire.segments[1].end).toEqual({ x: 150, y: 250 });
  });

  it('should parse a net label with correct net name', () => {
    // Official format: N~pinDotX~pinDotY~rotation~color~name~id~textAnchor~textX~textY~fontFamily~fontSize
    const doc = makeDoc([
      `N~360~100~0~#FF0000~VCC~gge32~start~362~100~Times New Roman~`
    ]);

    const result = importFromEasyEDA(doc);
    expect(result.doc.sheets[0].labels).toHaveLength(1);

    const label = result.doc.sheets[0].labels[0];
    expect(label.netName).toBe('VCC');
    expect(label.id).toBe('gge32');
    expect(label.position).toEqual({ x: 360, y: 100 });
    expect(label.rotation).toBe(0);
  });

  it('should parse a power flag (netflag) with ^^ delimiters', () => {
    // Official format: F~partId~x~y~rotation~id^^dotX~dotY^^name~color~textX~textY~rot~anchor~vis~fontFamily~fontSize^^shapes...
    const doc = makeDoc([
      `F~part_netLabel_gnD~330~110~~gge41^^330~110^^GND~#000080~319~97~0~start~0~Times New Roman~9pt^^PL~330 120 330 110~#000000~1~0~none~gge44`
    ]);

    const result = importFromEasyEDA(doc);
    expect(result.doc.sheets[0].components).toHaveLength(1);

    const comp = result.doc.sheets[0].components[0];
    expect(comp.position).toEqual({ x: 330, y: 110 });
    expect(comp.value).toBe('GND');
    expect(comp.id).toBe('gge41');

    // Power flag definition should be created
    expect(result.library.size).toBe(1);
    const def = Array.from(result.library.values())[0];
    expect(def.name).toBe('GND');
    expect(def.category).toBe('power');
  });

  it('should parse a junction with correct id', () => {
    // Official format: J~x~y~radius~fillColor~id
    const doc = makeDoc([
      `J~420~140~2.5~#CC0000~gge18`
    ]);

    const result = importFromEasyEDA(doc);
    expect(result.doc.sheets[0].junctions).toHaveLength(1);

    const junction = result.doc.sheets[0].junctions[0];
    expect(junction.id).toBe('gge18');
    expect(junction.position).toEqual({ x: 420, y: 140 });
  });

  describe('importMultipleFromEasyEDA', () => {
    it('should import multiple pages into separate sheets', () => {
      const page1 = makeDoc([
        `LIB~100~200~R0603~90~~comp-1~0~0~R1~#@$P~1~4~1~90~200~80~200~#880000~1~1#@$P~1~4~2~110~200~120~200~#880000~2~2#@$R~90~195~0~0~20~10~#FFFFFF~1~0~solid~rect-1~0`
      ], 'Power Supply');

      const page2 = makeDoc([
        `W~100 200 150 200~#008800~1~0~none~wire-1`,
        `LIB~300~400~C0402~0~~comp-2~0~0~C1~#@$P~1~4~1~290~400~280~400~#880000~1~1#@$P~1~4~2~310~400~320~400~#880000~2~2#@$R~290~395~0~0~20~10~#FFFFFF~1~0~solid~rect-2~0`
      ], 'MCU');

      const result = importMultipleFromEasyEDA([page1, page2]);

      expect(result.doc.sheets).toHaveLength(2);
      expect(result.doc.sheets[0].name).toBe('Power Supply');
      expect(result.doc.sheets[1].name).toBe('MCU');

      expect(result.doc.sheets[0].components).toHaveLength(1);
      expect(result.doc.sheets[0].components[0].id).toBe('comp-1');
      expect(result.doc.sheets[1].components).toHaveLength(1);
      expect(result.doc.sheets[1].components[0].id).toBe('comp-2');
      expect(result.doc.sheets[1].wires).toHaveLength(1);

      expect(result.library.size).toBe(2);
      expect(result.doc.name).toBe('Power Supply');
    });

    it('should throw for an empty array', () => {
      expect(() => importMultipleFromEasyEDA([])).toThrow('No schematic documents to import');
    });

    it('should delegate to single-page import for an array of one', () => {
      const singlePage = makeDoc([], 'Single');
      const result = importMultipleFromEasyEDA([singlePage]);
      expect(result.doc.sheets).toHaveLength(1);
      expect(result.doc.name).toBe('Single');
    });
  });
});
