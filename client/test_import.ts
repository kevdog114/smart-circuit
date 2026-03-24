import fs from 'fs';
import { importFromEasyEDAPro } from './src/import/easyeda-pro-importer.js';

async function run() {
  try {
    const filebuffer = fs.readFileSync('../rp_audio_matrix_switch.eprj');
    console.log("Read file, buffer size:", filebuffer.length);
    const result = await importFromEasyEDAPro(filebuffer.buffer.slice(filebuffer.byteOffset, filebuffer.byteOffset + filebuffer.byteLength));
    console.log("Import success!");
    console.log("Components:", result.doc.sheets[0].components.length);
    console.log("Wires:", result.doc.sheets[0].wires.length);
  } catch (err) {
    console.error("IMPORT ERROR:", err);
  }
}

run();
