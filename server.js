// server.js — API del voice bot para ONGs (ElevenLabs + Twilio, integracion nativa).
//
// Endpoints:
//   GET  /health          estado del servidor y configuracion
//   POST /call            llamada individual a un donante
//   POST /call/batch      campana a lista de donantes (30s entre llamadas)
//   POST /onboarding      llamada de onboarding con Sofia
//   GET  /calls           historial de llamadas (calls-log.json)
//   GET  /ongs            perfiles de ONGs (ong-profiles.json)
//   GET  /dashboard       metricas generales

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config({ path: new URL('./.env', import.meta.url) });

const {
  ELEVENLABS_API_KEY,
  AGENT_ID,
  SOFIA_AGENT_ID,
  AGENT_PHONE_NUMBER_ID,
  PORT = 3100,
} = process.env;

const API = 'https://api.elevenlabs.io';
const CALLS_LOG_PATH  = fileURLToPath(new URL('./calls-log.json',  import.meta.url));
const ONG_PROFILES_PATH = fileURLToPath(new URL('./ong-profiles.json', import.meta.url));

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// Helpers de persistencia JSON
// ─────────────────────────────────────────────

function readJson(path) {
  try {
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

function appendJson(path, entry) {
  const data = readJson(path);
  data.push(entry);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

// ─────────────────────────────────────────────
// Helper: llamada outbound a ElevenLabs
// ─────────────────────────────────────────────

async function makeCall(agentId, toNumber, dynamicVars) {
  const payload = {
    agent_id: agentId,
    agent_phone_number_id: AGENT_PHONE_NUMBER_ID,
    to_number: toNumber,
    conversation_initiation_client_data: { dynamic_variables: dynamicVars },
  };
  const r = await fetch(`${API}/v1/convai/twilio/outbound-call`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${JSON.stringify(data?.detail || data)}`);
  return data;
}

// ─────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    ready: Boolean(ELEVENLABS_API_KEY && AGENT_ID && AGENT_PHONE_NUMBER_ID),
    valentina_configured: Boolean(AGENT_ID),
    sofia_configured: Boolean(SOFIA_AGENT_ID),
    phone_configured: Boolean(AGENT_PHONE_NUMBER_ID),
    uptime_s: Math.round(process.uptime()),
  });
});

// ─────────────────────────────────────────────
// POST /call — llamada individual a un donante
// ─────────────────────────────────────────────

app.post('/call', async (req, res) => {
  const { phone, donor_name, last_amount, ong_name, causa, tono, impacto_mensaje } = req.body || {};

  if (!phone) return res.status(400).json({ error: 'Falta "phone" (ej: +5492235428861)' });
  if (!AGENT_ID || !AGENT_PHONE_NUMBER_ID) {
    return res.status(503).json({ error: 'Setup incompleto. Corre npm run setup.' });
  }

  const dynamicVars = {
    donor_name:      donor_name      ?? 'donante',
    last_amount:     last_amount     ?? '',
    ong_name:        ong_name        ?? 'la ONG',
    causa:           causa           ?? 'ayudar a quienes mas lo necesitan',
    tono:            tono            ?? 'cercano y calido',
    impacto_mensaje: impacto_mensaje ?? '',
  };

  const logEntry = {
    call_id:         randomUUID(),
    conversation_id: null,
    donor_name:      dynamicVars.donor_name,
    donor_phone:     phone,
    ong_name:        dynamicVars.ong_name,
    last_amount:     dynamicVars.last_amount,
    timestamp:       new Date().toISOString(),
    status:          'failed',
    notes:           '',
  };

  try {
    const data = await makeCall(AGENT_ID, phone, dynamicVars);
    logEntry.conversation_id = data.conversation_id ?? null;
    logEntry.status = data.success ? 'initiated' : 'failed';
    logEntry.notes  = data.message ?? '';
    appendJson(CALLS_LOG_PATH, logEntry);
    console.log(`[/call] Iniciada: ${phone} (${dynamicVars.donor_name}) conv=${logEntry.conversation_id}`);
    return res.json({ ok: true, ...data, call_id: logEntry.call_id });
  } catch (e) {
    logEntry.notes = e.message;
    appendJson(CALLS_LOG_PATH, logEntry);
    console.error('[/call] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// POST /call/batch — campana a lista de donantes
// Body: array de { phone, donor_name, last_amount, ong_name, ...extras }
// ─────────────────────────────────────────────

app.post('/call/batch', async (req, res) => {
  const donors = req.body;
  if (!Array.isArray(donors) || donors.length === 0) {
    return res.status(400).json({ error: 'El body debe ser un array de donantes.' });
  }
  if (!AGENT_ID || !AGENT_PHONE_NUMBER_ID) {
    return res.status(503).json({ error: 'Setup incompleto. Corre npm run setup.' });
  }

  const campaignId = randomUUID();
  console.log(`[/call/batch] Campana ${campaignId} iniciada: ${donors.length} donantes, 30s entre llamadas.`);

  // Responde inmediatamente y procesa en background
  res.json({
    ok: true,
    campaign_id: campaignId,
    total: donors.length,
    message: `Campana iniciada. Se realizaran ${donors.length} llamadas con 30 segundos de intervalo.`,
  });

  // Procesamiento asincronico
  (async () => {
    for (let i = 0; i < donors.length; i++) {
      if (i > 0) {
        console.log(`[/call/batch] Esperando 30s antes de llamada ${i + 1}/${donors.length}...`);
        await new Promise(r => setTimeout(r, 30_000));
      }
      const { phone, donor_name, last_amount, ong_name, causa, tono, impacto_mensaje } = donors[i];
      const logEntry = {
        call_id:         randomUUID(),
        campaign_id:     campaignId,
        conversation_id: null,
        donor_name:      donor_name  ?? 'donante',
        donor_phone:     phone,
        ong_name:        ong_name    ?? 'la ONG',
        last_amount:     last_amount ?? '',
        timestamp:       new Date().toISOString(),
        status:          'failed',
        notes:           '',
      };
      try {
        const data = await makeCall(AGENT_ID, phone, {
          donor_name:      donor_name      ?? 'donante',
          last_amount:     last_amount     ?? '',
          ong_name:        ong_name        ?? 'la ONG',
          causa:           causa           ?? 'ayudar a quienes mas lo necesitan',
          tono:            tono            ?? 'cercano y calido',
          impacto_mensaje: impacto_mensaje ?? '',
        });
        logEntry.conversation_id = data.conversation_id ?? null;
        logEntry.status = data.success ? 'initiated' : 'failed';
        logEntry.notes  = data.message ?? '';
        console.log(`[/call/batch] ${i + 1}/${donors.length} OK: ${phone} (${donor_name})`);
      } catch (e) {
        logEntry.notes = e.message;
        console.error(`[/call/batch] ${i + 1}/${donors.length} FALLO ${phone}: ${e.message}`);
      }
      appendJson(CALLS_LOG_PATH, logEntry);
    }
    console.log(`[/call/batch] Campana ${campaignId} completada.`);
  })();
});

// ─────────────────────────────────────────────
// POST /onboarding — llamada de onboarding con Sofia
// Body: { phone, ong_name? }
// ─────────────────────────────────────────────

app.post('/onboarding', async (req, res) => {
  const { phone, ong_name } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Falta "phone" (ej: +5492235428861)' });
  if (!SOFIA_AGENT_ID) {
    return res.status(503).json({ error: 'Sofia no configurada. Corre npm run setup.' });
  }
  if (!AGENT_PHONE_NUMBER_ID) {
    return res.status(503).json({ error: 'Numero de telefono no configurado. Corre npm run setup.' });
  }

  const profile = {
    ong_id:          randomUUID(),
    ong_name:        ong_name || '',
    causa:           '',
    equipo:          '',
    donantes_activos:'',
    tono:            '',
    impacto_mensaje: '',
    created_at:      new Date().toISOString(),
    conversation_id: null,
    status:          'pending',
  };

  try {
    const data = await makeCall(SOFIA_AGENT_ID, phone, {});
    profile.conversation_id = data.conversation_id ?? null;
    profile.status = data.success ? 'call_initiated' : 'call_failed';
    appendJson(ONG_PROFILES_PATH, profile);
    console.log(`[/onboarding] Llamada a ${phone} iniciada. ong_id=${profile.ong_id}`);
    return res.json({ ok: true, ong_id: profile.ong_id, ...data });
  } catch (e) {
    profile.status = 'call_failed';
    profile.notes  = e.message;
    appendJson(ONG_PROFILES_PATH, profile);
    console.error('[/onboarding] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// GET /calls — historial de llamadas
// ─────────────────────────────────────────────

app.get('/calls', (_req, res) => {
  const calls = readJson(CALLS_LOG_PATH);
  res.json({ total: calls.length, calls });
});

// ─────────────────────────────────────────────
// GET /ongs — perfiles de ONGs
// ─────────────────────────────────────────────

app.get('/ongs', (_req, res) => {
  const ongs = readJson(ONG_PROFILES_PATH);
  res.json({ total: ongs.length, ongs });
});

// ─────────────────────────────────────────────
// GET /dashboard — metricas generales
// ─────────────────────────────────────────────

app.get('/dashboard', (_req, res) => {
  const calls = readJson(CALLS_LOG_PATH);
  const ongs  = readJson(ONG_PROFILES_PATH);

  const exitosas  = calls.filter(c => c.status === 'initiated' || c.status === 'completed').length;
  const handoffs  = calls.filter(c => c.status === 'handoff_required').length;
  const ultima    = calls.length > 0 ? calls[calls.length - 1].timestamp : null;

  res.json({
    total_ongs:          ongs.length,
    total_llamadas:      calls.length,
    llamadas_exitosas:   exitosas,
    handoffs_pendientes: handoffs,
    ultima_llamada:      ultima,
  });
});

// ─────────────────────────────────────────────
// Arranque
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nvoice-bot escuchando en http://localhost:${PORT}`);
  console.log('  GET  /health');
  console.log('  POST /call            { phone, donor_name, last_amount, ong_name }');
  console.log('  POST /call/batch      [ { phone, donor_name, ... }, ... ]');
  console.log('  POST /onboarding      { phone, ong_name? }');
  console.log('  GET  /calls');
  console.log('  GET  /ongs');
  console.log('  GET  /dashboard');
  if (!AGENT_ID || !AGENT_PHONE_NUMBER_ID) {
    console.warn('\n  AVISO: setup incompleto. Corre npm run setup.');
  }
});
