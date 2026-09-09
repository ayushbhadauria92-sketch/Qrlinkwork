# Production Deployment

1. Provision PostgreSQL 17 or a supported managed PostgreSQL service.
2. Provision Node.js 24 LTS or newer supported LTS. Node 24 is the recommended baseline.
3. Copy `.env.example` to the deployment secret store; do not commit `.env`.
4. Generate cryptographically random secrets for CSRF and encryption.
5. Run `npm ci`.
6. Run `npm run db:migrate` using a restricted migration credential.
7. Build/package the application through CI.
8. Run behind HTTPS with a reverse proxy/load balancer.
9. Set `COOKIE_SECURE=true`.
10. Configure `TRUST_PROXY=true` only when the proxy configuration is trusted.
11. Configure database backups and test restoration.
12. Configure centralized logs and error monitoring.
13. Configure uptime/health monitoring against `/health`.
14. Configure provider webhook URLs over HTTPS.
15. Complete provider-specific verification, legal/compliance review, reconciliation and payout controls before enabling live financial operations.
16. Do not create demo users or seed financial data.

## Important

The codebase intentionally has no fake payment confirmation and no automatic payout implementation. A provider integration must be authorized, tested in the provider's official environment, reconciled, and reviewed before production activation.
