# LinkWork API

Base path: `/api`

## Authentication
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /me`
- `GET /csrf`
- `PATCH /me/language`

## Tasks
- `GET /tasks`
- `POST /tasks` — CLIENT
- `POST /tasks/:id/claim` — WORKER
- `POST /tasks/:id/submit` — WORKER
- `POST /tasks/:id/approve` — CLIENT

Approval performs an atomic billing + ledger + worker-balance update.

## Financial
- `GET /balance`
- `GET /ledger`
- `POST /deposits`
- `GET /withdrawals`
- `POST /withdrawals`
- `GET /invoices`

## Owner
- `GET /owner/overview`
- `GET /owner/audit-logs`
- `GET /owner/settings`
- `PUT /owner/settings/:key`

## Provider
- `POST /webhooks/:provider`

The webhook endpoint verifies the configured HMAC signature and records event IDs for idempotency. A real provider adapter must map the provider's authenticated event schema to LinkWork before any deposit is credited.
