# Previna Development

Repositório de infraestrutura do **Previna**.  
Contém a orquestração com Docker Compose + Nginx. O código da aplicação fica em repositórios separados.

### Estrutura esperada

```bash
code/
├── previna-backend/        # API Spring Boot (Java 21 + Maven)
├── previna-frontend/       # SPA Vite (Node 22)
├── previna-frontend-mobile/ # App Expo / React Native (Node 22)
└── previna-development/    # este repositório
```

---

## Arquitetura

O **Nginx** é o único serviço exposto para o mundo externo.  
Frontend e Backend ficam na rede interna `previna-network` e se comunicam pela mesma origem (sem CORS).

```
Cliente
  │
  ▼
Nginx (porta 80/443)
  ├── /          → frontend
  └── /backend/  → backend:8080
```

| Rota        | Destino              | Observação                                                                 |
|-------------|----------------------|----------------------------------------------------------------------------|
| `/`         | `frontend`           | Em **dev**: Vite na porta `5173`<br>Em **prod**: Nginx servindo o `dist/` |
| `/backend/` | `backend:8080`       | O prefixo `/backend` é removido. Ex: `/backend/api/x` chega como `/api/x` |

> O frontend deve chamar a API usando:  
> `VITE_API_URL=/backend`

---

## Estrutura do repositório

```bash
previna-development/
├── docker-compose.yml              # Base (serviços + rede + nginx)
├── docker-compose.override.yml     # Desenvolvimento (hot reload)
├── docker-compose.prod.yml         # Produção (imagens + HTTPS)
└── config/
    ├── nginx/
    │   ├── nginx.conf              # Reverse proxy (dev)
    │   └── nginx.prod.conf         # Reverse proxy (prod)
    ├── backend/
    │   ├── Dockerfile.dev          # mvn spring-boot:run
    │   └── Dockerfile              # Multi-stage → JRE 21 alpine
    ├── frontend/
    │   ├── Dockerfile.dev          # npm run dev
    │   ├── Dockerfile              # Multi-stage → nginx + dist/
    │   └── nginx.conf              # Config interna do container de frontend (SPA)
    ├── mobile/
    │   └── Dockerfile.dev          # npx expo start (Metro)
    └── devhub/                     # Central de desenvolvimento (só dev)
        ├── server.js               # Node sem dependências, fala com a API do Docker
        ├── services.json           # Título, descrição e links de cada serviço
        └── public/                 # Página (HTML/CSS/JS puro)
```

---

## Desenvolvimento

### Subir o ambiente

```bash
docker compose up
```

O arquivo `docker-compose.override.yml` é carregado automaticamente e configura:

- Build dos serviços usando os `Dockerfile.dev`
- Volumes com o código-fonte (hot reload)
- Cache do Maven (`~/.m2`)
- Profile Spring `dev`
- Nginx com suporte a WebSocket (necessário para o HMR do Vite)
- App mobile (Metro) (ver [App mobile](#app-mobile-expo))

### Acessos

- **Central de desenvolvimento → [http://localhost:9000](http://localhost:9000)**
- Frontend → [http://localhost](http://localhost)
- Backend  → [http://localhost/backend/](http://localhost/backend/)
- E-mails (MailHog) → [http://localhost:8025](http://localhost:8025): e-mails enviados pelo backend, como o pré-login das empresas parceiras

### Central de desenvolvimento

O serviço `devhub` sobe junto com o ambiente e mostra, em [http://localhost:9000](http://localhost:9000):

- Status de cada container (rodando, parado, healthcheck) e as portas publicadas
- Links de acesso (app, API, Swagger, Metro) e dados para copiar (conexão do Postgres, URL do Expo)
- Botões para reiniciar, parar e iniciar cada serviço
- Logs ao vivo com filtro, cores ANSI e reconexão automática quando o container reinicia

Link direto para os logs de um serviço: `http://localhost:9000/?logs=backend`.

Para adicionar ou ajustar links, edite `config/devhub/services.json` (`{host}` vira o host usado no navegador).
Serviços novos do compose aparecem automaticamente, mesmo sem entrada no arquivo.

> O devhub monta o socket do Docker (`/var/run/docker.sock`), o que dá controle total sobre o Docker da máquina.
> Por isso a porta é publicada só em `127.0.0.1` e o serviço existe apenas no `docker-compose.override.yml` (nunca em produção).

### App mobile (Expo)

O `npm run start:dev` (ou `docker compose up -d`) já sobe o Metro (`mobile`).
O app roda no celular físico, pelo Expo Go, na mesma rede Wi-Fi da máquina.

```bash
npm run start:dev         # tudo, incluindo o Metro
npm run logs:dev:mobile   # logs do Metro (QR code aparece aqui e na central)
```

1. Copie `.env.example` para `.env` e defina o IP da máquina na LAN:
   ```bash
   MOBILE_HOST=192.168.0.10
   MOBILE_API_URL=http://192.168.0.10/backend
   ```
2. `npm run start:dev` e abra `exp://192.168.0.10:8081` no Expo Go (ou escaneie o QR code).

> O Expo Go precisa suportar o SDK do projeto (ver `expo` no `package.json` do mobile).
> Se o Expo Go da loja estiver em um SDK diferente, use um development build (`eas build --profile development`).

Atalhos do Expo (ex: `r` para reload): `docker attach previna-development-mobile-1` (sair com `Ctrl+P Ctrl+Q`).

> Ao mudar dependências do mobile, rebuild a imagem e renove o volume de `node_modules`:
> `docker compose --profile mobile up -d --build --renew-anon-volumes mobile`

---

## Produção

```bash
npm start   # = docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

> Ao passar o `-f`, o `docker-compose.override.yml` **não** é carregado.

O que o `docker-compose.prod.yml` faz:

- Usa imagens prontas do registry (sem volumes de código)
- Ativa o profile Spring `prod`
- Define `restart: unless-stopped`
- Usa o `nginx.prod.conf` (HTTPS, HTTP/2, gzip e headers de segurança)
- Não inclui o app mobile: o app é distribuído pelas lojas (EAS Build) e só consome a API em `https://<domínio>/backend`

### Pré-requisitos de produção

1. **Domínio**  
   Substitua `seu-dominio.com.br` em `config/nginx/nginx.prod.conf`.

2. **Imagens**  
   Substitua `REGISTRY/...:TAG` em `docker-compose.prod.yml`.

3. **Certificado TLS**  
   Emita o certificado com o Certbot **no host** antes de subir o Nginx.  
   Os arquivos precisam estar em `/etc/letsencrypt`.  
   O desafio ACME é servido a partir de `/var/www/certbot`.

4. **E-mail (SMTP)**  
   O pré-cadastro de empresa parceira envia o login e a senha temporários por e-mail.  
   Defina no `.env`: `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM` e `PORTAL_URL` (endereço do portal que vai no e-mail).  
   No profile `prod` o envio exige autenticação e STARTTLS.

5. **Spring Boot atrás de proxy**  
   No profile `prod`, configure:
   ```yaml
   server.forward-headers-strategy=framework
   ```
   Isso faz o backend respeitar os headers `X-Forwarded-*` (HTTPS e IP real do cliente).

---

## Build das imagens

Os Dockerfiles ficam neste repositório, mas o **contexto de build** é o repositório da aplicação.

### Backend

Execute a partir da pasta `previna-backend/`:

```bash
docker build \
  -f ../previna-development/config/backend/Dockerfile \
  -t REGISTRY/previna-backend:TAG .
```

### Frontend

Execute a partir da pasta `previna-frontend/`:

```bash
docker build \
  --build-context config=../previna-development/config/frontend \
  -f ../previna-development/config/frontend/Dockerfile \
  -t REGISTRY/previna-frontend:TAG .
```

> `VITE_API_URL` é resolvida em tempo de **build** pelo Vite.  
> Como a API é servida na mesma origem (`/backend`), o mesmo valor serve para todos os ambientes.