# LinkWork — Production Application Foundation

LinkWork is a server-backed task marketplace architecture with PostgreSQL persistence, secure authentication, RBAC, transactional task settlement, an append-only financial ledger, deposit records, withdrawal requests, billing records, audit logs and an Owner/Admin Control Center.

## What is real in this build

- PostgreSQL-backed users, sessions, tasks, balances, ledger entries, billing records, deposits, withdrawals and audit logs.
- Argon2id password hashing.
- Server-side HTTP-only sessions.
- CSRF token protection for state-changing authenticated requests.
- Role-based authorization enforced on the API.
- Atomic task approval that creates billing + ledger + worker balance update.
- Database trigger preventing ledger UPDATE/DELETE.
- Deposit submission that does not credit balance.
- Withdrawal requests that reserve recorded balance and require Owner/Admin review.
- Owner-only overview/settings/audit endpoints.
- Signed webhook boundary with idempotency storage.
- Responsive web dashboard.
- Ten-language UI selection persisted to the user's database account.
- No demo users and no fake financial transactions.

## What still requires an authorized provider adapter

The project intentionally does not invent a payment provider, payout rail, crypto exchange, bank, UPI or wallet integration. The `/api/webhooks/:provider` boundary verifies an HMAC signature when configured and stores the event. A provider-specific adapter must be implemented against the provider's official API/webhook documentation and credentials before any automatic deposit crediting or payout processing is enabled.

That separation is intentional: a browser click is never treated as payment verification.

## Run locally

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate
npm start
```

Open `http://localhost:3000`.

There is intentionally no demo login. Create the first real Owner account through a controlled provisioning process before exposing the Owner Control Center. The registration endpoint only permits CLIENT and WORKER roles; OWNER/ADMIN roles must be provisioned server-side.

## Production requirements

Before live deployment, add:
- controlled Owner provisioning
- provider-specific payment adapters and reconciliation
- production email/SMS delivery
- password reset token delivery
- encrypted payout destination storage where required
- object storage with malware scanning and signed URLs for uploads
- tax/legal configuration reviewed for the operating jurisdiction
- monitoring/error tracking
- managed secrets
- WAF/reverse proxy
- backup and restore testing
- CI security/dependency scanning
- penetration testing
- complete E2E test suite

Do not enable live financial flows until the selected providers and jurisdictional requirements have been reviewed and the provider adapters have been implemented.
