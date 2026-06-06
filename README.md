# Voice Bot — Sistema de llamadas para ONGs

## Qué hace
- **Sofía**: llama a la ONG, hace preguntas y extrae los datos del equipo automáticamente
- **Valentina**: llama a donantes con el contexto real de la ONG y los reactiva
- **Dashboard**: métricas, CSV, conversiones, handoffs y transcripts en `/ui/`

---

## Demo en vivo — 5 minutos

### El flujo completo

```
1. Sofía llama a la ONG
        ↓
   (Conversación natural, ~3 min)
        ↓
2. Webhook o polling detectan el final
        ↓
   GPT-4o-mini extrae: causa, tono, equipo, impacto
        ↓
3. Valentina llama a donantes
   con el contexto real de esa ONG
        ↓
4. El resultado queda clasificado
   → convertido, handoff, buzón de voz o completado
```

### Comandos para la demo

**Paso 1 — Onboarding de la ONG (Sofía):**
```powershell
Invoke-RestMethod https://voice-bot-production-63d2.up.railway.app/onboarding -Method Post -ContentType "application/json" -Body '{"phone":"+549TU_NUMERO","ong_name":"Nombre de la ONG"}'
```

**Paso 2 — Verificar perfil completado (esperar ~60s después de colgar):**
```powershell
Invoke-RestMethod https://voice-bot-production-63d2.up.railway.app/ongs | ConvertTo-Json -Depth 5
```

**Paso 3 — Llamar a un donante con Valentina:**
```powershell
Invoke-RestMethod https://voice-bot-production-63d2.up.railway.app/call -Method Post -ContentType "application/json" -Body '{"phone":"+549NUMERO_DONANTE","donor_name":"Nombre","last_amount":"1500","ong_name":"Nombre de la ONG"}'
```

**Dashboard en tiempo real:**
→ https://voice-bot-production-63d2.up.railway.app/ui/

### Backup antes de cada demo
> ⚠️ Los datos viven en archivos JSON del contenedor y pueden perderse al recrearlo.
> Hacer backup antes de la demo y restaurar si es necesario.

```powershell
# Guardar backup
Invoke-RestMethod https://voice-bot-production-63d2.up.railway.app/backup | ConvertTo-Json -Depth 10 | Out-File backup-$(Get-Date -Format 'yyyyMMdd-HHmm').json

# Restaurar backup
$backup = Get-Content backup-FECHA.json | ConvertFrom-Json
Invoke-RestMethod https://voice-bot-production-63d2.up.railway.app/restore -Method Post -ContentType "application/json" -Body ($backup | ConvertTo-Json -Depth 10)
```

---

## Setup en 5 pasos

1. `git clone https://github.com/ortugonzalez/voice-bot.git`
2. `cd voice-bot && npm install`
3. `cp .env.example .env` — completar con tus keys
4. `npm run setup` — crea los agentes en ElevenLabs, importa el número y configura webhooks
5. `npm start` — levanta el servidor en puerto 3100

## Requisitos
- Node.js 18+
- Cuenta ElevenLabs (plan con permiso `convai_write`)
- Cuenta Twilio (upgradeada, no trial)
- OpenAI API key (para parsear transcripts con gpt-4o-mini)

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/call` | Llama a un donante individual |
| `POST` | `/call/batch` | Campaña a una lista de donantes |
| `POST` | `/onboarding` | Inicia el onboarding de una ONG nueva |
| `POST` | `/onboarding/complete` | Parsea el transcript y completa el perfil |
| `POST` | `/webhook/elevenlabs` | Evento post-llamada de ElevenLabs |
| `PATCH`| `/calls/:id` | Actualizar estado de una llamada |
| `GET`  | `/calls` | Historial de llamadas realizadas |
| `GET`  | `/calls/:id/transcript` | Transcript de una llamada |
| `GET`  | `/ongs` | Perfiles de ONGs registradas |
| `GET`  | `/campaigns` | Resumen de campañas |
| `GET`  | `/dashboard` | Métricas, conversiones y handoffs |
| `GET`  | `/backup` | Exportar llamadas, ONGs y campañas |
| `POST` | `/restore` | Restaurar datos desde backup |
| `GET`  | `/health` | Estado del servidor |
| `GET`  | `/ui/` | Dashboard web |

## Variables de entorno

```env
# ElevenLabs
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
ELEVENLABS_LLM=gemini-2.5-flash
AGENT_ID=                  # Valentina — completado por npm run setup
SOFIA_AGENT_ID=            # Sofía — completado por npm run setup
AGENT_PHONE_NUMBER_ID=     # completado por npm run setup

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=       # E.164 (ej: +16693381855)

# OpenAI
OPENAI_API_KEY=

# Servidor
PORT=3100
DISABLE_BACKGROUND_JOBS=false
```

## Pruebas

`npm test` ejecuta únicamente tests unitarios. Las llamadas reales se disparan de
forma explícita con `npm run call`.

## Cómo testear sin instalar nada

El servidor ya está corriendo. Solo necesitás un número de teléfono y ejecutar uno de estos comandos.

### Recibir una llamada de Valentina (donante)

```powershell
Invoke-RestMethod https://voice-bot-production-63d2.up.railway.app/call -Method Post -ContentType "application/json" -Body '{"phone":"+549TU_NUMERO","donor_name":"Tu Nombre","last_amount":"1500","ong_name":"Pequeños Pasos"}'
```

### Recibir una llamada de Sofía (onboarding)

```powershell
Invoke-RestMethod https://voice-bot-production-63d2.up.railway.app/onboarding -Method Post -ContentType "application/json" -Body '{"phone":"+549TU_NUMERO","ong_name":"Tu ONG"}'
```

### Ver el dashboard de métricas

```powershell
Invoke-RestMethod https://voice-bot-production-63d2.up.railway.app/dashboard
```

### Ver todas las llamadas registradas

```powershell
Invoke-RestMethod https://voice-bot-production-63d2.up.railway.app/calls
```

Reemplazá `+549TU_NUMERO` con tu número argentino en formato internacional.
