// Parser CSV sin dependencias para archivos exportados por Excel o Google Sheets.

export function parseDelimitedRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      row.push(field.trim());
      field = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim());
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  row.push(field.trim());
  if (row.some(value => value !== '')) rows.push(row);
  return rows;
}

export function parseCSVText(text) {
  const cleanText = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = cleanText.split(/\r?\n/, 1)[0] || '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length
    ? ';'
    : ',';
  const rows = parseDelimitedRows(cleanText, delimiter);
  if (rows.length < 2) return [];

  const headers = rows[0].map(header => header.trim().toLowerCase());
  const required = ['phone', 'donor_name', 'last_amount', 'ong_name'];
  const missing = required.filter(header => !headers.includes(header));
  if (missing.length > 0) {
    throw new Error(`Faltan columnas: ${missing.join(', ')}`);
  }

  return rows.slice(1).map(values => {
    const donor = {};
    headers.forEach((header, index) => donor[header] = values[index] || '');
    return donor;
  }).filter(donor => donor.phone);
}

if (typeof window !== 'undefined') {
  window.parseCSVText = parseCSVText;
}
