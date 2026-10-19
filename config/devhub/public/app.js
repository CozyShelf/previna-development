'use strict';

const REFRESH_MS = 3000;
const RECONNECT_MS = 3000;
const MAX_LINES = 3000;

const STATE_LABELS = {
  running: 'rodando',
  restarting: 'reiniciando',
  exited: 'parado',
  created: 'criado',
  paused: 'pausado',
  dead: 'morto',
  removing: 'removendo',
  missing: 'não criado',
};
const HEALTH_LABELS = { healthy: 'saudável', unhealthy: 'com falha', 'health: starting': 'iniciando' };

const $ = (id) => document.getElementById(id);
const els = {
  project: $('project'),
  summary: $('summary'),
  updated: $('updated'),
  error: $('error'),
  services: $('services'),
  template: $('card-template'),
  tabs: $('log-tabs'),
  status: $('log-status'),
  output: $('log-output'),
  filter: $('log-filter'),
  follow: $('log-follow'),
  wrap: $('log-wrap'),
  clear: $('log-clear'),
  toast: $('toast'),
  qrDialog: $('qr-dialog'),
  qrCode: $('qr-code'),
  qrUrl: $('qr-url'),
  qrCopy: $('qr-copy'),
  qrWarning: $('qr-warning'),
};

const cards = new Map();
let services = [];
let vars = {};

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // sem storage (aba privada etc.): so nao lembra a preferencia
    }
  },
};

const fill = (template) =>
  template.replaceAll('{host}', location.hostname).replaceAll('{mobileHost}', vars.mobileHost ?? location.hostname);

function tone(service) {
  if (service.state === 'running') {
    if (service.health === 'unhealthy') return 'bad';
    if (service.health === 'health: starting') return 'warn';
    return 'ok';
  }
  if (service.state === 'restarting' || service.state === 'paused') return 'warn';
  if (service.state === 'dead' || /Exited \((?!0\))/.test(service.status)) return 'bad';
  return 'idle';
}

function stateLabel(service) {
  const label = STATE_LABELS[service.state] ?? service.state;
  return service.health ? `${label} · ${HEALTH_LABELS[service.health] ?? service.health}` : label;
}

// --- Serviços ---------------------------------------------------------------

function createCard(service) {
  const card = els.template.content.firstElementChild.cloneNode(true);
  card.querySelector('h2').textContent = service.title;
  card.querySelector('.service-name').textContent = service.name;
  card.querySelector('.description').textContent = service.description;

  const links = card.querySelector('.links');
  for (const link of service.links) {
    const a = Object.assign(document.createElement('a'), {
      className: 'link',
      href: fill(link.url),
      target: '_blank',
      rel: 'noopener',
      textContent: `${link.label} ↗`,
      title: fill(link.url),
    });
    links.append(a);
  }
  for (const item of service.copy) {
    const value = fill(item.value);
    const button = Object.assign(document.createElement('button'), {
      className: 'link',
      type: 'button',
      textContent: `${item.label} ⧉`,
      title: `Copiar ${value}`,
    });
    button.addEventListener('click', () => copy(value, button));
    links.append(button);
  }
  if (service.qr) {
    const button = Object.assign(document.createElement('button'), {
      className: 'link',
      type: 'button',
      textContent: `${service.qr.label} ▦`,
    });
    button.addEventListener('click', () => openQr(service.qr));
    links.append(button);
  }

  card.querySelector('[data-action="logs"]').addEventListener('click', () => selectLogs(service.name));
  card.querySelector('[data-action="restart"]').addEventListener('click', (e) => runAction(service.name, 'restart', e.currentTarget));
  card.querySelector('[data-action="toggle"]').addEventListener('click', (e) => {
    const current = services.find((s) => s.name === service.name);
    runAction(service.name, current?.state === 'running' ? 'stop' : 'start', e.currentTarget);
  });
  return card;
}

function updateCard(card, service) {
  card.dataset.tone = tone(service);
  card.classList.toggle('selected', service.name === logs.service);
  card.querySelector('.state').textContent = stateLabel(service);
  card.querySelector('.status').textContent = service.created
    ? `${service.status} · ${service.image}`
    : `Rode "docker compose up -d ${service.name}" para criar`;

  const ports = card.querySelector('.ports');
  ports.replaceChildren(
    ...service.ports.map((p) => {
      const li = document.createElement('li');
      const ip = p.ip && p.ip !== '0.0.0.0' && p.ip !== '::' ? p.ip : location.hostname;
      li.append(`${ip}:${p.host}`, Object.assign(document.createElement('span'), { textContent: ` → ${p.container}/${p.protocol}` }));
      return li;
    }),
  );

  const running = service.state === 'running';
  const busy = card.dataset.busy === 'true';
  const toggle = card.querySelector('[data-action="toggle"]');
  if (!busy) toggle.textContent = running ? 'Parar' : 'Iniciar';
  for (const button of card.querySelectorAll('.actions .btn')) button.disabled = busy || !service.created;
}

function render() {
  const names = new Set(services.map((s) => s.name));
  for (const [name, card] of cards) {
    if (!names.has(name)) {
      card.remove();
      cards.delete(name);
    }
  }
  services.forEach((service, index) => {
    let card = cards.get(service.name);
    if (!card) {
      card = createCard(service);
      cards.set(service.name, card);
    }
    if (els.services.children[index] !== card) els.services.insertBefore(card, els.services.children[index] ?? null);
    updateCard(card, service);
  });

  const running = services.filter((s) => s.state === 'running').length;
  els.summary.textContent = `${running}/${services.length} rodando`;
  renderTabs();
}

async function refresh() {
  try {
    const res = await fetch('/api/services', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    services = body.services;
    vars = body.vars ?? {};
    els.project.textContent = `projeto compose: ${body.project}`;
    els.updated.textContent = `atualizado ${new Date().toLocaleTimeString('pt-BR')}`;
    els.error.hidden = true;
    render();
  } catch (err) {
    els.error.textContent = `Não foi possível consultar os serviços: ${err.message}`;
    els.error.hidden = false;
  }
}

async function runAction(name, action, button) {
  const card = cards.get(name);
  const label = button.textContent;
  card.dataset.busy = 'true';
  button.textContent = '…';
  for (const b of card.querySelectorAll('.actions .btn')) b.disabled = true;
  try {
    const res = await fetch(`/api/services/${name}/${action}`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
  } catch (err) {
    els.error.textContent = `Falha ao executar "${action}" em ${name}: ${err.message}`;
    els.error.hidden = false;
  } finally {
    card.dataset.busy = 'false';
    button.textContent = label;
    await refresh();
  }
}

function toast(message) {
  // Dialogo modal fica na camada de cima; o toast precisa estar dentro dele para aparecer
  (els.qrDialog.open ? els.qrDialog : document.body).append(els.toast);
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2500);
}

async function copy(value, button) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    window.prompt('Copie:', value);
    return;
  }
  toast(`Copiado: ${value}`);
  button.classList.add('copied');
  setTimeout(() => button.classList.remove('copied'), 1200);
}

// --- QR code (Expo Go) ------------------------------------------------------

// Biblioteca carregada sob demanda; sem internet, o dialogo mostra so a URL
let qrLibrary;
function loadQrLibrary() {
  qrLibrary ??= new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), {
      src: 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
      onload: () => resolve(window.QRCode),
      onerror: () => {
        qrLibrary = undefined;
        reject(new Error('sem acesso ao CDN'));
      },
    });
    document.head.append(script);
  });
  return qrLibrary;
}

async function openQr(qr) {
  const value = fill(qr.value);
  els.qrUrl.textContent = value;
  els.qrCopy.onclick = () => copy(value, els.qrCopy);
  els.qrWarning.hidden = Boolean(vars.mobileHost);
  els.qrCode.textContent = 'Gerando QR code…';
  els.qrDialog.showModal();
  try {
    const QRCode = await loadQrLibrary();
    els.qrCode.replaceChildren();
    new QRCode(els.qrCode, { text: value, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  } catch (err) {
    els.qrCode.textContent = `Não foi possível gerar o QR code (${err.message}). Use a URL abaixo.`;
  }
}

// --- Logs -------------------------------------------------------------------

const logs = { service: null, source: null, lastTs: null, waiting: false, timer: null, frame: 0 };

function renderTabs() {
  const created = services.filter((s) => s.created);
  const current = [...els.tabs.children].map((t) => t.dataset.service).join();
  if (current !== created.map((s) => s.name).join()) {
    els.tabs.replaceChildren(
      ...created.map((s) => {
        const tab = Object.assign(document.createElement('button'), { className: 'tab', type: 'button', textContent: s.name });
        tab.dataset.service = s.name;
        tab.setAttribute('role', 'tab');
        tab.addEventListener('click', () => selectLogs(s.name));
        return tab;
      }),
    );
  }
  for (const tab of els.tabs.children) tab.setAttribute('aria-selected', String(tab.dataset.service === logs.service));
}

function selectLogs(name) {
  if (logs.service === name) return;
  storage.set('devhub.logs', name);
  logs.service = name;
  logs.lastTs = null;
  logs.waiting = false;
  els.output.replaceChildren();
  els.follow.checked = true;
  connectLogs();
  render();
}

function connectLogs() {
  clearTimeout(logs.timer);
  logs.source?.close();
  const name = logs.service;
  // Na reconexao pede so o que veio depois da ultima linha (o filtro fino e pelo timestamp)
  const query = logs.lastTs ? `since=${Math.floor(Date.parse(logs.lastTs.slice(0, 23) + 'Z') / 1000)}` : 'tail=500';
  const source = new EventSource(`/api/services/${name}/logs?${query}`);
  logs.source = source;
  els.status.textContent = `Conectando aos logs de ${name}…`;

  source.addEventListener('open', () => {
    els.status.textContent = `Logs de ${name} ao vivo`;
  });
  source.addEventListener('line', (event) => {
    const line = JSON.parse(event.data);
    if (line.t && logs.lastTs && line.t <= logs.lastTs) return;
    if (logs.waiting) {
      logs.waiting = false;
      els.status.textContent = `Logs de ${name} ao vivo`;
    }
    if (line.t) logs.lastTs = line.t;
    appendLine(line);
  });
  // O Docker encerra o stream quando o container para ou reinicia
  source.addEventListener('end', () => {
    source.close();
    if (!logs.waiting) appendMarker('stream encerrado (container parou ou reiniciou), aguardando…');
    logs.waiting = true;
    els.status.textContent = `${name} não está rodando, tentando reconectar…`;
    scheduleReconnect(name);
  });
  source.addEventListener('error', () => {
    if (source.readyState === EventSource.CLOSED && logs.source === source) {
      els.status.textContent = `Sem conexão com os logs de ${name}, tentando novamente…`;
      scheduleReconnect(name);
    }
  });
}

function scheduleReconnect(name) {
  clearTimeout(logs.timer);
  logs.timer = setTimeout(() => {
    if (logs.service === name) connectLogs();
  }, RECONNECT_MS);
}

// Converte cores ANSI (SGR) em spans; outros escapes sao descartados
function ansiToNodes(text) {
  const clean = text.replace(/\x1b\[[0-9;?]*[A-La-ln-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  const nodes = [];
  let classes = [];
  const parts = clean.split(/\x1b\[([0-9;]*)m/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      for (const code of (part || '0').split(';').map(Number)) {
        if (code === 0) classes = [];
        else if (code === 1) classes.push('a-bold');
        else if (code === 2) classes.push('a-dim');
        else if (code === 22) classes = classes.filter((c) => c !== 'a-bold' && c !== 'a-dim');
        else if (code === 39) classes = classes.filter((c) => !/^a-\d/.test(c));
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
          classes = classes.filter((c) => !/^a-\d/.test(c)).concat(`a-${code}`);
        }
      }
    } else if (part) {
      nodes.push(classes.length ? Object.assign(document.createElement('span'), { className: classes.join(' '), textContent: part }) : document.createTextNode(part));
    }
  });
  return nodes;
}

function matchesFilter(el) {
  const filter = els.filter.value.trim().toLowerCase();
  return !filter || el.textContent.toLowerCase().includes(filter);
}

function pushLine(el) {
  el.classList.toggle('hidden', !matchesFilter(el));
  els.output.append(el);
  while (els.output.childElementCount > MAX_LINES) els.output.firstElementChild.remove();
  if (els.follow.checked && !logs.frame) {
    logs.frame = requestAnimationFrame(() => {
      logs.frame = 0;
      els.output.scrollTop = els.output.scrollHeight;
    });
  }
}

function appendLine({ s, t, l }) {
  // Linhas com \r (barras de progresso) mostram so o ultimo estado
  const text = l.replace(/\r+$/, '').split('\r').pop();
  const el = document.createElement('span');
  el.className = `line ${s}`;
  if (t) {
    const time = new Date(t.slice(0, 23) + 'Z');
    el.append(Object.assign(document.createElement('span'), { className: 'ts', textContent: time.toLocaleTimeString('pt-BR') }));
  }
  el.append(...ansiToNodes(text), '\n');
  pushLine(el);
}

function appendMarker(text) {
  const el = Object.assign(document.createElement('span'), { className: 'line marker', textContent: `— ${text} —\n` });
  pushLine(el);
}

els.filter.addEventListener('input', () => {
  for (const el of els.output.children) el.classList.toggle('hidden', !matchesFilter(el));
});
els.wrap.addEventListener('change', () => {
  els.output.classList.toggle('wrap', els.wrap.checked);
  storage.set('devhub.wrap', els.wrap.checked ? '1' : '0');
});
els.clear.addEventListener('click', () => els.output.replaceChildren());
els.follow.addEventListener('change', () => {
  if (els.follow.checked) els.output.scrollTop = els.output.scrollHeight;
});
// Rolar para cima pausa o "seguir"; voltar ao fim retoma
els.output.addEventListener('scroll', () => {
  const atBottom = els.output.scrollHeight - els.output.scrollTop - els.output.clientHeight < 24;
  if (els.follow.checked !== atBottom) els.follow.checked = atBottom;
});

// --- Início -----------------------------------------------------------------

els.wrap.checked = storage.get('devhub.wrap') === '1';
els.output.classList.toggle('wrap', els.wrap.checked);

refresh().then(() => {
  const saved = new URLSearchParams(location.search).get('logs') ?? storage.get('devhub.logs');
  if (saved && services.some((s) => s.name === saved && s.created)) selectLogs(saved);
});
setInterval(refresh, REFRESH_MS);
