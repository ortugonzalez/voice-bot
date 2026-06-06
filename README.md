# Voice Bot — Llamadas para ONGs

Sistema de llamadas outbound para reactivar donantes. Usa ElevenLabs Conversational AI, un número de Twilio y OpenAI para procesar el onboarding de cada ONG.

## Funcionalidades

- **Sofía** llama a la ONG y crea su perfil a partir del transcript.
- **Valentina** llama a donantes con el contexto de la ONG.
- Detecta conversiones, handoffs, buzón de voz y llamadas sin respuesta.
- Permite campañas desde CSV con progreso visual.
- Reintenta llamadas fallidas y procesa llamadas encoladas.
- Respeta el horario de donantes de 10:00 a 20:00 de Argentina (UTC-3).
- Muestra métricas, campañas y transcripts en `/ui/`.
- Exporta y restaura los datos con `/backup` y `/restore`.

## Requisitos

- Node.js 18 o superior.
- Cuenta de ElevenLabs con acceso a Conversational AI y permiso `convai_write`.
- Cuenta de Twilio habilitada para llamadas salientes.
- OpenAI API key para procesar los transcripts de Sofía.

Las llamadas reales consumen saldo de ElevenLabs y Twilio. Usá únicamente números propios o con autorización.

## Instalación

```powershell
git clone https://github.com/ortugonzalez/voice-bot.git
cd voice-bot
npm ci
Copy-Item .env.example .env
```

Completá `.env` con las credenciales:

```env
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
ELEVENLABS_LLM=gemini-2.5-flash

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

OPENAI_API_KEY=
PORT=3100
DISABLE_BACKGROUND_JOBS=false
```

Después ejecutá:

```powershell
npm test
npm run setup
npm start
```

`npm run setup` crea o actualiza los agentes, importa el número de Twilio y guarda los IDs en `.env`. El procesamiento post-llamada funciona por polling cada 60 segundos; el webhook de ElevenLabs es opcional y se configura desde su dashboard.

## Verificación local

`npm test` ejecuta:

- 12 tests unitarios de intención y CSV.
- Un smoke test que levanta el servidor con los jobs desactivados.
- Verificaciones de `/health`, `/ui/` y `/calls`.

Con el servidor iniciado, abrí:

- Dashboard: [http://localhost:3100/ui/](http://localhost:3100/ui/)
- Health: [http://localhost:3100/health](http://localhost:3100/health)

El health debe mostrar:

```json
{
  "status": "ok",
  "ready": true,
  "valentina_configured": true,
  "sofia_configured": true,
  "phone_configured": true
}
```

Si `ready` es `false`, revisá `.env` y volvé a ejecutar `npm run setup`.

Si la llamada atiende y se corta inmediatamente, revisá el detalle en ElevenLabs.
El error `This request exceeds your quota limit` indica que la cuenta agotó su
cuota mensual; es necesario esperar el reinicio o ampliar el plan.

## Test final

Hacé el test de Valentina entre las 10:00 y las 20:00 de Argentina:

```powershell
npm run call -- +549XXXXXXXXXX
```

También podés usar `POST /call`:

```powershell
$body = @{
  phone       = "+549XXXXXXXXXX"
  donor_name  = "Nombre de prueba"
  last_amount = "1500"
  ong_name    = "ONG de prueba"
} | ConvertTo-Json

Invoke-RestMethod http://localhost:3100/call `
  -Method Post `
  -ContentType "application/json; charset=utf-8" `
  -Body $body
```

Checklist después de colgar:

1. Esperar hasta 60 segundos para que el polling actualice el resultado.
2. Abrir `/ui/` y confirmar que la llamada aparece.
3. Probar una aceptación explícita, por ejemplo “sí, quiero volver a donar”.
4. Confirmar que el estado sea `converted` y aumente `donantes_convertidos`.
5. Abrir “Ver transcript” y revisar hablante y tiempo `MM:SS`.
6. Probar un CSV con las columnas `phone,donor_name,last_amount,ong_name`.
7. Confirmar la campaña en `/campaigns`.

Para probar Sofía:

```powershell
$body = @{
  phone    = "+549XXXXXXXXXX"
  ong_name = "ONG de prueba"
} | ConvertTo-Json

Invoke-RestMethod http://localhost:3100/onboarding `
  -Method Post `
  -ContentType "application/json; charset=utf-8" `
  -Body $body
```

Al terminar la conversación, esperá hasta 60 segundos y verificá el perfil en `/ongs`.

## CSV

El dashboard acepta archivos separados por coma o punto y coma, incluidos archivos exportados por Excel. Las columnas obligatorias son:

```csv
phone,donor_name,last_amount,ong_name
+549XXXXXXXXXX,Nombre de prueba,1500,ONG de prueba
```

Si el CSV se inicia fuera del horario permitido, la campaña no comienza. Una llamada individual fuera de horario queda en estado `queued`.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Configuración, horario y uptime |
| `POST` | `/call` | Llamada individual a un donante |
| `POST` | `/call/batch` | Campaña a una lista de donantes |
| `POST` | `/onboarding` | Onboarding telefónico de una ONG |
| `POST` | `/onboarding/complete` | Procesamiento manual de un transcript |
| `POST` | `/webhook/elevenlabs` | Evento post-llamada opcional |
| `GET` | `/calls` | Historial de llamadas |
| `PATCH` | `/calls/:id` | Actualización manual de estado |
| `GET` | `/calls/:id/transcript` | Transcript desde ElevenLabs |
| `GET` | `/ongs` | Perfiles de ONGs |
| `GET` | `/campaigns` | Resumen de campañas |
| `GET` | `/dashboard` | Métricas y handoffs |
| `GET` | `/backup` | Exportación de datos |
| `POST` | `/restore` | Restauración de datos |
| `GET` | `/ui/` | Dashboard web |

## Producción

Despliegue verificado el 6 de junio de 2026:

- Dashboard: [voice-bot-production-63d2.up.railway.app/ui/](https://voice-bot-production-63d2.up.railway.app/ui/)
- Health: [voice-bot-production-63d2.up.railway.app/health](https://voice-bot-production-63d2.up.railway.app/health)

Para Railway, copiá las variables de `.env.railway.example` al panel. Railway inyecta `PORT` automáticamente.

Los logs se guardan en archivos JSON dentro del contenedor. Antes de recrear o redeployar el servicio, descargá un backup:

```powershell
Invoke-RestMethod https://voice-bot-production-63d2.up.railway.app/backup |
  ConvertTo-Json -Depth 10 |
  Out-File backup-$(Get-Date -Format 'yyyyMMdd-HHmm').json
```

## Jobs automáticos

- Polling de onboardings: cada 60 segundos.
- Polling de llamadas de Valentina: cada 60 segundos.
- Revisión de reintentos y cola: cada 5 minutos.
- Una llamada fallida se reintenta cuando pasaron 2 horas y tiene menos de 2 intentos.

Para desarrollo o mantenimiento:

```env
DISABLE_BACKGROUND_JOBS=true
```
