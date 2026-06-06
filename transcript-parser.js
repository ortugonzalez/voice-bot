// transcript-parser.js — Obtiene el transcript de ElevenLabs, extrae datos de la ONG con OpenAI,
// y actualiza ong-profiles.json con el perfil completo.

import OpenAI from 'openai';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('./.env', import.meta.url) });

const ELEVENLABS_API = 'https://api.elevenlabs.io';
const ONG_PROFILES_PATH = fileURLToPath(new URL('./ong-profiles.json', import.meta.url));

function readProfiles() {
  try {
    if (!existsSync(ONG_PROFILES_PATH)) return [];
    return JSON.parse(readFileSync(ONG_PROFILES_PATH, 'utf8'));
  } catch { return []; }
}

function saveProfiles(profiles) {
  writeFileSync(ONG_PROFILES_PATH, JSON.stringify(profiles, null, 2), 'utf8');
}

export async function parseTranscriptAndUpdate({ conversationId, ongId }) {
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!elevenKey) throw new Error('Falta ELEVENLABS_API_KEY en .env');
  if (!openaiKey) throw new Error('Falta OPENAI_API_KEY en .env');

  // 1. Obtener transcript de ElevenLabs
  const r = await fetch(`${ELEVENLABS_API}/v1/convai/conversations/${conversationId}`, {
    headers: { 'xi-api-key': elevenKey },
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`ElevenLabs ${r.status}: ${err}`);
  }
  const conv = await r.json();

  if (!conv.transcript || conv.transcript.length === 0) {
    throw new Error('El transcript está vacío. La conversación puede no haber terminado aún.');
  }

  // Formatear transcript como texto legible
  const transcriptText = conv.transcript
    .map(t => `${t.role === 'agent' ? 'Sofía' : 'ONG'}: ${t.message}`)
    .join('\n');

  // 2. Enviar a OpenAI gpt-4o-mini para extraer datos estructurados
  const client = new OpenAI({ apiKey: openaiKey });

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Analizá esta transcripción de onboarding con una ONG argentina y extraé los datos en JSON:
{
  "ong_name": "nombre de la organización",
  "causa": "descripción breve de la causa o misión principal",
  "equipo": "número aproximado de personas en el equipo",
  "donantes_activos": "número aproximado de donantes activos",
  "tono": "formal | cercano | mixto",
  "impacto_mensaje": "frase clave sobre el impacto de las donaciones en la comunidad"
}
Si algún dato no aparece, dejá el campo como string vacío "".
Respondé SOLO con el JSON, sin texto adicional.

TRANSCRIPT:
${transcriptText}`,
    }],
  });

  // 3. Parsear respuesta
  const rawText = completion.choices[0].message.content.trim();
  let extracted;
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    extracted = JSON.parse(match ? match[0] : rawText);
  } catch {
    throw new Error(`OpenAI devolvió JSON inválido: ${rawText.slice(0, 200)}`);
  }

  // 4. Actualizar perfil en ong-profiles.json (solo campos no vacíos)
  const profiles = readProfiles();
  const idx = profiles.findIndex(p =>
    p.ong_id === ongId || p.conversation_id === conversationId
  );

  if (idx === -1) {
    throw new Error(`No se encontró perfil con ong_id="${ongId}" o conversation_id="${conversationId}"`);
  }

  const nonEmpty = Object.fromEntries(
    Object.entries(extracted).filter(([, v]) => v !== '' && v != null)
  );

  profiles[idx] = {
    ...profiles[idx],
    ...nonEmpty,
    status: 'completed',
    updated_at: new Date().toISOString(),
  };
  saveProfiles(profiles);

  console.log(`[transcript-parser] Perfil actualizado: ${profiles[idx].ong_id} — ${profiles[idx].ong_name}`);
  return profiles[idx];
}
