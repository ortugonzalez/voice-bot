// server.js — API del bot de llamadas outbound (ElevenLabs + Twilio, integracion nativa).
//
//   GET  /health  -> estado del server y si el setup esta completo
//   POST /call    -> inicia una llamada saliente. Body JSON:
//                    { phone, donor_name, last_amount, ong_name }
//
// La llamada la ejecuta ElevenLabs via Twilio (numero ya importado en setup.js).
// Los datos del donante viajan como dynamic_variables y el agente los usa con {{...}}.

import dotenv from 'dotenv';
import express from 'express';

dotenv.config({ path: new URL('./.env', import.meta.url) });

const {
  ELEVENLABS_API_KEY,
  AGENT_ID,
  AGENT_PHONE_NUMBER_ID,
  PORT = 3000,
} = process.env;

const API = 'https://api.elevenlabs.io';
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  const ready = Boolean(ELEVENLABS_API_KEY && AGENT_ID && AGENT_PHONE_NUMBER_ID);
  res.json({
    status: 'ok',
    ready,
    agent_configured: Boolean(AGENT_ID),
    phone_configured: Boolean(AGENT_PHONE_NUMBER_ID),
    uptime_s: Math.round(process.uptime()),
  });
});

app.post('/call', async (req, res) => {
  const { phone, donor_name, last_amount, ong_name } = req.body || {};

  if (!phone) {
    return res.status(400).json({ error: 'Falta "phone" (ej: +5492235428861)' });
  }
  if (!AGENT_ID || !AGENT_PHONE_NUMBER_ID) {
    return res.status(503).json({
      error: 'Setup incompleto. Corre `npm run setup` para crear el agente e importar el numero.',
    });
  }

  const payload = {
    agent_id: AGENT_ID,
    agent_phone_number_id: AGENT_PHONE_NUMBER_ID,
    to_number: phone,
    conversation_initiation_client_data: {
      dynamic_variables: {
        donor_name: donor_name ?? 'donante',
        last_amount: last_amount ?? '',
        ong_name: ong_name ?? 'la ONG',
      },
    },
  };

  try {
    const r = await fetch(`${API}/v1/convai/twilio/outbound-call`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!r.ok) {
      console.error(`[/call] ElevenLabs ${r.status}:`, data);
      return res.status(r.status).json({ error: 'ElevenLabs rechazo la llamada', detail: data });
    }

    console.log(`[/call] Llamada a ${phone} (${donor_name}) iniciada:`, data);
    return res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[/call] Error:', e);
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`voice-bot escuchando en http://localhost:${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  POST /call   { phone, donor_name, last_amount, ong_name }`);
  if (!AGENT_ID || !AGENT_PHONE_NUMBER_ID) {
    console.warn('  AVISO: setup incompleto. Corre `npm run setup` antes de llamar.');
  }
});
