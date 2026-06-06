// Clasificacion del resultado de una llamada de Valentina.

const CONVERSION_PHRASES = [
  'si quiero donar',
  'quiero donar',
  'quiero volver a donar',
  'como hago para donar',
  'como puedo donar',
  'me quiero anotar',
  'me anoto',
  'me sumo',
  'quiero colaborar',
  'si me interesa',
  'por supuesto',
  'claro que si',
  'cuanto seria',
  'como pago',
  'donde transfiero',
  'pasame el link',
  'mandame el link',
];

const NEGATIVE_PHRASES = [
  'no quiero donar',
  'no me interesa',
  'no puedo donar',
  'ahora no',
  'por ahora no',
  'no gracias',
];

const HANDOFF_PHRASES = [
  'handoff',
  'te llaman',
  'alguien del equipo',
  'te contactamos',
  'te paso con',
  'hablo con alguien',
  'no soy la indicada',
  'un humano',
  'una persona',
  'del equipo te va a llamar',
  'te van a contactar',
];

export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function indicatesConversion(message) {
  const text = normalizeText(message);
  if (!text || NEGATIVE_PHRASES.some(phrase => text.includes(phrase))) return false;
  if (CONVERSION_PHRASES.some(phrase => text.includes(phrase))) return true;

  // "Dale" solo cuenta cuando es una respuesta afirmativa corta del donante.
  return /^(si[, ]+)?dale[.! ]*$/.test(text);
}

export function classifyValentinaCall({ transcript = [], summary = '' } = {}) {
  const turns = Array.isArray(transcript) ? transcript : [];
  const donorMessages = turns
    .filter(turn => ['user', 'donor', 'customer'].includes(normalizeText(turn?.role)))
    .map(turn => turn?.message ?? '')
    .filter(Boolean);

  const conversionSources = donorMessages.length > 0 ? donorMessages : [summary];
  const isConverted = conversionSources.some(indicatesConversion);

  const fullText = normalizeText([
    ...turns.map(turn => turn?.message ?? ''),
    summary,
  ].join(' '));
  const requiresHandoff = !isConverted &&
    HANDOFF_PHRASES.some(phrase => fullText.includes(normalizeText(phrase)));

  return {
    status: isConverted ? 'converted' : (requiresHandoff ? 'handoff_required' : 'completed'),
    isConverted,
    requiresHandoff,
  };
}
