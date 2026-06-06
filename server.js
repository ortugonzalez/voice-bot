// server.js — API del voice bot para ONGs (ElevenLabs + Twilio, integración nativa).
//
// Endpoints:
//   GET  /health                  estado del servidor
//   POST /call                    llamada individual a un donante
//   POST /call/batch              campaña a lista de donantes (30s entre llamadas)
//   POST /onboarding              llamada de onboarding con Sofía
//   POST /onboarding/complete     parsear transcript y completar perfil de ONG
//   POST /webhook/elevenlabs      evento post-llamada de ElevenLabs
//   PATCH /calls/:id              actualizar estado de una llamada
//   GET  /calls                   historial de llamadas
//   GET  /calls/:id/transcript    transcript de una llamada desde ElevenLabs
//   GET  /ongs                    perfiles de ONGs
//   GET  /dashboard               métricas generales + handoffs + conversiones
//   GET  /campaigns               historial de campañas
//   GET  /backup                  exportar datos
//   POST /restore                 restaurar datos desde backup
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
const __dirname          = dirname(fileURLToPath(import.meta.url));
const CALLS_LOG_PATH     = fileURLToPath(new URL('./calls-log.json',     import.meta.url));
const ONG_PROFILES_PATH  = fileURLToPath(new URL('./ong-profiles.json',  import.meta.url));
const CAMPAIGNS_LOG_PATH = fileURLToPath(new URL('./campaigns-log.json', import.meta.url));

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
// Helper: horario de llamadas (10-20hs Argentina)
// Argentina es UTC-3, sin horario de verano
// ─────────────────────────────────────────────

function getArgentinaHour() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCHours();
}

function isWithinCallingHours() {
  const hour = getArgentinaHour();
  return hour >= 10 && hour < 20;
}

// ─────────────────────────────────────────────
// Helper: normalizar texto para comparación de keywords
// ─────────────────────────────────────────────

function normalizeText(text) {
  // U+0300–U+036F: bloque de diacríticos combinantes (tildes, etc.)
  return String(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

// ─────────────────────────────────────────────
// Helper: prompt personalizado por ONG para Valentina
// ─────────────────────────────────────────────

function buildONGPrompt(profile) {
  // Nota: ${{last_amount}} en string regular (sin template literal) para que ElevenLabs lo reemplace.
  const histLine = 'La ultima vez que donaste fueron ${{last_amount}} y con eso ayudamos a ' +
    'muchas personas gracias a ' + (profile.causa || 'nuestra causa') + '.';

  return 'Sos Valentina, asistente de llamadas de ' + profile.ong_name + ' en Argentina.\n' +
    'La causa que trabajan: ' + (profile.causa || 'ayudar a quienes mas lo necesitan') + '.\n' +
    'Tono de comunicacion: ' + (profile.tono || 'cercano y calido') + '.\n' +
    'Mensaje de impacto: "' + (profile.impacto_mensaje || '') + '".\n' +
    'Pronuncias correctamente todas las palabras en espanol argentino incluyendo ñ, á, é, í, ó, ú. ' +
    'Nunca pronuncies "pequenos" sino siempre "pequeños".\n' +
    'Usas espanol rioplatense — "vos", "che", "dale", "buenisimo".\n' +
    'Al atender decis: "Hola {{donor_name}}, te llamo de ' + profile.ong_name + '. ' + histLine + '"\n' +
    'Si preguntan sobre montos o administracion: "Eso te lo explica mejor alguien del equipo, queres que te llamen?" — marcas handoff_required = true.\n' +
    'Si no puede donar ahora, preguntas si podes llamar en otro momento.\n' +
    'Cerras siempre con calidez, nunca cortes abruptamente.';
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
    agent_id:                            agentId,
    agent_phone_number_id:               AGENT_PHONE_NUMBER_ID,
    to_number:                           toNumber,
    conversation_initiation_client_data: initData,
  };
  const r = await fetch(`${API}/v1/convai/twilio/outbound-call`, {
    method: 'POST',
    headers: {
      'xi-api-key':   ELEVENLABS_API_KEY,
      'Content-Type': 'application/json; charset=utf-8',
    },
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
      prompt:        { prompt: buildONGPrompt(profile) },
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
    within_calling_hours: isWithinCallingHours(),
    argentina_hour:       getArgentinaHour(),
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

  // Verificar horario permitido (10-20hs Argentina)
  if (!isWithinCallingHours()) {
    const logEntry = {
      call_id:     randomUUID(),
      donor_name:  donor_name  ?? 'donante',
      donor_phone: phone,
      ong_name:    ong_name    ?? 'la ONG',
      last_amount: last_amount ?? '',
      timestamp:   new Date().toISOString(),
      status:      'queued',
      notes:       'Fuera de horario, encolada para las 10:00',
      attempts:    0,
    };
    appendJson(CALLS_LOG_PATH, logEntry);
    console.log(`[/call] Encolada fuera de horario: ${phone} (hora AR: ${getArgentinaHour()}hs)`);
    return res.json({
      ok:      false,
      message: 'Fuera de horario permitido (10-20hs Argentina). Llamada encolada para las 10:00.',
    });
  }

  const configOverride = getONGOverride(ong_name);
  if (configOverride) {
    console.log(`[/call] Usando perfil completo de "${ong_name}"`);
  } else {
    console.log(`[/call] Usando prompt generico${ong_name ? ` (perfil de "${ong_name}" incompleto o no encontrado)` : ''}`);
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
    attempts:        1,
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
// POST /call/batch — campaña a lista de donantes
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

  // Verificar horario antes de iniciar la campaña
  if (!isWithinCallingHours()) {
    return res.json({
      ok:      false,
      message: 'Fuera de horario permitido (10-20hs Argentina). Campaña no iniciada.',
    });
  }

  const campaignId = randomUUID();
  const startTime  = Date.now();
  console.log(`[/call/batch] Campana ${campaignId} iniciada: ${donors.length} donantes, 30s entre llamadas.`);

  res.json({
    ok:          true,
    campaign_id: campaignId,
    total:       donors.length,
    message:     `Campana iniciada. Se realizaran ${donors.length} llamadas con 30 segundos de intervalo.`,
  });

  (async () => {
    const results = [];
    for (let i = 0; i < donors.length; i++) {
      if (i > 0) {
        console.log(`[/call/batch] Esperando 30s antes de llamada ${i + 1}/${donors.length}...`);
        await new Promise(resolve => setTimeout(resolve, 30_000));
      }

      const { phone, donor_name, last_amount, ong_name, causa, tono, impacto_mensaje } = donors[i];

      // Verificar horario por si la campaña se extendió fuera de horario
      if (!isWithinCallingHours()) {
        console.log(`[/call/batch] Fuera de horario, encolando llamada ${i + 1}/${donors.length}`);
        const logEntry = {
          call_id:         randomUUID(),
          campaign_id:     campaignId,
          conversation_id: null,
          donor_name:      donor_name  ?? 'donante',
          donor_phone:     phone,
          ong_name:        ong_name    ?? 'la ONG',
          last_amount:     last_amount ?? '',
          timestamp:       new Date().toISOString(),
          status:          'queued',
          notes:           'Fuera de horario, encolada para las 10:00',
          attempts:        0,
        };
        appendJson(CALLS_LOG_PATH, logEntry);
        results.push(logEntry);
        continue;
      }

      const configOverride = getONGOverride(ong_name);
      console.log(configOverride
        ? `[/call/batch] Usando perfil completo de "${ong_name}"`
        : `[/call/batch] Usando prompt generico${ong_name ? ` ("${ong_name}" incompleto)` : ''}`
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
        attempts:        1,
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
      results.push(logEntry);
    }

    // Guardar resumen de campaña
    const campaignSummary = {
      batch_id:               campaignId,
      total:                  donors.length,
      exitosas:               results.filter(r => r.status === 'initiated').length,
      convertidos:            0,
      handoffs:               0,
      fallidas:               results.filter(r => r.status === 'failed').length,
      encoladas:              results.filter(r => r.status === 'queued').length,
      duracion_total_minutos: Math.round((Date.now() - startTime) / 60000),
      started_at:             new Date(startTime).toISOString(),
      completed_at:           new Date().toISOString(),
    };
    appendJson(CAMPAIGNS_LOG_PATH, campaignSummary);
    console.log(`[/call/batch] Campana ${campaignId} completada. Resumen:`, campaignSummary);
  })();
});

// ─────────────────────────────────────────────
// POST /onboarding — llamada de onboarding con Sofía
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

  // Determinar si es Sofía o Valentina
  const isSofia     = agentId ? agentId === SOFIA_AGENT_ID : false;
  const isValentina = agentId ? agentId === AGENT_ID       : false;

  const ongs  = readJson(ONG_PROFILES_PATH);
  const calls = readJson(CALLS_LOG_PATH);
  const pendingOng  = ongs.find(p => p.conversation_id === conversationId && p.status === 'call_initiated');
  const matchedCall = calls.find(c => c.conversation_id === conversationId);

  const actingSofia     = isSofia     || (!agentId && Boolean(pendingOng));
  const actingValentina = isValentina || (!agentId && Boolean(matchedCall) && !pendingOng);

  // ── SOFÍA: parsear perfil de ONG automáticamente ───────────
  if (actingSofia && pendingOng && process.env.OPENAI_API_KEY) {
    parseTranscriptAndUpdate({ conversationId, ongId: pendingOng.ong_id })
      .then(p => console.log(`[webhook] Perfil de ONG actualizado automaticamente: ${p.ong_name} (${p.ong_id})`))
      .catch(e => console.warn(`[webhook] Auto-parse fallo: ${e.message}`));
    return res.json({ ok: true, conversation_id: conversationId, handled_by: 'sofia' });
  }

  // ── VALENTINA: detectar conversión y handoff en transcript ──
  const CONVERTED_KEYWORDS = [
    'si quiero donar', 'como hago para donar', 'me anoto',
    'dale', 'si me interesa', 'como lo hago', 'por supuesto',
    'claro que si', 'cuanto seria', 'como pago',
  ];
  const HANDOFF_KEYWORDS = [
    'handoff', 'te llaman', 'alguien del equipo', 'te contactamos',
    'te paso con', 'hablo con alguien', 'no soy la indicada',
    'un humano', 'una persona', 'del equipo te va a llamar',
    'te van a contactar',
  ];

  const lowerText = normalizeText(transcriptText + ' ' + summary);

  const isConverted    = CONVERTED_KEYWORDS.some(kw => lowerText.includes(normalizeText(kw)));
  const requiresHandoff = !isConverted && HANDOFF_KEYWORDS.some(kw => lowerText.includes(normalizeText(kw)));

  const newStatus = isConverted ? 'converted' : (requiresHandoff ? 'handoff_required' : 'completed');
  const updated = updateJsonByField(CALLS_LOG_PATH, 'conversation_id', conversationId, {
    status:     newStatus,
    updated_at: new Date().toISOString(),
    ...(isConverted    && { notes: 'Donante convertido' }),
    ...(requiresHandoff && { notes: 'Handoff detectado en transcript' }),
  });

  if (isConverted && updated) {
    const call = readJson(CALLS_LOG_PATH).find(c => c.conversation_id === conversationId);
    const who  = call ? `${call.donor_name} ${call.donor_phone}` : conversationId;
    console.log(`✅ CONVERTIDO: ${who}`);
  } else if (requiresHandoff && updated) {
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
// PATCH /calls/:id — actualizar estado de una llamada
// Body: { status, notes? }
// ─────────────────────────────────────────────

app.patch('/calls/:id', (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body || {};
  if (!status) return res.status(400).json({ error: 'Falta "status"' });

  const updated = updateJsonByField(CALLS_LOG_PATH, 'call_id', id, {
    status,
    ...(notes !== undefined && { notes }),
    updated_at: new Date().toISOString(),
  });

  if (!updated) return res.status(404).json({ error: `Llamada "${id}" no encontrada` });

  const call = readJson(CALLS_LOG_PATH).find(c => c.call_id === id);
  console.log(`[/calls/${id}] status => ${status}`);
  return res.json({ ok: true, call });
});

// ─────────────────────────────────────────────
// GET /calls/:id/transcript — transcript de una llamada
// ─────────────────────────────────────────────

app.get('/calls/:id/transcript', async (req, res) => {
  const call = readJson(CALLS_LOG_PATH).find(c => c.call_id === req.params.id);
  if (!call) return res.status(404).json({ error: 'Llamada no encontrada' });
  if (!call.conversation_id) {
    return res.status(404).json({ error: 'Esta llamada no tiene conversation_id registrado' });
  }
  if (!ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: 'Falta ELEVENLABS_API_KEY' });
  }

  try {
    const r = await fetch(`${API}/v1/convai/conversations/${call.conversation_id}`, {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    });
    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ error: `ElevenLabs ${r.status}: ${errText}` });
    }
    const conv = await r.json();

    const secsToMMSS = s => {
      if (s == null) return null;
      const m = Math.floor(s / 60);
      const sec = Math.round(s % 60);
      return `${m}:${String(sec).padStart(2, '0')}`;
    };

    const transcript = (conv.transcript || []).map(t => ({
      speaker:    t.role === 'agent' ? 'Valentina' : 'Donante',
      message:    t.message || '',
      time_mmss:  secsToMMSS(t.time_in_call_secs),
      time_secs:  t.time_in_call_secs ?? null,
    }));

    return res.json({
      call_id:         call.call_id,
      conversation_id: call.conversation_id,
      donor_name:      call.donor_name,
      ong_name:        call.ong_name,
      status:          call.status,
      timestamp:       call.timestamp,
      duration_secs:   conv.metadata?.call_duration_secs ?? null,
      transcript,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// GET /backup — exportar calls + ONGs como JSON
// ─────────────────────────────────────────────

app.get('/backup', (_req, res) => {
  const calls     = readJson(CALLS_LOG_PATH);
  const ongs      = readJson(ONG_PROFILES_PATH);
  const campaigns = readJson(CAMPAIGNS_LOG_PATH);
  res.json({ exported_at: new Date().toISOString(), version: 2, calls, ongs, campaigns });
});

// ─────────────────────────────────────────────
// POST /restore — restaurar calls + ONGs desde backup
// Body: { calls: [...], ongs: [...], campaigns?: [...] }
// ─────────────────────────────────────────────

app.post('/restore', (req, res) => {
  const { calls, ongs, campaigns } = req.body || {};
  if (!Array.isArray(calls)) return res.status(400).json({ error: 'Falta "calls" como array' });
  if (!Array.isArray(ongs))  return res.status(400).json({ error: 'Falta "ongs" como array' });
  writeFileSync(CALLS_LOG_PATH,    JSON.stringify(calls,     null, 2), 'utf8');
  writeFileSync(ONG_PROFILES_PATH, JSON.stringify(ongs,      null, 2), 'utf8');
  if (Array.isArray(campaigns)) {
    writeFileSync(CAMPAIGNS_LOG_PATH, JSON.stringify(campaigns, null, 2), 'utf8');
  }
  console.log(`[/restore] ${calls.length} calls + ${ongs.length} ONGs restaurados.`);
  return res.json({ ok: true, calls_restored: calls.length, ongs_restored: ongs.length });
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
// GET /campaigns — historial de campañas
// ─────────────────────────────────────────────

app.get('/campaigns', (_req, res) => {
  const campaigns = readJson(CAMPAIGNS_LOG_PATH);
  res.json({ total: campaigns.length, campaigns: [...campaigns].reverse() });
});

// ─────────────────────────────────────────────
// GET /dashboard — métricas generales
// ─────────────────────────────────────────────

app.get('/dashboard', (_req, res) => {
  const calls = readJson(CALLS_LOG_PATH);
  const ongs  = readJson(ONG_PROFILES_PATH);

  const exitosas    = calls.filter(c => c.status === 'initiated' || c.status === 'completed').length;
  const convertidos = calls.filter(c => c.status === 'converted').length;
  const handoffs    = calls.filter(c => c.status === 'handoff_required');
  const ultima      = calls.length > 0 ? calls[calls.length - 1].timestamp : null;
  const ultimasDiez = [...calls].reverse().slice(0, 10);

  res.json({
    total_ongs:           ongs.length,
    total_llamadas:       calls.length,
    llamadas_exitosas:    exitosas,
    donantes_convertidos: convertidos,
    handoffs_pendientes:  handoffs.length,
    ultima_llamada:       ultima,
    within_calling_hours: isWithinCallingHours(),
    handoffs_detail:      handoffs.map(c => ({
      call_id:     c.call_id,
      donor_name:  c.donor_name,
      donor_phone: c.donor_phone,
      ong_name:    c.ong_name,
      timestamp:   c.timestamp,
    })),
    ultimas_llamadas: ultimasDiez,
  });
});

// ─────────────────────────────────────────────
// Background: polling automático de onboardings
// ElevenLabs no expone webhook via API; chequeamos cada 60s
// ─────────────────────────────────────────────

async function pollPendingOnboardings() {
  if (!process.env.OPENAI_API_KEY || !ELEVENLABS_API_KEY) return;

  const pending = readJson(ONG_PROFILES_PATH)
    .filter(p => p.status === 'call_initiated' && p.conversation_id);

  for (const profile of pending) {
    try {
      const r = await fetch(`${API}/v1/convai/conversations/${profile.conversation_id}`, {
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      });
      if (!r.ok) continue;
      const conv = await r.json();

      const ended       = conv.status && conv.status !== 'processing';
      const hasTranscript = Array.isArray(conv.transcript) && conv.transcript.length > 0;
      if (!ended && !hasTranscript) continue;

      await parseTranscriptAndUpdate({ conversationId: profile.conversation_id, ongId: profile.ong_id });
      console.log(`[poll] Perfil de ONG completado automaticamente: ${profile.ong_name}`);
    } catch {
      // Silencioso — reintenta en el próximo ciclo
    }
  }
}

// ─────────────────────────────────────────────
// Background: reintentos automáticos cada 2hs
// Reintentar llamadas fallidas (max 2 intentos)
// Procesar llamadas encoladas si es horario hábil
// ─────────────────────────────────────────────

async function retryAndProcessCalls() {
  if (!AGENT_ID || !AGENT_PHONE_NUMBER_ID || !ELEVENLABS_API_KEY) return;

  const calls = readJson(CALLS_LOG_PATH);
  const withinHours = isWithinCallingHours();

  // Llamadas fallidas con intentos restantes
  const failedToRetry = calls.filter(c =>
    c.status === 'failed' && (c.attempts ?? 1) < 2
  );

  // Llamadas encoladas por horario, solo si ahora es horario hábil
  const queuedToProcess = withinHours
    ? calls.filter(c => c.status === 'queued')
    : [];

  const toProcess = [...failedToRetry, ...queuedToProcess];
  if (toProcess.length === 0) return;

  console.log(`[retry] Procesando ${toProcess.length} llamadas (${failedToRetry.length} fallidas, ${queuedToProcess.length} encoladas)`);

  for (const call of toProcess) {
    const isQueued = call.status === 'queued';
    const attempts = isQueued ? 1 : (call.attempts ?? 1) + 1;
    console.log(`[retry] ↻ Reintento ${attempts}/2: ${call.donor_name}`);

    const configOverride = getONGOverride(call.ong_name);
    const dynamicVars = {
      donor_name:      call.donor_name  ?? 'donante',
      last_amount:     call.last_amount ?? '',
      ong_name:        call.ong_name    ?? 'la ONG',
      causa:           'ayudar a quienes mas lo necesitan',
      tono:            'cercano y calido',
      impacto_mensaje: '',
    };

    try {
      const data = await makeCall(AGENT_ID, call.donor_phone, dynamicVars, configOverride);
      updateJsonByField(CALLS_LOG_PATH, 'call_id', call.call_id, {
        status:          data.success ? 'initiated' : 'failed',
        conversation_id: data.conversation_id ?? null,
        attempts,
        notes:           `Reintento ${attempts}: ${data.message ?? ''}`,
        last_retry_at:   new Date().toISOString(),
      });
      console.log(`[retry] OK: ${call.donor_name} conv=${data.conversation_id}`);
    } catch (e) {
      updateJsonByField(CALLS_LOG_PATH, 'call_id', call.call_id, {
        attempts,
        notes:         `Reintento ${attempts} fallido: ${e.message}`,
        last_retry_at: new Date().toISOString(),
      });
      console.error(`[retry] Fallo ${call.donor_name}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────
// Arranque
// ─────────────────────────────────────────────

setTimeout(() => {
  pollPendingOnboardings();
  setInterval(pollPendingOnboardings, 60_000);
}, 30_000);

setInterval(retryAndProcessCalls, 2 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`\nvoice-bot escuchando en http://localhost:${PORT}`);
  console.log('  GET  /health');
  console.log('  POST /call                    { phone, donor_name, last_amount, ong_name }');
  console.log('  POST /call/batch              [ { phone, donor_name, ... }, ... ]');
  console.log('  POST /onboarding              { phone, ong_name? }');
  console.log('  POST /onboarding/complete     { conversation_id, ong_id? }');
  console.log('  POST /webhook/elevenlabs      evento post-llamada de ElevenLabs');
  console.log('  PATCH /calls/:id              { status }');
  console.log('  GET  /calls');
  console.log('  GET  /calls/:id/transcript');
  console.log('  GET  /ongs');
  console.log('  GET  /dashboard');
  console.log('  GET  /campaigns');
  console.log('  GET  /backup');
  console.log('  POST /restore                 { calls, ongs, campaigns? }');
  console.log(`  GET  /ui/                     http://localhost:${PORT}/ui/`);
  if (!AGENT_ID || !AGENT_PHONE_NUMBER_ID) {
    console.warn('\n  AVISO: setup incompleto. Corre npm run setup.');
  }
});
