// test-call.js — Llamada de prueba con Valentina.
// Antes de llamar, busca el perfil de la ONG en ong-profiles.json para personalizar.
// Uso: npm run call   (requiere npm start corriendo)

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('./.env', import.meta.url) });

const PORT = process.env.PORT || 3100;
const ONG_NAME = 'Pequeños Pasos';

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
  phone:           '+5492235428861',
  donor_name:      'Ortu',
  last_amount:     '1500',
  ong_name:        ongProfile?.ong_name        ?? ONG_NAME,
  causa:           ongProfile?.causa           ?? 'apoyar a ninos en situacion vulnerable',
  tono:            ongProfile?.tono            ?? 'cercano y calido',
  impacto_mensaje: ongProfile?.impacto_mensaje ?? 'Tu donacion ayudo a que 3 chicos tuvieran acceso a educacion este mes',
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
