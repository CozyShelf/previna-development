// Testes do config/mobile/metro-loopback.cjs, que evita a queda do Metro ao abrir o JS debugger no Docker:
// só as requisições do container para o próprio Metro (IP da LAN:8081) vão para 127.0.0.1.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const MODULO = path.join(__dirname, '..', 'config', 'mobile', 'metro-loopback.cjs');

// O módulo lê o ambiente e envolve o fetch global ao carregar
process.env.REACT_NATIVE_PACKAGER_HOSTNAME = '192.168.0.10';
delete process.env.RCT_METRO_PORT;
const chamadas = [];
globalThis.fetch = async (input) => {
  chamadas.push(input);
  return new Response('{}');
};
const { toLoopback } = require(MODULO);

const destino = () => {
  const ultima = chamadas.at(-1);
  return String(ultima instanceof Request ? ultima.url : ultima);
};

describe('toLoopback', () => {
  test('o próprio Metro (IP da LAN, porta 8081) vai para 127.0.0.1, mantendo caminho e query', () => {
    assert.equal(String(toLoopback('http://192.168.0.10:8081/json/list?x=1')), 'http://127.0.0.1:8081/json/list?x=1');
    assert.equal(String(toLoopback(new URL('http://192.168.0.10:8081/status'))), 'http://127.0.0.1:8081/status');
  });

  test('outro host ou outra porta passa intacto', () => {
    for (const url of ['http://192.168.0.10/backend/x', 'http://192.168.0.10:8080/backend', 'http://192.168.0.11:8081/', 'https://exp.host/']) {
      assert.equal(toLoopback(url), url, url);
    }
  });

  test('Request mantém método, cabeçalhos e corpo', async () => {
    const original = new Request('http://192.168.0.10:8081/json', {
      method: 'POST',
      headers: { 'x-teste': '1' },
      body: 'oi',
    });
    const redirecionado = toLoopback(original);
    assert.equal(redirecionado.url, 'http://127.0.0.1:8081/json');
    assert.equal(redirecionado.method, 'POST');
    assert.equal(redirecionado.headers.get('x-teste'), '1');
    assert.equal(await redirecionado.text(), 'oi');
  });

  test('URL inválida segue como veio, sem lançar erro', () => {
    assert.equal(toLoopback('não é url'), 'não é url');
    assert.equal(toLoopback(undefined), undefined);
  });
});

describe('fetch global', () => {
  test('o fetch que já existia é envolvido', async () => {
    await fetch('http://192.168.0.10:8081/json/list');
    assert.equal(destino(), 'http://127.0.0.1:8081/json/list');
  });

  test('um fetch instalado depois (como o do expo-router) também é envolvido', async () => {
    const depois = [];
    globalThis.fetch = async (input) => {
      depois.push(String(input));
      return new Response('{}');
    };
    await fetch('http://192.168.0.10:8081/status');
    await fetch('http://192.168.0.10:8080/backend/');
    assert.deepEqual(depois, ['http://127.0.0.1:8081/status', 'http://192.168.0.10:8080/backend/']);
  });
});

describe('quando não mexe em nada', () => {
  // Processo separado: o ambiente é lido quando o módulo carrega
  const fetchFicaOriginal = (env) => {
    const script = `
      const original = globalThis.fetch;
      require(${JSON.stringify(MODULO)});
      process.stdout.write(String(globalThis.fetch === original));
    `;
    const resultado = spawnSync(process.execPath, ['-e', script], {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
    });
    assert.equal(resultado.status, 0, resultado.stderr);
    return resultado.stdout === 'true';
  };

  test('sem MOBILE_HOST (REACT_NATIVE_PACKAGER_HOSTNAME) ou com localhost, o fetch fica como está', () => {
    assert.equal(fetchFicaOriginal({}), true);
    assert.equal(fetchFicaOriginal({ REACT_NATIVE_PACKAGER_HOSTNAME: 'localhost' }), true);
    assert.equal(fetchFicaOriginal({ REACT_NATIVE_PACKAGER_HOSTNAME: '192.168.0.10' }), false);
  });
});
