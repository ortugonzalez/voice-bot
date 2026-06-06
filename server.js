// server.js — API del voice bot para ONGs (ElevenLabs + Twilio, integracion nativa).
//
// Endpoints:
//   GET  /health                  estado del servidor y configuracion
//   POST /call                    llamada individual a un donante
//   POST /call/batch              campana a lista de donantes (30s entre llamadas)
//   POST /onboarding              llamada de onboarding con Sofia
//   POST /onboarding/complete     parsear transcript y completar perfil de ONG
//   POST /webhook/elevenlabs      evento post-llamada de ElevenLabs
//   GET  /calls                   historial de llamadas (calls-log.json)
//   GET  /ongs                    perfiles de ONGs (ong-profiles.json)
//   GET  /dashboard               metricas generales + handoffs
//   GET  /ui/                     dashboard web (static)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import express from 'express';
import { parseTranscriptAndUpdate } from './transcript-parser.js';

dotenv.config({ path: new URL('./.env', import.meta.url) });

const {
  ELEVENLABS_API_KEY,
  AGENT_ID,
  SOFIA_AGENT_ID,
  AGENT_PHONE_NUMBER_ID,
  PORT = 3100,
} = process.env;

const API = 'https://api.elevenlabs.io';
const __dirname       = dirname(fileURLToPath(import.meta.url));
const CALLS_LOG_PATH    = fileURLToPath(new URL('./calls-log.json',    import.meta.url));
const ONG_PROFILES_PATH = fileURLToPath(new URL('./ong-profiles.json', import.meta.url));

const app = express();
app.use(express.json());
app.use('/ui', express.static(join(__dirname, 'dashboard')));

// ─────────────────────────────────────────────
// Helpers de persistencia JSON
// ─────────────────────────────────────────────

function readJson(path) {
  try {
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return []; }
}

function appendJson(path, entry) {
  const data = readJson(path);
  data.push(entry);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

function updateJsonByField(path, field, value, updates) {
  const data = readJson(path);
  const idx = data.findIndex(r => r[field] === value);
  if (idx === -1) return false;
  data[idx] = { ...data[idx], ...updates };
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  return true;
}

// ─────────────────────────────────────────────
// Helper: prompt personalizado por ONG para Valentina
// ─────────────────────────────────────────────

function buildONGPrompt(profile) {
  // ${{last_amount}} en string regular (sin template literal) para que ElevenLabs lo reemplace.
  const histLine = 'La ultima vez que donaste fueron ${{last_amount}} y con eso ayudamos a ' +
    'muchas personas gracias a ' + (profile.causa || 'nuestra causa') + '.';

  return `Sos Valentina, asistente de llamadas de ${profile.ong_name} en Argentina.
La causa que trabajan: ${profile.causa || 'ayudar a quienes mas lo necesitan'}.
Tono de comunicacion: ${profile.tono || 'cercano y calido'}.
Mensaje de impacto: "${profile.impacto_mensaje || ''}".
Usas espanol rioplatense — "vos", "che", "dale", "buenisimo".
Al atender decis: "Hola {{donor_name}}, te llamo de ${profile.ong_name}. ${histLine}"
Si preguntan sobre montos o administracion: "Eso te lo explica mejor alguien del equipo, queres que te llamen?" — marcas handoff_required = true.
Si no puede donar ahora, preguntas si podes llamar en otro momento.
Cerras siempre con calidez, nunca cortes abruptamente.`;
}

// ─────────────────────────────────────────────
// Helper: llamada outbound a ElevenLabs
// ─────────────────────────────────────────────

async function makeCall(agentId, toNumber, dynamicVars, configOverride = null) {
  const initData = { dynamic_variables: dynamicVars };
  if (configOverride) {
    initData.conversation_config_override = configOverride;
  }
  const payload = {
    agent_id:                         agentId,
    agent_phone_number_id:            AGENT_PHONE_NUMBER_ID,
    to_number:                        toNumber,
    conversation_initiation_client_data: initData,
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
// Helper: lookup perfil de ONG y construir override
// ─────────────────────────────────────────────

function getONGOverride(ongName) {
  if (!ongName) return null;
  const profiles = readJson(ONG_PROFILES_PATH);
  const profile = profiles.find(p =>
    p.ong_name === ongName &&
    p.status === 'completed' &&
    p.causa && p.tono && p.impacto_mensaje
  );
  if (!profile) return null;
  return {
    agent: {
      prompt: { prompt: buildONGPrompt(profile) },
      first_message: 'Hola {{donor_name}}, como andas! Te llamo de ' + profile.ong_name + ', tenes un minutito?',
    },
  };
}

// ─────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:               'ok',
    ready:                Boolean(ELEVENLABS_API_KEY && AGENT_ID && AGENT_PHONE_NUMBER_ID),
    valentina_configured: Boolean(AGENT_ID),
    sofia_configured:     Boolean(SOFIA_AGENT_ID),
    phone_configured:     Boolean(AGENT_PHONE_NUMBER_ID),
    uptime_s:             Math.round(process.uptime()),
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

  const configOverride = getONGOverride(ong_name);
  if (configOverride) {
    console.log(`[/call] Usando perfil completo de "${ong_name}"`);
  } else {
    console.log(`[/call] Usando prompt genérico${ong_name ? ` (perfil de "${ong_name}" incompleto o no encontrado)` : ''}`);
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
    const data = await makeCall(AGENT_ID, phone, dynamicVars, configOverride);
    logEntry.conversation_id = data.conversation_id ?? null;
    logEntry.status          = data.success ? 'initiated' : 'failed';
    logEntry.notes           = data.message ?? '';
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

  res.json({
    ok:         true,
    campaign_id: campaignId,
    total:       donors.length,
    message:    `Campana iniciada. Se realizaran ${donors.length} llamadas con 30 segundos de intervalo.`,
  });

  (async () => {
    for (let i = 0; i < donors.length; i++) {
      if (i > 0) {
        console.log(`[/call/batch] Esperando 30s antes de llamada ${i + 1}/${donors.length}...`);
        await new Promise(resolve => setTimeout(resolve, 30_000));
      }
      const { phone, donor_name, last_amount, ong_name, causa, tono, impacto_mensaje } = donors[i];
      const configOverride = getONGOverride(ong_name);
      console.log(configOverride
        ? `[/call/batch] Usando perfil completo de "${ong_name}"`
        : `[/call/batch] Usando prompt genérico${ong_name ? ` ("${ong_name}" incompleto)` : ''}`
      );
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
        }, configOverride);
        logEntry.conversation_id = data.conversation_id ?? null;
        logEntry.status          = data.success ? 'initiated' : 'failed';
        logEntry.notes           = data.message ?? '';
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
    ong_id:           randomUUID(),
    ong_name:         ong_name || '',
    causa:            '',
    equipo:           '',
    donantes_activos: '',
    tono:             '',
    impacto_mensaje:  '',
    created_at:       new Date().toISOString(),
    conversation_id:  null,
    status:           'pending',
  };

  try {
    const data = await makeCall(SOFIA_AGENT_ID, phone, {});
    profile.conversation_id = data.conversation_id ?? null;
    profile.status          = data.success ? 'call_initiated' : 'call_failed';
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
// POST /onboarding/complete — parsear transcript y completar perfil
// Body: { conversation_id, ong_id? }
// ─────────────────────────────────────────────

app.post('/onboarding/complete', async (req, res) => {
  const { conversation_id, ong_id } = req.body || {};
  if (!conversation_id) {
    return res.status(400).json({ error: 'Falta "conversation_id"' });
  }

  try {
    const profile = await parseTranscriptAndUpdate({ conversationId: conversation_id, ongId: ong_id });
    console.log(`[/onboarding/complete] Perfil completado: ${profile.ong_id} — ${profile.ong_name}`);
    return res.json({ ok: true, profile });
  } catch (e) {
    console.error('[/onboarding/complete] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// POST /webhook/elevenlabs — eventos post-llamada de ElevenLabs
// ─────────────────────────────────────────────

app.post('/webhook/elevenlabs', async (req, res) => {
  const body = req.body || {};

  // Normalizar distintos formatos de payload de ElevenLabs
  const conversationId = body.conversation_id ?? body.data?.conversation_id ?? null;
  const agentId        = body.agent_id        ?? body.data?.agent_id        ?? null;
  const transcript     = body.transcript      ?? body.data?.transcript      ?? [];
  const summary        = body.summary         ?? body.data?.analysis?.transcript_summary ?? body.data?.summary ?? '';

  if (!conversationId) {
    return res.status(400).json({ error: 'Payload sin conversation_id' });
  }

  const transcriptText = Array.isArray(transcript)
    ? transcript.map(t => t.message || '').join(' ')
    : String(transcript);

  // Determinar si es Sofia o Valentina
  const isSofia     = agentId ? agentId === SOFIA_AGENT_ID : false;
  const isValentina = agentId ? agentId === AGENT_ID       : false;

  // Si no hay agent_id, inferir por los registros locales
  const ongs  = readJson(ONG_PROFILES_PATH);
  const calls = readJson(CALLS_LOG_PATH);
  const pendingOng  = ongs.find(p => p.conversation_id === conversationId && p.status === 'call_initiated');
  const matchedCall = calls.find(c => c.conversation_id === conversationId);

  const actingSofia     = isSofia     || (!agentId && Boolean(pendingOng));
  const actingValentina = isValentina || (!agentId && Boolean(matchedCall) && !pendingOng);

  // ── SOFIA: parsear perfil de ONG automáticamente ───────────
  if (actingSofia && pendingOng && process.env.OPENAI_API_KEY) {
    parseTranscriptAndUpdate({ conversationId, ongId: pendingOng.ong_id })
      .then(p => console.log(`[webhook] Perfil de ONG actualizado automaticamente: ${p.ong_name} (${p.ong_id})`))
      .catch(e => console.warn(`[webhook] Auto-parse fallo: ${e.message}`));
    return res.json({ ok: true, conversation_id: conversationId, handled_by: 'sofia' });
  }

  // ── VALENTINA: detectar handoff en transcript ──────────────
  const HANDOFF_KEYWORDS = [
    'handoff', 'te llaman', 'alguien del equipo', 'te contactamos',
    'te paso con', 'hablo con alguien', 'no soy la indicada',
    'un humano', 'una persona', 'del equipo te va a llamar',
    'te van a contactar',
  ];
  const lowerText = (transcriptText + ' ' + summary).toLowerCase();
  const requiresHandoff = HANDOFF_KEYWORDS.some(kw => lowerText.includes(kw));

  const newStatus = requiresHandoff ? 'handoff_required' : 'completed';
  const updated = updateJsonByField(CALLS_LOG_PATH, 'conversation_id', conversationId, {
    status:     newStatus,
    updated_at: new Date().toISOString(),
    ...(requiresHandoff && { notes: 'Handoff detectado en transcript' }),
  });

  if (requiresHandoff && updated) {
    const call = readJson(CALLS_LOG_PATH).find(c => c.conversation_id === conversationId);
    const who  = call ? `${call.donor_name} ${call.donor_phone}` : conversationId;
    console.log(`⚠️  HANDOFF: ${who}`);
  } else if (updated) {
    console.log(`[webhook] conv=${conversationId} => ${newStatus}`);
  } else {
    console.log(`[webhook] conv=${conversationId} sin registro local (ignorado)`);
  }

  res.json({ ok: true, conversation_id: conversationId, status: newStatus });
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

  const exitosas       = calls.filter(c => c.status === 'initiated' || c.status === 'completed').length;
  const handoffs       = calls.filter(c => c.status === 'handoff_required');
  const ultima         = calls.length > 0 ? calls[calls.length - 1].timestamp : null;
  const ultimasDiez    = [...calls].reverse().slice(0, 10);

  res.json({
    total_ongs:           ongs.length,
    total_llamadas:       calls.length,
    llamadas_exitosas:    exitosas,
    handoffs_pendientes:  handoffs.length,
    ultima_llamada:       ultima,
    handoffs_detail:      handoffs.map(c => ({
      call_id:    c.call_id,
      donor_name: c.donor_name,
      donor_phone: c.donor_phone,
      ong_name:   c.ong_name,
      timestamp:  c.timestamp,
    })),
    ultimas_llamadas: ultimasDiez,
  });
});

// ─────────────────────────────────────────────
// Arranque
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nvoice-bot escuchando en http://localhost:${PORT}`);
  console.log('  GET  /health');
  console.log('  POST /call                    { phone, donor_name, last_amount, ong_name }');
  console.log('  POST /call/batch              [ { phone, donor_name, ... }, ... ]');
  console.log('  POST /onboarding              { phone, ong_name? }');
  console.log('  POST /onboarding/complete     { conversation_id, ong_id? }');
  console.log('  POST /webhook/elevenlabs      evento post-llamada de ElevenLabs');
  console.log('  GET  /calls');
  console.log('  GET  /ongs');
  console.log('  GET  /dashboard');
  console.log(`  GET  /ui/                     http://localhost:${PORT}/ui/`);
  if (!AGENT_ID || !AGENT_PHONE_NUMBER_ID) {
    console.warn('\n  AVISO: setup incompleto. Corre npm run setup.');
  }
});
