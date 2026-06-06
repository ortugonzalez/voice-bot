# Voice Bot — Sistema de llamadas para ONGs

## Qué hace
- **Agente Valentina**: llama a donantes existentes, cuenta el impacto de su donación y los reactiva
- **Agente Sofía**: onboarding conversacional de nuevas ONGs al sistema
- **Dashboard**: métricas de campañas en tiempo real

## Requisitos
- Node.js 18+
- Cuenta ElevenLabs (plan con permiso `convai_write`)
- Cuenta Twilio (upgradeada, no trial)
- ngrok (opcional, solo para desarrollo local con webhooks)

## Setup en 5 pasos
1. `git clone https://github.com/ortugonzalez/voice-bot.git`
2. `cd voice-bot && npm install`
3. `cp .env.example .env` — completar con tus keys
4. `npm run setup` — crea los agentes en ElevenLabs e importa el número de Twilio
5. `npm start` — levanta el servidor en puerto 3100

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/call` | Llama a un donante individual |
| `POST` | `/call/batch` | Campaña a una lista de donantes |
| `POST` | `/onboarding` | Inicia el onboarding de una ONG nueva |
| `GET` | `/calls` | Historial de llamadas realizadas |
| `GET` | `/ongs` | Perfiles de ONGs registradas |
| `GET` | `/dashboard` | Métricas generales de campañas |
| `GET` | `/health` | Estado del servidor y configuración |

## Variables de entorno necesarias

```env
# ElevenLabs — requiere plan con Conversational AI habilitado
ELEVENLABS_API_KEY=        # API key con permiso convai_write (y voices_read recomendado)
ELEVENLABS_VOICE_ID=       # ID de la voz del agente (default: Sarah, multilingüe)
ELEVENLABS_TTS_MODEL=      # Modelo TTS (default: eleven_flash_v2_5)
ELEVENLABS_LLM=            # LLM del agente (default: gemini-2.5-flash)

# Completados automáticamente por `npm run setup`
AGENT_ID=                  # ID del agente Valentina en ElevenLabs
AGENT_PHONE_NUMBER_ID=     # ID del número de Twilio importado en ElevenLabs

# Twilio — cuenta upgradeada (sin restricciones trial)
TWILIO_ACCOUNT_SID=        # Account SID (empieza con AC...)
TWILIO_AUTH_TOKEN=         # Auth Token
TWILIO_PHONE_NUMBER=       # Número comprado, formato E.164 (ej: +16693381855)

# Servidor
PORT=3100                  # Puerto del servidor Express
```

## Cómo testear sin instalar nada

El servidor ya está corriendo. Solo necesitás un número de teléfono y ejecutar uno de estos comandos.

### Recibir una llamada de Valentina (donante)

```powershell
Invoke-RestMethod http://https://voice-bot-production-63d2.up.railway.app/call -Method Post -ContentType "application/json" -Body '{"phone":"+549TU_NUMERO","donor_name":"Tu Nombre","last_amount":"1500","ong_name":"Pequeños Pasos"}'
```

### Recibir una llamada de Sofía (onboarding)

```powershell
Invoke-RestMethod http://https://voice-bot-production-63d2.up.railway.app/onboarding -Method Post -ContentType "application/json" -Body '{"phone":"+549TU_NUMERO","ong_name":"Tu ONG"}'
```

### Ver el dashboard de métricas

```powershell
Invoke-RestMethod http://https://voice-bot-production-63d2.up.railway.app/dashboard
```

### Ver todas las llamadas registradas

```powershell
Invoke-RestMethod http://https://voice-bot-production-63d2.up.railway.app/calls
```

Reemplazá `https://voice-bot-production-63d2.up.railway.app` con la URL que te pase el equipo.
Reemplazá `+549TU_NUMERO` con tu número argentino en formato internacional.

---

## Ejemplo de llamada rápida

**Llamada individual** (`POST /call`):

```bash
# curl
curl -X POST http://localhost:3100/call \
  -H "Content-Type: application/json" \
  -d '{"phone":"+5492235428861","donor_name":"María","last_amount":"1500","ong_name":"Pequeños Pasos"}'

# PowerShell
Invoke-RestMethod -Uri http://localhost:3100/call -Method Post `
  -ContentType "application/json" `
  -Body '{"phone":"+5492235428861","donor_name":"Maria","last_amount":"1500","ong_name":"Pequenos Pasos"}'
```

**Health check** (`GET /health`):

```bash
curl http://localhost:3100/health
```

**Test completo desde el repo**:

```bash
npm run call   # ejecuta test-call.js con datos de ejemplo
```
