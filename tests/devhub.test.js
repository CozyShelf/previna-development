// Testes da central de desenvolvimento (config/devhub/server.js). Ela controla o Docker da máquina pelo socket,
// então o principal é provar que só o navegador da própria máquina consegue usá-la.
//
// Um Docker falso escuta num socket unix temporário: nada aqui toca o Docker de verdade.
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SOCKET = path.join(os.tmpdir(), `devhub-docker-falso-${process.pid}.sock`);
process.env.DOCKER_SOCKET = SOCKET;
process.env.MOBILE_HOST = '192.168.0.10';
process.env.NGINX_PORT = '8080';

const {
  server,
  isAllowed,
  logRange,
  resolvePublicFile,
  toService,
  createDemuxer,
  createLineSplitter,
} = require('../config/devhub/server.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'config', 'devhub', 'public');

// ---- Funções puras ----------------------------------------------------------

describe('isAllowed: só o navegador da própria máquina', () => {
  const req = (method, host, origin) => ({ method, headers: { host, ...(origin && { origin }) } });

  test('leitura (GET) vinda de localhost, 127.0.0.1 ou [::1] passa', () => {
    for (const host of ['localhost:9000', '127.0.0.1:9000', '[::1]:9000', 'localhost']) {
      assert.equal(isAllowed(req('GET', host)), true, host);
    }
  });

  test('Host de outro domínio é barrado (DNS rebinding)', () => {
    for (const host of ['evil.com', 'evil.com:9000', 'localhost.evil.com:9000', '192.168.0.10:9000', '']) {
      assert.equal(isAllowed(req('GET', host)), false, host);
    }
  });

  test('ação (POST) só com Origin igual ao Host (CSRF)', () => {
    assert.equal(isAllowed(req('POST', 'localhost:9000', 'http://localhost:9000')), true);
    assert.equal(isAllowed(req('POST', 'localhost:9000')), false, 'sem Origin');
    assert.equal(isAllowed(req('POST', 'localhost:9000', 'http://evil.com')), false, 'outro site');
    assert.equal(isAllowed(req('POST', 'localhost:9000', 'http://localhost:9001')), false, 'outra porta');
    assert.equal(isAllowed(req('POST', 'localhost:9000', 'https://localhost:9000')), false, 'outro esquema');
  });
});

describe('logRange: quantas linhas de log pedir ao Docker', () => {
  const range = (query) => logRange(new URLSearchParams(query));

  test('padrão de 300 linhas', () => assert.equal(range(''), 'tail=300'));
  test('tail pedido, limitado a 5000', () => {
    assert.equal(range('tail=50'), 'tail=50');
    assert.equal(range('tail=99999'), 'tail=5000');
    assert.equal(range('tail=2.7'), 'tail=2');
  });
  test('tail inválido, zero ou negativo vira o padrão (negativo traria o log inteiro)', () => {
    for (const tail of ['-5', '0', 'abc', '0.4']) assert.equal(range(`tail=${tail}`), 'tail=300', tail);
  });
  test('since (reconexão) traz tudo desde o instante, em segundos inteiros', () => {
    assert.equal(range('since=1700000000.9&tail=10'), 'since=1700000000&tail=all');
    assert.equal(range('since=-1'), 'tail=300');
  });
});

describe('resolvePublicFile: só arquivos de public/', () => {
  test('raiz serve o index.html e arquivos de public/ resolvem', () => {
    assert.equal(resolvePublicFile('/'), path.join(PUBLIC_DIR, 'index.html'));
    assert.equal(resolvePublicFile('/app.js'), path.join(PUBLIC_DIR, 'app.js'));
    assert.equal(resolvePublicFile('/vendor/x.js'), path.join(PUBLIC_DIR, 'vendor', 'x.js'));
  });

  test('caminho que sai de public/ é recusado', () => {
    for (const pathname of ['/../server.js', '/../services.json', '/../../etc/passwd', '/vendor/../../server.js']) {
      assert.equal(resolvePublicFile(pathname), null, pathname);
    }
  });

  test('pasta irmã com o mesmo prefixo (public-x/) é recusada', () => {
    assert.equal(resolvePublicFile('/../public-x/segredo.txt'), null);
  });
});

describe('toService: dados do container para a página', () => {
  const container = {
    State: 'running',
    Status: 'Up 2 minutes (healthy)',
    Image: 'postgres:18-alpine',
    Names: ['/previna-development-db-1'],
    Created: 1700000000,
    Ports: [
      { IP: '0.0.0.0', PrivatePort: 5432, PublicPort: 5432, Type: 'tcp' },
      { IP: '::', PrivatePort: 5432, PublicPort: 5432, Type: 'tcp' },
      { PrivatePort: 9999, Type: 'tcp' },
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 80, Type: 'tcp' },
    ],
  };

  test('portas publicadas sem duplicar IPv4/IPv6, ordenadas, sem as internas', () => {
    assert.deepEqual(
      toService('db', {}, container).ports.map((p) => p.host),
      [80, 5432],
    );
  });

  test('estado, saúde e nome do container', () => {
    const service = toService('db', { title: 'PostgreSQL' }, container);
    assert.equal(service.title, 'PostgreSQL');
    assert.equal(service.state, 'running');
    assert.equal(service.health, 'healthy');
    assert.equal(service.container, 'previna-development-db-1');
  });

  test('serviço sem container aparece como não criado', () => {
    const service = toService('novo', undefined, undefined);
    assert.equal(service.title, 'novo');
    assert.equal(service.created, false);
    assert.equal(service.state, 'missing');
    assert.deepEqual(service.ports, []);
  });
});

describe('logs do Docker', () => {
  // Frame do Docker sem TTY: [stream, 0, 0, 0, tamanho (uint32 BE)] + conteúdo
  const frame = (stream, text) => {
    const body = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };

  test('separa stdout e stderr, mesmo com o frame partido entre pedaços', () => {
    const recebidos = [];
    const demux = createDemuxer((stream, text) => recebidos.push([stream, text]));
    const dados = Buffer.concat([frame(1, 'olá\n'), frame(2, 'erro\n')]);

    demux(dados.subarray(0, 5));
    assert.deepEqual(recebidos, [], 'cabeçalho incompleto espera o resto');
    demux(dados.subarray(5, 14));
    demux(dados.subarray(14));

    assert.deepEqual(recebidos, [['stdout', 'olá\n'], ['stderr', 'erro\n']]);
  });

  test('junta linhas partidas, separado por stream', () => {
    const linhas = [];
    const split = createLineSplitter((stream, line) => linhas.push([stream, line]));
    split('stdout', 'primeira li');
    split('stderr', 'erro inteiro\n');
    split('stdout', 'nha\nsegunda\nterc');

    assert.deepEqual(linhas, [
      ['stderr', 'erro inteiro'],
      ['stdout', 'primeira linha'],
      ['stdout', 'segunda'],
    ]);
  });
});

// ---- Servidor HTTP contra um Docker falso ------------------------------------

describe('API da central', () => {
  const CONTAINERS = [
    { Id: 'id-backend', Labels: { 'com.docker.compose.service': 'backend' }, Names: ['/b'], State: 'running', Status: 'Up', Ports: [] },
    { Id: 'id-devhub', Labels: { 'com.docker.compose.service': 'devhub' }, Names: ['/d'], State: 'running', Status: 'Up', Ports: [] },
    { Id: 'id-extra', Labels: { 'com.docker.compose.service': 'extra' }, Names: ['/e'], State: 'exited', Status: 'Exited', Ports: [] },
  ];
  const chamadas = [];
  let docker;
  let base;

  before(async () => {
    fs.rmSync(SOCKET, { force: true });
    docker = http.createServer((req, res) => {
      chamadas.push(`${req.method} ${req.url}`);
      const json = (body) => res.end(JSON.stringify(body));
      if (req.url === `/containers/${os.hostname()}/json`) {
        // O próprio devhub: diz de qual projeto compose ele é
        return json({
          Config: { Labels: { 'com.docker.compose.project': 'previna-development', 'com.docker.compose.service': 'devhub' } },
        });
      }
      if (req.url.startsWith('/containers/json?')) return json(CONTAINERS);
      if (req.url === '/containers/id-backend/json') return json({ Config: { Tty: false } });
      if (req.url.startsWith('/containers/id-backend/logs?')) {
        const body = Buffer.from('2026-11-05T10:00:00.000000000Z Started PrevinaApplication\n');
        const header = Buffer.alloc(8);
        header[0] = 1;
        header.writeUInt32BE(body.length, 4);
        return res.end(Buffer.concat([header, body]));
      }
      if (req.method === 'POST' && req.url === '/containers/id-backend/restart') {
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 404;
      json({ message: 'no such container' });
    });
    await new Promise((resolve) => docker.listen(SOCKET, resolve));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => docker.close(resolve));
    fs.rmSync(SOCKET, { force: true });
  });

  // http.request, e não fetch: o fetch não deixa trocar o Host nem mandar caminhos com ".."
  function pedir(method, caminho, headers = {}) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method, path: caminho, headers: { host: `localhost:${port}`, ...headers } },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
  const origem = () => ({ origin: `http://localhost:${server.address().port}` });

  test('lista os serviços na ordem do services.json, sem o próprio devhub e com os novos no fim', async () => {
    const res = await pedir('GET', '/api/services');
    assert.equal(res.status, 200);
    const dados = JSON.parse(res.body);
    const nomes = dados.services.map((s) => s.name);
    assert.equal(dados.project, 'previna-development');
    assert.equal(nomes[0], 'frontend');
    assert.equal(nomes.at(-1), 'extra');
    assert.ok(!nomes.includes('devhub'));
    assert.equal(dados.services.find((s) => s.name === 'frontend').created, false);
  });

  test('variáveis dos links: IP do celular e porta do nginx fora da 80', async () => {
    const { vars } = JSON.parse((await pedir('GET', '/api/services')).body);
    assert.deepEqual(vars, { mobileHost: '192.168.0.10', webPort: ':8080' });
  });

  test('reinicia um serviço com Origin da própria central', async () => {
    chamadas.length = 0;
    const res = await pedir('POST', '/api/services/backend/restart', origem());
    assert.equal(res.status, 200);
    assert.ok(chamadas.includes('POST /containers/id-backend/restart'));
  });

  test('ação vinda de outro site é barrada sem chegar ao Docker', async () => {
    chamadas.length = 0;
    const res = await pedir('POST', '/api/services/backend/restart', { origin: 'http://evil.com' });
    assert.equal(res.status, 403);
    assert.deepEqual(chamadas, []);
  });

  test('Host de outro domínio é barrado até na leitura (DNS rebinding)', async () => {
    chamadas.length = 0;
    const res = await pedir('GET', '/api/services', { host: 'evil.com' });
    assert.equal(res.status, 403);
    assert.deepEqual(chamadas, []);
  });

  test('ação fora da lista (start, stop, restart) não chega ao Docker', async () => {
    chamadas.length = 0;
    const res = await pedir('POST', '/api/services/backend/kill', origem());
    assert.equal(res.status, 404);
    assert.ok(!chamadas.some((c) => c.startsWith('POST')));
  });

  test('a central não para nem reinicia a si mesma', async () => {
    chamadas.length = 0;
    const res = await pedir('POST', '/api/services/devhub/stop', origem());
    assert.equal(res.status, 404);
    assert.ok(!chamadas.some((c) => c.startsWith('POST')));
  });

  test('serviço inexistente responde 404', async () => {
    const res = await pedir('POST', '/api/services/naoexiste/restart', origem());
    assert.equal(res.status, 404);
  });

  test('transmite os logs como eventos (SSE) e avisa quando o stream termina', async () => {
    const res = await pedir('GET', '/api/services/backend/logs?tail=-5');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.body, /event: line\ndata: {"s":"stdout","t":"2026-11-05T10:00:00.000000000Z","l":"Started PrevinaApplication"}/);
    assert.match(res.body, /event: end/);
    assert.ok(chamadas.some((c) => c.includes('/containers/id-backend/logs?') && c.endsWith('tail=300')));
  });

  test('página servida com CSP que só aceita os scripts da própria central', async () => {
    const res = await pedir('GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  });

  test('não serve arquivos fora de public/ (server.js, services.json)', async () => {
    for (const caminho of ['/..%2fserver.js', '/%2e%2e/server.js', '/../services.json', '/vendor/../../server.js']) {
      const res = await pedir('GET', caminho);
      assert.equal(res.status, 404, caminho);
      assert.doesNotMatch(res.body, /require\(|"frontend"/, caminho);
    }
  });
});
