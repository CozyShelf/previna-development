// Carregado via NODE_OPTIONS=--require no container do Metro.
//
// O Expo CLI consulta o próprio servidor em http://$REACT_NATIVE_PACKAGER_HOSTNAME:8081 (ex.: /json/list
// ao abrir o JS debugger). Dentro do Docker esse IP da LAN dá a volta pelo NAT, a conexão não chega como
// loopback, o middleware de debug do Expo a ignora e o expo-router responde um 404 em HTML. O Expo faz
// JSON.parse sem tratar o erro e o processo cai ("Unexpected token '<', "<!DOCTYPE "... is not valid JSON").
//
// Aqui as requisições que o próprio container faz para o host/porta do Metro são redirecionadas para
// 127.0.0.1, onde chegam como loopback. Requisições para qualquer outro endereço não são tocadas.
//
// O bundle de renderização do expo-router roda no mesmo processo e instala o próprio globalThis.fetch,
// por isso o fetch é exposto via getter/setter: qualquer implementação instalada depois também é envolvida.
'use strict';

const packagerHost = process.env.REACT_NATIVE_PACKAGER_HOSTNAME;
const metroPort = process.env.RCT_METRO_PORT || '8081';

function toLoopback(input) {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    const url = raw && new URL(raw);
    if (url && url.hostname === packagerHost && (url.port || '80') === metroPort) {
      url.hostname = '127.0.0.1';
      return typeof Request === 'function' && input instanceof Request ? new Request(url, input) : url;
    }
  } catch {
    // URL inválida: segue com a requisição original
  }
  return input;
}

function wrap(impl) {
  if (typeof impl !== 'function') return impl;
  return function fetchViaLoopback(input, init) {
    if (process.env.PREVINA_LOOPBACK_DEBUG) console.error('[loopback]', String(input?.url ?? input));
    return impl.call(this, toLoopback(input), init);
  };
}

if (packagerHost && packagerHost !== 'localhost' && typeof globalThis.fetch === 'function') {
  let wrapped = wrap(globalThis.fetch);
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    enumerable: true,
    get: () => wrapped,
    set: (impl) => {
      wrapped = wrap(impl);
    },
  });
}

// Para os testes (tests/metro-loopback.test.js); o --require ignora o que o módulo exporta
module.exports = { toLoopback, wrap };
