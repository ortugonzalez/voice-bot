# voice-bot — Agente de llamadas outbound para ONGs

Bot de voz que llama a donantes de ONGs argentinas para contarles el impacto de su donación e intentar reactivarlos. Habla en español rioplatense. Si el donante pregunta algo complejo (montos, administración de fondos), el bot deriva a un humano del equipo.

**Stack:** Node.js · Express · ElevenLabs Conversational AI · Twilio

---

## Requisitos

- Node.js 18+
- Cuenta en [ElevenLabs](https://elevenlabs.io) con acceso a **Conversational AI** (plan Starter o superior). La API key necesita el permiso `convai_write`.
- Cuenta en [Twilio](https://twilio.com) con un número de teléfono activo.
- _(Opcional)_ [ngrok](https://ngrok.com) si necesitás exponer el server localmente para tests manuales vía webhook.

---

## Setup

### 1. Clonar e instalar dependencias

```bash
git clone <URL-del-repo>
cd voice-bot
npm install
```

### 2. Configurar variables de entorno

Copiá el archivo de ejemplo y completalo con tus credenciales:

```bash
cp .env.example .env
```

Editá `.env` con tus valores reales (ver sección [Variables de entorno](#variables-de-entorno)).

### 3. Crear el agente e importar el número de Twilio

```bash
npm run setup
```

Esto crea el agente "Valentina" en ElevenLabs, importa tu número de Twilio y guarda el `AGENT_ID` y `AGENT_PHONE_NUMBER_ID` en `.env` automáticamente. Es **idempotente**: si ya existen, no los recrea.

### 4. Levantar el servidor

```bash
npm start
```

El server queda escuchando en `http://localhost:3100`.

```
GET  /health   → estado del servidor y si el setup está completo
POST /call     → inicia una llamada saliente
```

### 5. Hacer una llamada de prueba

```bash
npm run call
```

Llama al número configurado en `test-call.js` con datos de donante de ejemplo.

O bien, con curl:

```bash
curl -X POST http://localhost:3100/call \
  -H "Content-Type: application/json" \
  -d '{"phone":"+5491112345678","donor_name":"María","last_amount":"1500","ong_name":"Pequeños Pasos"}'
```

---

## Variables de entorno

Crear un archivo `.env` en la raíz con estas variables (nunca committear los valores reales):

```env
# ElevenLabs
ELEVENLABS_API_KEY=        # API key con permiso convai_write
ELEVENLABS_VOICE_ID=       # ID de voz (default: Sarah, multilingüe)
ELEVENLABS_TTS_MODEL=      # Modelo TTS (default: eleven_flash_v2_5)
ELEVENLABS_LLM=            # LLM del agente (default: gemini-2.5-flash)

# Se completan automáticamente con `npm run setup`:
AGENT_ID=
AGENT_PHONE_NUMBER_ID=

# Twilio
TWILIO_ACCOUNT_SID=        # Account SID de Twilio
TWILIO_AUTH_TOKEN=         # Auth Token de Twilio
TWILIO_PHONE_NUMBER=       # Número en formato E.164 (ej: +16693381855)

# Servidor
PORT=3100
```

---

## Arquitectura

Usa la **integración nativa** de ElevenLabs + Twilio: ElevenLabs maneja el audio de la llamada y configura los webhooks de Twilio al importar el número. No se necesita ngrok ni websocket manual.

```
POST /call
  └─> ElevenLabs /v1/convai/twilio/outbound-call
        └─> Twilio (llama al donante)
              └─> Agente "Valentina" (audio en tiempo real)
```

Los datos del donante (`donor_name`, `last_amount`, `ong_name`) se pasan como `dynamic_variables` y el agente los usa en el system prompt con `{{donor_name}}`, etc.
