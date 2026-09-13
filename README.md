# Previna Development

Repositório de infraestrutura do **Previna**.  
Contém a orquestração com Docker Compose + Nginx. O código da aplicação fica em repositórios separados.

### Estrutura esperada

```bash
code/
├── previna-backend/        # API Spring Boot (Java 21 + Maven)
├── previna-frontend/       # SPA Vite (Node 20)
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
    └── frontend/
        ├── Dockerfile.dev          # npm run dev
        ├── Dockerfile              # Multi-stage → nginx + dist/
        └── nginx.conf              # Config interna do container de frontend (SPA)
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

### Acessos

- Frontend → [http://localhost](http://localhost)
- Backend  → [http://localhost/backend/](http://localhost/backend/)

---

## Produção

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

> Ao passar o `-f`, o `docker-compose.override.yml` **não** é carregado.

O que o `docker-compose.prod.yml` faz:

- Usa imagens prontas do registry (sem volumes de código)
- Ativa o profile Spring `prod`
- Define `restart: unless-stopped`
- Usa o `nginx.prod.conf` (HTTPS, HTTP/2, gzip e headers de segurança)

### Pré-requisitos de produção

1. **Domínio**  
   Substitua `seu-dominio.com.br` em `config/nginx/nginx.prod.conf`.

2. **Imagens**  
   Substitua `REGISTRY/...:TAG` em `docker-compose.prod.yml`.

3. **Certificado TLS**  
   Emita o certificado com o Certbot **no host** antes de subir o Nginx.  
   Os arquivos precisam estar em `/etc/letsencrypt`.  
   O desafio ACME é servido a partir de `/var/www/certbot`.

4. **Spring Boot atrás de proxy**  
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