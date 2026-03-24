import fs from 'fs';
import initSqlJs from 'sql.js';
import zlib from 'zlib';

async function run() {
  const SQL = await initSqlJs();
  const filebuffer = fs.readFileSync('../rp_audio_matrix_switch.eprj');
  const db = new SQL.Database(filebuffer);
  
  const res = db.exec('SELECT title, dataStr FROM components');
  if (res.length > 0) {
    for (const row of res[0].values) {
        let b64 = row[1];
        if (!b64 || !b64.startsWith('base')) continue;
        if (b64.startsWith('base64')) {
          b64 = b64.slice(6);
        }
        const compressed = Buffer.from(b64, 'base64');
        const decompressed = zlib.gunzipSync(compressed).toString('utf-8');
        
        if (decompressed.includes('"PIN"')) {
            console.log(`Found component with PINs: ${row[0]}`);
            const lines = decompressed.split('\n').filter(l => l.trim().length > 0);
            
            const types = new Map();
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                if (Array.isArray(parsed)) {
                  const type = parsed[0];
                  if (!types.has(type)) types.set(type, []);
                  if (types.get(type).length < 2) {
                      types.get(type).push(parsed);
                  }
                }
              } catch(e) {}
            }
            
            console.log("=== COMPONENT DATA ===");
            for (const [type, examples] of types.entries()) {
              console.log(`\n=== TYPE: ${type} ===`);
              console.log(JSON.stringify(examples[0]));
            }
            return;
        }
    }
  }
}

run();
