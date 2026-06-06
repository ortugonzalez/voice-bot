// test-call.js — Dispara una llamada de prueba contra el server local.
// Uso: npm run call   (el server tiene que estar corriendo: npm start)

import dotenv from 'dotenv';
dotenv.config({ path: new URL('./.env', import.meta.url) });

const PORT = process.env.PORT || 3100;

const payload = {
  phone: '+5492235428861',
  donor_name: 'Ortu',
  last_amount: '1500',
  ong_name: 'Pequenos Pasos',
};

const r = await fetch(`http://localhost:${PORT}/call`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
const data = await r.json();
console.log(`HTTP ${r.status}`);
console.log(JSON.stringify(data, null, 2));
process.exit(r.ok ? 0 : 1);
