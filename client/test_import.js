import fs from 'fs';
import initSqlJs from 'sql.js';

// Polyfill DecompressionStream for node just in case? No, node 22 has it.

async function testImport() {
  const SQL = await initSqlJs();
  const filebuffer = fs.readFileSync('../rp_audio_matrix_switch.eprj');
  const db = new SQL.Database(filebuffer);
  
  function decompressGzip(base64Str) {
    return new Promise((resolve, reject) => {
      try {
        const b64 = base64Str.replace(/^base64/, '');
        const binaryString = atob(b64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        const blob = new Blob([bytes]);
        const ds = new DecompressionStream('gzip');
        const decompressedStream = blob.stream().pipeThrough(ds);
        
        new Response(decompressedStream).arrayBuffer().then(buffer => {
          resolve(new TextDecoder().decode(buffer));
        }).catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  let components = 0;
  let wires = 0;
  
  const schRes = db.exec("SELECT title, dataStr FROM documents WHERE docType = 1");
  if (schRes.length > 0 && schRes[0].values.length > 0) {
    console.log("Found schematic document");
    const dataStr = schRes[0].values[0][1];
    if (dataStr && dataStr.startsWith('base64')) {
      const decompressed = await decompressGzip(dataStr);
      const lines = decompressed.split('\\n');
      console.log(`Decompressed to ${lines.length} lines`);
      
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const node = JSON.parse(line);
          if (!Array.isArray(node)) continue;
          
          if (node[0] === 'COMPONENT') components++;
          else if (node[0] === 'WIRE') wires++;
        } catch(e) {}
      }
    }
  }
  
  console.log("Components parsed:", components);
  console.log("Wires parsed:", wires);
}

testImport().catch(console.error);
