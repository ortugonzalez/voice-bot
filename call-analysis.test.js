import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyValentinaCall, normalizeText } from './call-analysis.js';

test('normaliza acentos y espacios', () => {
  assert.equal(normalizeText('  Sí,  ¿CÓMO hago?  '), 'si, ¿como hago?');
});

test('no convierte por palabras dichas solamente por Valentina', () => {
  const result = classifyValentinaCall({
    transcript: [
      { role: 'agent', message: 'Dale, si querés donar te explico cómo.' },
      { role: 'user', message: 'No, no me interesa.' },
    ],
  });

  assert.equal(result.status, 'completed');
});

test('convierte con una intención explícita del donante', () => {
  const result = classifyValentinaCall({
    transcript: [
      { role: 'agent', message: '¿Te gustaría volver a colaborar?' },
      { role: 'user', message: 'Sí, quiero volver a donar.' },
    ],
  });

  assert.equal(result.status, 'converted');
});

test('acepta dale solo como respuesta corta del donante', () => {
  assert.equal(classifyValentinaCall({
    transcript: [{ role: 'user', message: 'Dale.' }],
  }).status, 'converted');

  assert.equal(classifyValentinaCall({
    transcript: [{ role: 'user', message: 'Dale, contame de qué se trata.' }],
  }).status, 'completed');
});

test('una negativa tiene prioridad dentro del mismo mensaje', () => {
  const result = classifyValentinaCall({
    transcript: [{ role: 'user', message: 'No quiero donar por ahora, gracias.' }],
  });

  assert.equal(result.status, 'completed');
});

test('detecta handoff cuando se ofrece contacto del equipo', () => {
  const result = classifyValentinaCall({
    transcript: [
      { role: 'user', message: '¿Cómo administran los fondos?' },
      { role: 'agent', message: 'Alguien del equipo te va a llamar para explicarte.' },
    ],
  });

  assert.equal(result.status, 'handoff_required');
});

test('clasifica un contestador automático como voicemail', () => {
  const result = classifyValentinaCall({
    transcript: [{
      role: 'user',
      message: 'No se encuentra disponible en este momento. Dejá un mensaje después del tono.',
    }],
  });

  assert.equal(result.status, 'voicemail');
});

test('clasifica una llamada sin respuesta del donante', () => {
  const result = classifyValentinaCall({
    transcript: [{ role: 'agent', message: 'Hola, ¿me escuchás?' }],
  });

  assert.equal(result.status, 'no_response');
});
