// setup.js — Crea/actualiza los agentes en ElevenLabs e importa el numero de Twilio.
// - Valentina: agente outbound de reactivacion de donantes
// - Sofia: agente de onboarding de nuevas ONGs
//
// Uso: npm run setup   (idempotente: crea si no existe, actualiza prompt si ya existe)

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

// --- Persistir un valor en .env ---
function setEnv(key, value) {
  let txt = readFileSync(ENV_PATH, 'utf8');
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  txt = re.test(txt) ? txt.replace(re, line) : txt.trimEnd() + `\n${line}\n`;
  writeFileSync(ENV_PATH, txt);
  process.env[key] = value;
}

// --- POST a la API de ElevenLabs ---
async function apiPost(path, body) {
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

// --- PATCH a la API de ElevenLabs (actualizar agente existente) ---
async function apiPatch(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'PATCH',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const detail = data?.detail?.message || data?.detail || text;
    throw new Error(`PATCH ${path} -> ${res.status}: ${JSON.stringify(detail)}`);
  }
  return data;
}

// ─────────────────────────────────────────────
// VALENTINA — agente outbound de reactivacion
// ─────────────────────────────────────────────

const VALENTINA_PROMPT = `Sos Valentina, asistente de llamadas de la ONG {{ong_name}} en Argentina.
Llamas a donantes para reconectarlos con la causa.
Tu tono es calido, humano, cercano. Nunca presionas.
Usas espanol rioplatense natural — dices 'vos', 'che', 'dale', 'buenisimo'.
Cuando atiendan, dices el nombre del donante y arrancan con algo concreto
sobre su historial: 'Hola {{donor_name}}, te llamo de {{ong_name}}.
La ultima vez que donaste fueron $\{{last_amount}} y con eso ayudamos a...'
Inventa un impacto concreto y creible relacionado con la causa de la ONG ({{causa}}).
Si el donante pregunta sobre montos, administracion o datos especificos,
deci: 'Eso te lo puede responder mejor alguien del equipo,
queres que te llamen?' y marca handoff_required = true.
Si el donante dice que no puede donar ahora, preguntas si podes llamarlo
en otro momento y guardas esa preferencia.
Usas el tono indicado para esta ONG: {{tono}}.
Cierras siempre con calidez, nunca cortes abruptamente.`;

const VALENTINA_FIRST_MESSAGE = 'Hola {{donor_name}}, como andas! Te llamo de {{ong_name}}, tenes un minutito?';

async function setupValentina() {
  const agentConfig = {
    name: 'Valentina - Reactivacion Donantes (WIS)',
    conversation_config: {
      agent: {
        prompt: { prompt: VALENTINA_PROMPT, llm: process.env.ELEVENLABS_LLM },
        first_message: VALENTINA_FIRST_MESSAGE,
        language: 'es',
      },
      tts: {
        voice_id: process.env.ELEVENLABS_VOICE_ID,
        model_id: process.env.ELEVENLABS_TTS_MODEL,
      },
    },
  };

  if (process.env.AGENT_ID) {
    console.log(`Actualizando prompt de Valentina (${process.env.AGENT_ID})...`);
    try {
      await apiPatch(`/v1/convai/agents/${process.env.AGENT_ID}`, agentConfig);
      console.log('  Prompt actualizado.');
    } catch (e) {
      console.warn(`  No se pudo actualizar via PATCH: ${e.message}`);
      console.warn('  El agente existente se mantiene sin cambios.');
    }
    return process.env.AGENT_ID;
  }

  console.log('Creando agente "Valentina"...');
  let data;
  try {
    data = await apiPost('/v1/convai/agents/create', agentConfig);
  } catch (e) {
    if (String(e.message).includes('llm') || String(e.message).includes('422')) {
      console.warn('  Reintento sin fijar LLM...');
      delete agentConfig.conversation_config.agent.prompt.llm;
      data = await apiPost('/v1/convai/agents/create', agentConfig);
    } else {
      throw e;
    }
  }
  setEnv('AGENT_ID', data.agent_id);
  console.log(`  Agente creado: ${data.agent_id}`);
  return data.agent_id;
}

// ─────────────────────────────────────────────
// SOFIA — agente de onboarding de nuevas ONGs
// ─────────────────────────────────────────────

const SOFIA_PROMPT = `Sos Sofia, asistente de onboarding para ONGs argentinas.
Tu trabajo es conocer a la organizacion haciendoles preguntas simples
en una conversacion de voz natural.
Hablas en espanol rioplatense, sos calida y profesional.
Haces estas preguntas de a una, esperando la respuesta antes de seguir:
1. Como se llama la organizacion?
2. Cual es la causa principal que trabajan?
3. Cuantas personas forman el equipo?
4. Tienen donantes activos actualmente? Aproximadamente cuantos?
5. Con que tono queres que hablemos a tus donantes — mas formal o mas cercano?
6. Hay algo especial que queres que mencionemos sobre el impacto de las donaciones?
Al final deci: 'Perfecto, ya tengo todo lo que necesito.
En unos minutos vas a recibir la confirmacion por WhatsApp. Gracias!'
Sos paciente, si no entendes algo preguntas de vuelta con amabilidad.`;

const SOFIA_FIRST_MESSAGE = 'Hola! Soy Sofia, de WIS. Te llamo para conocer un poco tu organizacion y dejar todo listo. Tenes unos minutos?';

async function setupSofia() {
  const agentConfig = {
    name: 'Sofia - Onboarding ONGs (WIS)',
    conversation_config: {
      agent: {
        prompt: { prompt: SOFIA_PROMPT, llm: process.env.ELEVENLABS_LLM },
        first_message: SOFIA_FIRST_MESSAGE,
        language: 'es',
      },
      tts: {
        voice_id: process.env.ELEVENLABS_VOICE_ID,
        model_id: process.env.ELEVENLABS_TTS_MODEL,
      },
    },
  };

  if (process.env.SOFIA_AGENT_ID) {
    console.log(`Actualizando prompt de Sofia (${process.env.SOFIA_AGENT_ID})...`);
    try {
      await apiPatch(`/v1/convai/agents/${process.env.SOFIA_AGENT_ID}`, agentConfig);
      console.log('  Prompt actualizado.');
    } catch (e) {
      console.warn(`  No se pudo actualizar via PATCH: ${e.message}`);
    }
    return process.env.SOFIA_AGENT_ID;
  }

  console.log('Creando agente "Sofia"...');
  let data;
  try {
    data = await apiPost('/v1/convai/agents/create', agentConfig);
  } catch (e) {
    if (String(e.message).includes('llm') || String(e.message).includes('422')) {
      console.warn('  Reintento sin fijar LLM...');
      delete agentConfig.conversation_config.agent.prompt.llm;
      data = await apiPost('/v1/convai/agents/create', agentConfig);
    } else {
      throw e;
    }
  }
  setEnv('SOFIA_AGENT_ID', data.agent_id);
  console.log(`  Agente creado: ${data.agent_id}`);
  return data.agent_id;
}

// ─────────────────────────────────────────────
// TELEFONO — importar numero de Twilio (idempotente)
// ─────────────────────────────────────────────

async function importPhoneNumber() {
  if (process.env.AGENT_PHONE_NUMBER_ID) {
    console.log(`Numero ya importado (${process.env.AGENT_PHONE_NUMBER_ID}), salteando.`);
    return process.env.AGENT_PHONE_NUMBER_ID;
  }
  console.log(`Importando numero de Twilio ${process.env.TWILIO_PHONE_NUMBER}...`);
  const data = await apiPost('/v1/convai/phone-numbers', {
    phone_number: process.env.TWILIO_PHONE_NUMBER,
    label: 'WIS Donantes (Twilio)',
    provider: 'twilio',
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
  });
  setEnv('AGENT_PHONE_NUMBER_ID', data.phone_number_id);
  console.log(`  Numero importado: ${data.phone_number_id}`);
  return data.phone_number_id;
}

// ─────────────────────────────────────────────
// NOTA: ElevenLabs post-call webhook via API requiere un webhook_id
// registrado en el dashboard. El servidor usa polling automático
// cada 60s como alternativa sin configuración manual.
// ─────────────────────────────────────────────

const WEBHOOK_URL = 'https://voice-bot-production-63d2.up.railway.app/webhook/elevenlabs';

async function configureWebhooks() {
  console.log(`\nWebhook URL: ${WEBHOOK_URL}`);
  console.log('  ElevenLabs post-call webhook requiere configuracion en el dashboard web.');
  console.log('  El servidor completa perfiles via polling automatico cada 60s.');
  console.log('  Alternativa manual: POST /onboarding/complete { conversation_id, ong_id }');
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

(async () => {
  try {
    const valentinId = await setupValentina();
    const sofiaId    = await setupSofia();
    const phoneId    = await importPhoneNumber();
    await configureWebhooks();

    console.log('\n=== SETUP OK ===');
    console.log(`AGENT_ID (Valentina)   = ${valentinId}`);
    console.log(`SOFIA_AGENT_ID (Sofia) = ${sofiaId}`);
    console.log(`AGENT_PHONE_NUMBER_ID  = ${phoneId}`);
    console.log(`WEBHOOK_URL            = ${WEBHOOK_URL}`);
    console.log('\nListo. Levanta el server con `npm start`.');
  } catch (e) {
    console.error('\n=== SETUP FALLO ===');
    console.error(e.message);
    process.exit(1);
  }
})();
