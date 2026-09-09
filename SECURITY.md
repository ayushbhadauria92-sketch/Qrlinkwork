# LinkWork Security Baseline

## Authentication
- Argon2id password hashing.
- Server-side sessions stored in PostgreSQL.
- HTTP-only SameSite cookies.
- Secure cookie flag must be enabled in production.
- Session expiration is configurable.
- Login failures are audited without recording passwords.
- Owner/Admin access is enforced server-side.

## Financial integrity
- Balances are stored in PostgreSQL.
- Ledger entries are append-only at the database level.
- Balance mutations are performed by server-side transactions.
- Deposit records do not credit balances on submission.
- Webhooks require a provider signature secret.
- Webhook events have an idempotency key.
- Provider-specific verification must be implemented before enabling automatic crediting.

## Sensitive data
- Do not put provider secrets, private keys, OTPs or PINs in frontend code.
- Do not store financial secrets in localStorage.
- Payout destinations should be encrypted at rest when the selected provider requires storing them.
- Logs must never contain passwords or provider secrets.

## Deployment
- Set COOKIE_SECURE=true.
- Set a strong DATABASE_URL.
- Set a strong CSRF_SECRET and FIELD_ENCRYPTION_KEY.
- Use a managed secret store in production.
- Put the application behind HTTPS and a reverse proxy/WAF.
- Configure database backups, restore testing, monitoring and alerting.
- Restrict PostgreSQL network access.
- Run migrations from CI/CD with controlled credentials.
