import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function main() {
  console.log('Starting Gemini stream test...');
  
  const response = await client.models.generateContentStream({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: 'add a rp2354b that connects to a usbc port and an led on a gpio so it can be blinked programmatically. include the bootsel button and 8mb psram' }] }],
    config: {
      systemInstruction: 'You are an expert electronics design assistant.',
      temperature: 0.3,
      tools: [{
        functionDeclarations: [{
          name: 'add_subcircuit',
          description: 'Add a group of connected components',
          parameters: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              components: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { designator: { type: Type.STRING }, value: { type: Type.STRING } }, required: ['designator', 'value'] } },
            },
            required: ['name', 'components']
          }
        }]
      }],
      thinkingConfig: { thinkingBudget: 2048 },
    },
  });

  let chunkIndex = 0;
  for await (const chunk of response) {
    const candidate = chunk.candidates?.[0];
    console.log(`\n--- CHUNK ${chunkIndex} ---`);
    console.log('finishReason:', candidate?.finishReason);
    console.log('parts count:', candidate?.content?.parts?.length ?? 0);
    
    if (candidate?.content?.parts) {
      for (let i = 0; i < candidate.content.parts.length; i++) {
        const part = candidate.content.parts[i];
        const keys = Object.keys(part);
        console.log(`  part[${i}] keys:`, keys);
        if (part.text) {
          console.log(`  part[${i}] text: "${part.text.slice(0, 100)}..."`);
        }
        if (part.functionCall) {
          console.log(`  part[${i}] functionCall:`, part.functionCall.name);
        }
        if ((part as any).thought) {
          console.log(`  part[${i}] thought: true, text: "${(part.text || '').slice(0, 100)}..."`);
        }
      }
    }
    chunkIndex++;
  }
  console.log(`\n--- TOTAL CHUNKS: ${chunkIndex} ---`);
}

main().catch(console.error);
