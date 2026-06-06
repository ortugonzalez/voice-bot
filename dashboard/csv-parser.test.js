import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSVText } from './csv-parser.js';

test('parsea CSV separado por comas y conserva comas entre comillas', () => {
  const rows = parseCSVText(
    'phone,donor_name,last_amount,ong_name\n+54911,"Pérez, Ana",1500,"ONG Uno"',
  );

  assert.deepEqual(rows, [{
    phone: '+54911',
    donor_name: 'Pérez, Ana',
    last_amount: '1500',
    ong_name: 'ONG Uno',
  }]);
});

test('parsea CSV de Excel argentino separado por punto y coma', () => {
  const rows = parseCSVText(
    'phone;donor_name;last_amount;ong_name\r\n+54922;José;900;ONG Dos',
  );

  assert.equal(rows[0].donor_name, 'José');
  assert.equal(rows[0].ong_name, 'ONG Dos');
});

test('acepta comillas escapadas y saltos de línea dentro de una celda', () => {
  const rows = parseCSVText(
    'phone,donor_name,last_amount,ong_name\n+54911,"Ana ""Ani""\nPérez",1000,ONG',
  );

  assert.equal(rows[0].donor_name, 'Ana "Ani"\nPérez');
});

test('informa las columnas obligatorias faltantes', () => {
  assert.throws(
    () => parseCSVText('phone,name\n+54911,Ana'),
    /donor_name, last_amount, ong_name/,
  );
});
