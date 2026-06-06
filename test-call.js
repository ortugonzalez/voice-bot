// test-call.js — Llamada de prueba con Valentina.
// Antes de llamar, busca el perfil de la ONG en ong-profiles.json para personalizar.
// Uso: npm run call   (requiere npm start corriendo)

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('./.env', import.meta.url) });

const PORT = process.env.PORT || 3100;
const PHONE = process.argv[2] || process.env.TEST_PHONE;
const DONOR_NAME = process.env.TEST_DONOR_NAME || 'Donante de prueba';
const ONG_NAME = process.env.TEST_ONG_NAME || 'ONG de prueba';

if (!PHONE) {
  console.error('Falta el teléfono de prueba.');
  console.error('Uso: npm run call -- +549XXXXXXXXXX');
  console.error('Alternativa: definir TEST_PHONE en .env');
  process.exit(1);
}

if (!/^\+[1-9]\d{7,14}$/.test(PHONE)) {
  console.error('El teléfono debe estar en formato E.164, por ejemplo +549XXXXXXXXXX');
  process.exit(1);
}

// Buscar perfil de la ONG para enriquecer la llamada
const profilesPath = fileURLToPath(new URL('./ong-profiles.json', import.meta.url));
let ongProfile = null;
if (existsSync(profilesPath)) {
  try {
    const profiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
    ongProfile = profiles.find(p => p.ong_name === ONG_NAME && p.status !== 'call_failed') ?? null;
    if (ongProfile) console.log(`Perfil de ONG encontrado: ${ongProfile.ong_id}`);
  } catch { /* si el JSON es invalido, ignorar */ }
}

const payload = {
  phone:           PHONE,
  donor_name:      DONOR_NAME,
  last_amount:     '1500',
  ong_name:        ongProfile?.ong_name        ?? ONG_NAME,
  causa:           ongProfile?.causa           ?? 'acompañar a personas de la comunidad',
  tono:            ongProfile?.tono            ?? 'cercano y cálido',
  impacto_mensaje: ongProfile?.impacto_mensaje ?? 'Tu donación ayudó a sostener las actividades de este mes',
};

console.log('Iniciando llamada de prueba con payload:');
console.log(JSON.stringify(payload, null, 2));

const r = await fetch(`http://localhost:${PORT}/call`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
const data = await r.json();
console.log(`\nHTTP ${r.status}`);
console.log(JSON.stringify(data, null, 2));
process.exit(r.ok ? 0 : 1);
