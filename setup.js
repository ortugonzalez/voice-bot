// setup.js — Crea el agente "Valentina" en ElevenLabs e importa el numero de Twilio.
// Integracion NATIVA: ElevenLabs maneja el audio de la llamada via Twilio. No hace falta
// ngrok ni websocket manual: al importar el numero, ElevenLabs configura solo los webhooks.
//
// Uso: node setup.js   (idempotente: no recrea lo que ya este en .env)

import dotenv from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';

dotenv.config({ path: new URL('./.env', import.meta.url) });

const API = 'https://api.elevenlabs.io';
const KEY = process.env.ELEVENLABS_API_KEY;
const ENV_PATH = new URL('./.env', import.meta.url);

if (!KEY) {
  console.error('Falta ELEVENLABS_API_KEY en .env');
  process.exit(1);
}

// --- Persistir un valor en .env (reemplaza la linea KEY= o la agrega) ---
function setEnv(key, value) {
  let txt = readFileSync(ENV_PATH, 'utf8');
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  txt = re.test(txt) ? txt.replace(re, line) : txt.trimEnd() + `\n${line}\n`;
  writeFileSync(ENV_PATH, txt);
  process.env[key] = value;
}

async function api(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const detail = data?.detail?.message || data?.detail || text;
    throw new Error(`POST ${path} -> ${res.status}: ${JSON.stringify(detail)}`);
  }
  return data;
}

// --- System prompt (espanol rioplatense) con variables dinamicas {{...}} ---
const SYSTEM_PROMPT = `Sos Valentina, una asistente de llamadas para ONGs argentinas. Estas llamando en nombre de {{ong_name}}.

Tu objetivo es contarle a {{donor_name}} el impacto de su donacion (su ultima colaboracion fue de \\$ {{last_amount}}) y reconectarlo con la causa, con calidez y sin presionar.

Reglas de la conversacion:
- Hablas en espanol rioplatense (vos, tenes, queres, dale), tono calido, cercano y natural.
- Usas el nombre del donante ({{donor_name}}) de forma natural, sin repetirlo de mas.
- Te presentas al inicio: quien sos, de parte de que ONG llamas y por que.
- Nunca presiones para pedir mas plata. El foco es agradecer y reconectar con la causa.
- Frases cortas y conversacionales: esto es una llamada telefonica, no un texto escrito.
- Si {{donor_name}} pregunta algo especifico sobre montos exactos, administracion de fondos, datos sensibles o algo que no sabes con certeza, NO inventes: deci que lo vas a conectar con alguien del equipo de {{ong_name}} y ofrece coordinar ese contacto.
- Si pide que no lo llamen mas o no quiere hablar, respetalo de inmediato, agradece y cerra amablemente.
- Cerra la llamada agradeciendo el apoyo a la causa.`;

const FIRST_MESSAGE = 'Hola {{donor_name}}, como andas! Te hablo de {{ong_name}}, tenes un minutito?';

async function createAgent() {
  if (process.env.AGENT_ID) {
    console.log(`AGENT_ID ya existe (${process.env.AGENT_ID}), no lo recreo.`);
    return process.env.AGENT_ID;
  }
  console.log('Creando agente "Valentina"...');
  const body = {
    name: 'Valentina - Reactivacion Donantes (WIS)',
    conversational_config: {
      agent: {
        prompt: { prompt: SYSTEM_PROMPT, llm: process.env.ELEVENLABS_LLM },
        first_message: FIRST_MESSAGE,
        language: 'es',
      },
      tts: {
        voice_id: process.env.ELEVENLABS_VOICE_ID,
        model_id: process.env.ELEVENLABS_TTS_MODEL,
      },
    },
  };
  let data;
  try {
    data = await api('/v1/convai/agents/create', body);
  } catch (e) {
    // Si el LLM elegido no esta disponible, reintento sin fijar llm (usa el default).
    if (String(e.message).includes('llm') || String(e.message).includes('422')) {
      console.warn('  Reintento sin fijar LLM (uso el default del agente)...');
      delete body.conversational_config.agent.prompt.llm;
      data = await api('/v1/convai/agents/create', body);
    } else {
      throw e;
    }
  }
  const id = data.agent_id;
  setEnv('AGENT_ID', id);
  console.log(`  Agente creado: ${id}`);
  return id;
}

async function importPhoneNumber() {
  if (process.env.AGENT_PHONE_NUMBER_ID) {
    console.log(`AGENT_PHONE_NUMBER_ID ya existe (${process.env.AGENT_PHONE_NUMBER_ID}), no lo reimporto.`);
    return process.env.AGENT_PHONE_NUMBER_ID;
  }
  console.log(`Importando numero de Twilio ${process.env.TWILIO_PHONE_NUMBER}...`);
  const data = await api('/v1/convai/phone-numbers', {
    phone_number: process.env.TWILIO_PHONE_NUMBER,
    label: 'WIS Donantes (Twilio)',
    provider: 'twilio',
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
  });
  const id = data.phone_number_id;
  setEnv('AGENT_PHONE_NUMBER_ID', id);
  console.log(`  Numero importado: ${id}`);
  return id;
}

(async () => {
  try {
    const agentId = await createAgent();
    const phoneId = await importPhoneNumber();
    console.log('\n=== SETUP OK ===');
    console.log(`AGENT_ID=${agentId}`);
    console.log(`AGENT_PHONE_NUMBER_ID=${phoneId}`);
    console.log('Listo. Levanta el server con `npm start` y haces la llamada con `npm run call`.');
  } catch (e) {
    console.error('\n=== SETUP FALLO ===');
    console.error(e.message);
    process.exit(1);
  }
})();
