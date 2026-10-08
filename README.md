# 🚀 DeployHub

<p align="center">
  <strong>Production-Grade Self-Hosted Developer Deployment & Release Platform</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.0-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white" alt="Redis" />
  <img src="https://img.shields.io/badge/MongoDB-7-47A248?logo=mongodb&logoColor=white" alt="MongoDB" />
  <img src="https://img.shields.io/badge/Prometheus-Instrumented-E6522C?logo=prometheus&logoColor=white" alt="Prometheus" />
  <img src="https://img.shields.io/badge/Grafana-Provisioned-F46800?logo=grafana&logoColor=white" alt="Grafana" />
</p>

DeployHub transforms arbitrary Git repositories into isolated, running Docker containers with zero-downtime deployments, atomic traffic cutover, instant one-click rollbacks, real-time log streaming over Server-Sent Events (SSE), live container telemetry, automated crash recovery, and full Prometheus/Grafana observability.

---

## 📑 Table of Contents

- [Key Features](#-key-features)
- [Architecture & Design](#-architecture--design)
- [Deployment Pipeline Lifecycle](#-deployment-pipeline-lifecycle)
- [Monorepo Structure](#-monorepo-structure)
- [Quick Start Guide](#-quick-start-guide)
  - [Prerequisites](#prerequisites)
  - [Local Development Setup](#local-development-setup)
  - [Full Docker Compose Deployment](#full-docker-compose-deployment)
- [API & Proxy Reference](#-api--proxy-reference)
  - [Authentication & User](#authentication--user)
  - [GitHub Integration](#github-integration)
  - [Projects & Settings](#projects--settings)
  - [Environment Variables & Secrets](#environment-variables--secrets)
  - [Deployments, Releases & Rollbacks](#deployments-releases--rollbacks)
  - [Live Log Streaming (SSE)](#live-log-streaming-sse)
  - [Live Container Telemetry & Metrics](#live-container-telemetry--metrics)
  - [Dynamic Reverse Proxy Gateway](#dynamic-reverse-proxy-gateway)
  - [GitHub Webhooks](#github-webhooks)
- [Observability & Monitoring](#-observability--monitoring)
- [Container Self-Healing & Fault Tolerance](#-container-self-healing--fault-tolerance)
- [Security Architecture](#-security-architecture)
- [Testing & Verification Suites](#-testing--verification-suites)
- [License](#-license)

---

## ✨ Key Features

- 🔍 **Universal Repository Detection**: Automatically classifies arbitrary repositories into Vite frontends, Node backends (Express, Fastify, NestJS, Hono), fullstack apps, Python ML/web jobs, multi-service Docker Compose, or monorepos with nested candidate selection.
- 📦 **Docker Compose Multi-Service Support**: Automatically parses `docker-compose.yml`, discovers nested Dockerfiles, isolates container names per deployment (`deployhub-<project_id>`), binds dynamic host ports, and injects runtime configuration.
- 🛡️ **Environment Preflight & Secret Masking**: Discovers required secrets via `.env.example`, blocks container launch if mandatory variables are missing, and masks credentials in build logs and Docker runs.
- ⚡ **Deterministic Package Manager Toolchains**: Enforces frozen lockfile strategies (`npm ci`, `pnpm --frozen-lockfile`, `yarn --frozen-lockfile`, `bun --frozen-lockfile`) based on lockfile presence without non-deterministic fallback chains.
- 🔄 **Zero-Downtime Releases**: Deploys the new release in an isolated sandbox, verifies HTTP readiness probes, switches proxy traffic atomically, and only then retires the old container.
- 🛡️ **Failure Non-Disruption Guarantee**: If a new deployment fails build or health checks, the currently active deployment continues serving 100% of user traffic without interruption.
- ⚡ **One-Click Instant Rollback**: Reverts to any previous healthy release in seconds by reusing the existing immutable Docker image artifact without cloning git or rebuilding.
- 🔀 **Dynamic Reverse Proxy Gateway**: In-flight traffic routing via `/p/:projectId/*` backed by a high-speed Redis route cache and Pub/Sub invalidation layer.
- 🔒 **Distributed Port Management**: Collision-free port leasing across parallel workers using atomic Redis leases and host socket binding verification.
- 📡 **Real-Time SSE Log Streaming**: Server-Sent Events delivering live build and container execution output with client disconnect cleanup.
- 📊 **Live Container Telemetry**: Real-time monitoring of CPU %, memory usage, limits, network RX/TX, and container uptime.
- 🩹 **Self-Healing & Auto-Recovery**: Background engine that detects unexpectedly stopped/crashed active containers and executes bounded auto-restarts.
- 🐙 **GitHub Integration & Webhooks**: HMAC SHA-256 webhook verification, automated push builds, branch filtering, and commit deduplication.
- 📈 **Prometheus & Grafana Observability**: Pre-configured Prometheus scraping and 10+ panel Grafana dashboard tracking platform latency, success rates, rollbacks, and hardware usage.

---

## 🏗️ Architecture & Design

```
                                  ┌───────────────────────────────┐
                                  │   React Web Dashboard (SPA)   │
                                  └───────────────┬───────────────┘
                                                  │ (HTTP / SSE)
                                                  ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ DeployHub API Gateway                                                                          │
│ ├── Express REST API (/api/v1)                                                                 │
│ ├── Dynamic Reverse Proxy Gateway (/p/:projectId/*)                                            │
│ ├── Server-Sent Events (SSE) Log Streamer                                                      │
│ ├── Prometheus Metrics Collector (/metrics)                                                    │
│ └── HMAC Webhook Processor (/api/webhooks/github)                                              │
└───────────────────────┬─────────────────────────────────┬──────────────────────────────────────┘
                        │                                 │
           (Queues & Distributed State)             (Metadata & History)
                        │                                 │
                        ▼                                 ▼
         ┌─────────────────────────────┐   ┌─────────────────────────────┐
         │     Redis 7 (In-Memory)     │   │      MongoDB 7 (DB)         │
         │ ├── BullMQ Job Queue        │   │ ├── Users & Auth            │
         │ ├── Port Lease Registry     │   │ ├── Projects & Config       │
         │ ├── Proxy Route Cache       │   │ ├── Deployments & Releases  │
         │ └── Real-time Logs Pub/Sub  │   │ └── Bounded Execution Logs  │
         └──────────────┬──────────────┘   └─────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ DeployHub Worker Engine                                                                        │
│ ├── BullMQ Job Processor (Concurrency: 2)                                                      │
│ ├── Shallow Git Cloner & Project Framework Detector                                            │
│ ├── Docker Engine Integration (Image Builder & Sandboxed Runner)                              │
│ ├── Liveness & Readiness Health Prober                                                         │
│ ├── Periodic Stale Deployment Reconciler                                                       │
│ └── Automatic Container Recovery & Self-Healing Scanner                                        │
└───────────────────────┬────────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Docker Daemon Sandbox                                                                          │
│ ├── Active Project Container (e.g. :3406) ── [Serves Live User Traffic]                        │
│ ├── Staging Container (e.g. :4415) ──────── [Undergoing Health Checks]                         │
│ └── Retained Release Artifacts ──────────── [Ready for Instant Rollback]                       │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🔁 Deployment Pipeline Lifecycle

DeployHub adheres strictly to the safe deployment rule:

$$\text{BUILD NEW} \longrightarrow \text{START NEW} \longrightarrow \text{HEALTH CHECK} \longrightarrow \text{SWITCH TRAFFIC} \longrightarrow \text{RETIRE OLD}$$

```
                       [ Trigger: Manual / Webhook / Retry / Rollback ]
                                              │
                                              ▼
                                   ┌──────────────────────┐
                                   │    Status: QUEUED    │
                                   └──────────┬───────────┘
                                              │
                          Is Rollback Trigger?│
                          ┌───────────────────┴───────────────────┐
                          ▼ YES                                   ▼ NO
             ┌─────────────────────────┐             ┌─────────────────────────┐
             │ Reuse Existing Artifact │             │   Status: BUILDING      │
             │ (Skip Clone & Build)    │             │   - Shallow Git Clone   │
             └────────────┬────────────┘             │   - Framework Detect    │
                          │                          │   - Docker Image Build  │
                          │                          └────────────┬────────────┘
                          └───────────────────┬───────────────────┘
                                              │
                                              ▼
                                   ┌──────────────────────┐
                                   │   Status: DEPLOYING  │
                                   │   - Allocate Lease   │
                                   │   - Run Container    │
                                   └──────────┬───────────┘
                                              │
                                              ▼
                                   ┌──────────────────────┐
                                   │ Status: HEALTH_CHECK │
                                   │   - Readiness Probe  │
                                   └──────────┬───────────┘
                                              │
                                  Passed Health Check?
                                  /                  \
                            YES  /                    \  NO
                                ▼                      ▼
                   ┌─────────────────────────┐   ┌─────────────────────────┐
                   │ 🔀 Switch Proxy Target  │   │     Status: FAILED      │
                   │   (Redis Route Cache)   │   │ - Clean New Resources   │
                   ├─────────────────────────┤   │ - Keep OLD Active Live  │
                   │ Retire OLD Container    │   └─────────────────────────┘
                   │ Mark OLD as PREVIOUS    │
                   ├─────────────────────────┤
                   │ Status: ACTIVE / RUNNING│
                   └─────────────────────────┘
```

---

## 📂 Monorepo Structure

```
deployhub/
├── apps/
│   ├── api/                     # Express API, Reverse Proxy, SSE & Metrics
│   │   ├── src/
│   │   │   ├── config/          # Environment, Database & Queue configurations
│   │   │   ├── controllers/     # Auth, Projects, Deployments, Env, Webhooks
│   │   │   ├── middleware/      # JWT Authentication & Request Handlers
│   │   │   ├── routes/          # Unified REST Route Definitions
│   │   │   ├── services/        # ProxyService, ContainerMonitor, MetricsService
│   │   │   └── server.ts        # API Entrypoint
│   │   └── Dockerfile
│   │
│   ├── worker/                  # Background Worker & Deployment Engine
│   │   ├── src/
│   │   │   ├── jobs/            # deploy.job.ts, stop.job.ts
│   │   │   ├── services/        # DockerService, GitService, PortManager, RecoveryService
│   │   │   ├── utils/           # LogBuffer (bounded logging & secret masking)
│   │   │   └── worker.ts        # Worker Entrypoint & Background Schedulers
│   │   └── Dockerfile
│   │
│   └── web/                     # React + Vite + Tailwind Dashboard
│       └── src/
│           ├── components/      # UI, Layout & Terminal LogViewer
│           ├── pages/           # Dashboard, ProjectDetail, Login
│           └── services/        # Axios API Client & EventSource Handler
│
├── packages/
│   └── shared/                  # Shared TypeScript Models, Types & Schemas
│       └── src/
│           ├── models/          # Unified Mongoose Models (User, Project, Deployment)
│           └── types.ts         # Platform DTOs, Enums & Interfaces
│
├── infrastructure/              # Observability & Proxy Configs
│   ├── prometheus/              # Prometheus Scraping Configuration
│   └── grafana/                 # Pre-provisioned Dashboards & Datasources
│
├── scripts/                     # Automated Verification & Regression Suites
│   ├── test-milestone4.ts       # M4 Releases, Zero-Downtime & Rollback Suite
│   ├── test-milestone3-5.ts     # M3.5 Port Leasing, Indexing & Hardening Suite
│   ├── test-milestone3.ts       # M3 Webhooks & Timings Suite
│   ├── test-milestone2.ts       # M2 Environment Variables & Developer Workflow
│   └── test-matrix.ts           # Multi-Framework Build & Runtime Verification Matrix
│
├── docker-compose.yml           # Full Stack Orchestration Definition
└── package.json                 # Monorepo Workspace Configuration
```

---

## 🚀 Quick Start Guide

### Prerequisites

- **Node.js**: `20.x` or higher
- **Docker**: Docker Engine / Docker Desktop with Compose v2
- **Git**: Installed and accessible in system path

### Local Development Setup

1. **Clone the repository and install dependencies:**
   ```bash
   git clone https://github.com/alokpal17/deployhub.git
   cd deployhub
   cp .env.example .env
   npm install
   ```

2. **Start the database and queue services (MongoDB + Redis):**
   ```bash
   docker compose up mongodb redis prometheus grafana -d
   ```

3. **Start all services in development mode:**
   ```bash
   npm run dev
   ```

   This concurrently starts:
   - **Frontend Dashboard**: [http://localhost:5173](http://localhost:5173)
   - **API Gateway**: [http://localhost:3001](http://localhost:3001)
   - **Prometheus Metrics**: [http://localhost:3001/metrics](http://localhost:3001/metrics)
   - **Grafana Dashboard**: [http://localhost:3000](http://localhost:3000) (User: `admin` / Password: `deployhub`)
   - **Worker Process**: Background BullMQ consumer connected to Redis

4. **Build all workspaces for production verification:**
   ```bash
   npm run build
   ```

### Full Docker Compose Deployment

Run the complete platform inside Docker containers:

```bash
docker compose up -d --build
```

---

## 📡 API & Proxy Reference

All API routes (except webhooks and metrics) expect a JWT Bearer token: `Authorization: Bearer <token>`.

### Authentication & User

| Method | Route | Description |
| :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Register a new user account |
| `POST` | `/api/auth/login` | Authenticate and obtain JWT token |
| `GET` | `/api/auth/me` | Fetch authenticated user profile |

### GitHub Integration

| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/api/github/status` | Check GitHub OAuth connection status |
| `POST` | `/api/github/connect` | Connect GitHub personal access token |
| `POST` | `/api/github/disconnect` | Disconnect GitHub integration |
| `GET` | `/api/github/repos` | List accessible repositories |
| `GET` | `/api/github/repos/:owner/:repo/branches` | Fetch branches for a repository |

### Projects & Settings

| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/api/projects` | List all projects belonging to user |
| `POST` | `/api/projects` | Create a new project |
| `GET` | `/api/projects/:id` | Fetch project details |
| `PUT` | `/api/projects/:id` | Update project configuration (branch, autoDeploy, autoRecovery) |
| `POST` | `/api/projects/:id/rotate-webhook-secret` | Rotate project HMAC secret |
| `DELETE` | `/api/projects/:id` | Delete project, stop containers and wipe metrics |

### Environment Variables & Secrets

| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/api/projects/:id/env` | List environment variables (secrets masked) |
| `POST` | `/api/projects/:id/env` | Add or update an environment variable |
| `PUT` | `/api/projects/:id/env/:key` | Update an existing variable by key |
| `DELETE` | `/api/projects/:id/env/:key` | Delete an environment variable |

### Deployments, Releases & Rollbacks

| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/api/projects/:projectId/deployments` | List deployment history (without full logs) |
| `POST` | `/api/projects/:projectId/deployments` | Trigger a new release deployment |
| `GET` | `/api/projects/:projectId/active-deployment` | Fetch the currently active serving release |
| `GET` | `/api/projects/:projectId/deployments/:dId` | Get deployment details with duration timings |
| `POST` | `/api/projects/:projectId/deployments/:dId/redeploy` | Queue a fresh redeployment with current env |
| `POST` | `/api/projects/:projectId/rollback/:targetDeploymentId` | **One-Click Rollback** to a target release |
| `GET` | `/api/projects/:projectId/deployments/:dId/logs` | Fetch full historical execution logs |
| `POST` | `/api/projects/:projectId/deployments/:dId/stop` | Gracefully cancel and stop deployment |

### Live Log Streaming (SSE)

```http
GET /api/projects/:projectId/deployments/:deploymentId/logs/stream?token=<JWT_TOKEN>
Accept: text/event-stream
```

**Stream Events:**
- `event: init`: Emitted immediately with historical logs.
- `event: log`: Emitted in real-time as container/build output occurs (`{ "line": "..." }`).
- `event: end`: Emitted when deployment reaches a terminal status (`RUNNING`, `FAILED`, `STOPPED`).

### Live Container Telemetry & Metrics

| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/api/projects/:projectId/resources` | Fetch live CPU %, Memory bytes, Limits, Network RX/TX & Uptime |
| `GET` | `/metrics` | Prometheus exposition endpoint (Prometheus format) |

### Dynamic Reverse Proxy Gateway

DeployHub routes client requests dynamically to the currently active deployment:

```http
GET /p/:projectId/*
GET /proxy/:projectId/*
```

**Routing Flow:**
1. Proxy looks up the active route from Redis cache (`deployhub:proxy:route:<projectId>`).
2. Transparently pipes HTTP requests to the isolated container port.
3. Automatically sets forwarded headers (`x-forwarded-for`, `x-deployhub-project`, `x-deployhub-deployment`).
4. Returns `502 Bad Gateway` if no active container is currently available.

### GitHub Webhooks

```http
POST /api/webhooks/github
X-GitHub-Event: push
X-Hub-Signature-256: sha256=<HMAC_HEX_DIGEST>
```

---

## 📊 Observability & Monitoring

DeployHub provides native telemetry instrumentation:

### Key Prometheus Metrics

| Metric Name | Type | Description |
| :--- | :--- | :--- |
| `deployhub_deployments_total` | Counter | Total deployment executions by trigger & status |
| `deployhub_deployments_success_total` | Counter | Total successful deployments |
| `deployhub_deployments_failed_total` | Counter | Total failed deployments by categorized reason |
| `deployhub_traffic_switches_total` | Counter | Zero-downtime traffic switches by result (`success`/`failed`) |
| `deployhub_rollbacks_total` | Counter | Total rollback executions |
| `deployhub_container_restarts_total` | Counter | Auto-recovery container restarts |
| `deployhub_container_cpu_usage` | Gauge | Real-time container CPU usage percentage |
| `deployhub_container_memory_usage_bytes` | Gauge | Real-time container memory usage |
| `deployhub_container_memory_limit_bytes` | Gauge | Container memory limit |
| `deployhub_running_containers` | Gauge | Total active Docker containers |
| `deployhub_deployment_duration_seconds` | Histogram | End-to-end deployment duration in seconds |
| `deployhub_build_duration_seconds` | Histogram | Docker image build duration |

### Grafana Dashboard

Grafana is pre-provisioned via [infrastructure/grafana](file:///c:/Users/palal/Downloads/deployhub-starter/infrastructure/grafana). Access the dashboard at `http://localhost:3000` with the following configured panels:
1. **Total Deployments**
2. **Successful Releases**
3. **Deployment Success Rate**
4. **Active Deployments In-Progress**
5. **Running Containers**
6. **One-Click Rollbacks Total**
7. **Traffic Switches (Zero-Downtime)**
8. **Automatic Container Restarts**
9. **Traffic Switch Failures**
10. **Container CPU Usage (%)**
11. **Container Memory Usage (Bytes)**
12. **Deployment Latency & Build Time**
13. **Deployment Failures by Categorized Reason**

---

## 🩹 Container Self-Healing & Fault Tolerance

The [RecoveryService](file:///c:/Users/palal/Downloads/deployhub-starter/apps/worker/src/services/recovery.service.ts) runs every 30 seconds to safeguard live services:

1. Scans all projects with status `ACTIVE` / `RUNNING`.
2. Inspects Docker container status (`docker inspect`).
3. If an active container exited unexpectedly:
   - Verifies if `autoRecovery` is enabled on the project.
   - Checks that `restartCount < maxRestartAttempts` (default: 3).
   - Issues `docker restart` and verifies HTTP liveness.
   - Updates `restartCount` and `lastRestartAt`.
4. If the restart threshold is breached, the deployment is marked `UNHEALTHY` to prevent restart loops.

---

## 🔐 Security Architecture

- **Multi-Tenant Isolation**: Strict ownership checks at the API controller layer prevent tenants from accessing or rolling back unauthorized projects.
- **HMAC Signature Verification**: GitHub webhooks are verified using timing-safe raw buffer comparisons against project-specific secrets.
- **Automated Secret Scanning Guardrail**: Built-in repository scanner (`npm run scan:secrets`) prevents credential-shaped connection strings, cloud URIs, and private keys from entering version control.
- **Secret Redaction & Log Sanitization**: Environment variables marked as secrets and credential connection strings are automatically masked (`[HIDDEN_SECRET]`, `[HIDDEN_TOKEN]`) in build logs, runtime diagnostics, and Docker run invocations.
- **Command Injection Prevention**: Repository URLs, branch names, and environment keys are strictly validated with regex (`/^[A-Za-z_][A-Za-z0-9_]*$/`) and executed without shell interpolation (`shell: false`).
- **Cardinality Management**: Metric labels are cleaned from the Prometheus registry upon project deletion to prevent unbounded memory growth.

---

## 🧪 Testing & Verification Suites

DeployHub includes comprehensive automated runtime test suites covering end-to-end repository detection, Docker Compose isolation, secret protection, zero-downtime cutover, and telemetry:

### Run Verification Test Suites

```bash
# 1. Repository-Wide Secret Pattern Scanner (100 Files)
npm run scan:secrets

# 2. Universal Repository Detection & Classification (102 Tests)
npm run test:detector

# 3. Environment Discovery, Required Secrets Preflight & Redaction (12 Tests)
npm run test:compose:preflight

# 4. Docker Compose Multi-Deployment Isolation & Zero-Downtime (6 Tests)
npm run test:compose:isolation

# 5. Docker Compose & Framework Detector (15 Tests)
npm run test:compose

# 6. Milestone 4: Release Management, Zero-Downtime & Rollbacks (21 Tests)
npm run test:m4

# 7. Milestone 3.5: Port Leasing, Cleanup, Indexes & Metrics (11 Tests)
npm run test:m35

# 8. Milestone 3: Webhooks, Branch Filtering & Timings (13 Tests)
npm run test:m3

# 9. Milestone 2: Developer Workflow, Env Vars & Secrets (13 Tests)
npm run test:m2

# 10. Multi-Framework Build & Runtime Matrix (10 Tests)
npm run test:matrix
```

### Verification Results Summary

| Test Suite | Total Tests / Files | Pass Rate | Status | Key Validations |
| :--- | :---: | :---: | :---: | :--- |
| **Secret Scanning Guardrail** | 100 / 100 files | 100% | ✅ PASS | Zero credential-shaped strings, Atlas URIs, or private keys |
| **Universal Repository Detector** | 102 / 102 | 100% | ✅ PASS | Vite, Node backends, fullstack, Python ML/web, monorepos, toolchains |
| **Compose Environment Preflight** | 12 / 12 | 100% | ✅ PASS | Required secret discovery, preflight blocking, log masking |
| **Compose Isolation & Zero-Downtime** | 6 / 6 | 100% | ✅ PASS | Multi-tenant Compose isolation, identical `container_name` safety |
| **Compose & Framework Detector** | 15 / 15 | 100% | ✅ PASS | Multi-service Compose YAML parsing, nested Dockerfile resolution |
| **Milestone 4 Engine** | 21 / 21 | 100% | ✅ PASS | Zero-downtime traffic cutover, rollback, SSE log stream, telemetry |
| **Milestone 3.5 Engine** | 11 / 11 | 100% | ✅ PASS | Distributed Redis port leases, stale deployment reconciliation |
| **Milestone 3 Engine** | 13 / 13 | 100% | ✅ PASS | HMAC webhooks, automated builds, branch filters, deployment timings |
| **Milestone 2 Engine** | 13 / 13 | 100% | ✅ PASS | Auth, projects, encrypted env vars, and secret masking |
| **Multi-Framework Matrix** | 10 / 10 | 100% | ✅ PASS | Express API, Vite SPA dist serving, startup crash diagnostics |

---

## 📄 License

DeployHub is open-source software licensed under the **MIT License**.

