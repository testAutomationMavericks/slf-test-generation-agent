# TMA Knowledge Base — EC2 PostgreSQL Setup Guide

This document is for the DevOps team setting up the PostgreSQL + pgvector instance
that backs the TMA (Test Management Agent) knowledge base.

---

## What you are setting up

A single PostgreSQL 16 database with the **pgvector** extension installed.
The application stores AI-generated test cases as vector embeddings and uses
cosine similarity search to find duplicates and retrieve relevant context.

No other services are required — just PostgreSQL + pgvector.

---

## Requirements

| Item | Minimum | Recommended |
|------|---------|-------------|
| EC2 instance | t3.small (2 vCPU / 2 GB RAM) | t3.medium (2 vCPU / 4 GB RAM) |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| PostgreSQL | 15 | **16** |
| pgvector | 0.7.0+ | **0.8.0+** |
| Disk | 20 GB gp3 | 50 GB gp3 |
| Port | 5432 (restrict to app server IP only) | — |

> **RDS alternative:** RDS for PostgreSQL 15.2+ with the `pgvector` feature enabled
> works identically. Skip to [Run the schema](#3-run-the-schema) if using RDS.

---

## Option A — Native PostgreSQL on Ubuntu EC2

### 1. Install PostgreSQL 16

```bash
sudo apt update
sudo apt install -y curl ca-certificates

# Add PostgreSQL official repo
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc
sudo sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
  https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list'

sudo apt update
sudo apt install -y postgresql-16
```

### 2. Install pgvector

```bash
sudo apt install -y postgresql-16-pgvector
```

> That is all. The `CREATE EXTENSION IF NOT EXISTS vector;` line in the schema
> handles activation — DevOps does not need to run anything extra for pgvector.

### 3. Create the database and user

```bash
sudo -u postgres psql <<'SQL'
CREATE USER tma WITH PASSWORD 'choose-a-strong-password';
CREATE DATABASE tma_kb OWNER tma;
GRANT ALL PRIVILEGES ON DATABASE tma_kb TO tma;
SQL
```

### 4. Run the schema

```bash
# Clone or copy the repo to the EC2 instance, then:
sudo -u postgres psql -d tma_kb -U tma \
  -f /path/to/repo/src/kb/schema.sql
```

This single file creates:
- `kb_documents` table (test cases + vector embeddings)
- `duplicate_log` table
- `approvals` table
- HNSW vector index
- `find_duplicates()` function
- `kb_stats` and `stale_entries` views

### 5. Allow remote connections

**PostgreSQL config** — edit `/etc/postgresql/16/main/postgresql.conf`:
```
listen_addresses = '*'
```

**pg_hba.conf** — edit `/etc/postgresql/16/main/pg_hba.conf`, add:
```
# Allow the app server only (replace with actual app server IP)
host  tma_kb  tma  <APP_SERVER_IP>/32  scram-sha-256
```

```bash
sudo systemctl restart postgresql
```

**AWS Security Group** — inbound rule:
| Type | Protocol | Port | Source |
|------|----------|------|--------|
| Custom TCP | TCP | 5432 | App server security group (or IP) |

> Do **not** open port 5432 to `0.0.0.0/0`.

### 6. Verify

```bash
psql "postgresql://tma:choose-a-strong-password@localhost:5432/tma_kb" \
  -c "SELECT * FROM kb_stats;"
```

Expected output (empty but no error):
```
 total_entries | active_entries | outdated_entries | ...
---------------+----------------+------------------+----
             0 |              0 |                0 | ...
```

---

## Option B — Docker on EC2 (quickest setup)

If you prefer to run PostgreSQL in Docker on the EC2 instance, the repo already
includes a `docker-compose.yml` that uses the official `pgvector/pgvector:pg16`
image. pgvector is pre-installed in that image.

```bash
# On the EC2 instance:
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker ubuntu   # re-login after this

git clone <repo-url>
cd slf-test-generation-agent

# Set a strong password
echo "POSTGRES_PASSWORD=choose-a-strong-password" > .env

docker compose up -d
```

The schema (`src/kb/schema.sql`) is auto-applied on first container start.

Verify:
```bash
docker compose ps          # should show tma-kb-postgres as healthy
docker compose exec postgres psql -U tma -d tma_kb -c "SELECT * FROM kb_stats;"
```

---

## What to hand back to the development team

Once the database is running, provide these values so they can be added to `.env`:

```
DATABASE_URL=postgresql://tma:<password>@<ec2-host-or-ip>:5432/tma_kb
```

The app uses this single connection string — no separate DB_NAME or DB_PORT needed.

---

## Migration files (run order)

If you need to apply schema changes incrementally rather than from scratch,
run the migration files in order:

| File | Purpose |
|------|---------|
| `src/kb/schema.sql` | Full schema — use this for a fresh install |
| `tma/migrations/001_duplicate_detection.sql` | Adds duplicate detection to an existing DB |
| `tma/migrations/002_unify_tables.sql` | Unifies `test_knowledge` → `kb_documents` |

All migration files are idempotent (safe to run multiple times).

---

## Backup recommendation

```bash
# Daily pg_dump (add to cron)
pg_dump "postgresql://tma:<password>@localhost:5432/tma_kb" \
  --format=custom \
  --file="/backups/tma_kb_$(date +%Y%m%d).dump"
```

For Docker, use `docker compose exec postgres pg_dump ...` and mount a backup volume.

---

## Troubleshooting

**`could not open extension control file ... vector.control`**
pgvector is not installed. Run `sudo apt install postgresql-16-pgvector` and retry.

**`password authentication failed for user "tma"`**
Check the password in `pg_hba.conf` and that `scram-sha-256` is the auth method.

**`Connection refused` from app server**
Check: (1) `listen_addresses = '*'` in `postgresql.conf`, (2) the EC2 security group
allows port 5432 from the app server, (3) `pg_hba.conf` has the app server IP.

**HNSW index creation fails**
Requires pgvector 0.5.0+. Run `SELECT extversion FROM pg_extension WHERE extname = 'vector';`
to check. Upgrade with `sudo apt install --only-upgrade postgresql-16-pgvector`.
