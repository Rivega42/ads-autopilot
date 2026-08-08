# Runbook: Credential Leak Incident

## 1. Assess scope (first 15 minutes)

1. Check `AuditLog` for unauthorized `credential.read` actions:
   ```sql
   SELECT * FROM "AuditLog"
   WHERE action = 'credential.read'
     AND "createdAt" > now() - interval '24 hours'
   ORDER BY "createdAt" DESC;
   ```
2. Identify which `clientId` and `provider` was exposed.
3. Note source IP if available.

## 2. Revoke token at the provider (within 30 minutes)

- **Yandex Direct**: [oauth.yandex.ru](https://oauth.yandex.ru) → My apps → Revoke token.
- **VK Ads**: VK API `account.revokeAccessToken`.
- **TikTok**: TikTok Ads Manager → App Management → Revoke.

## 3. Revoke internal credential

```bash
DATABASE_URL=... tsx scripts/revoke-credential.ts --clientId=<id> --provider=YANDEX_DIRECT
```

## 4. Rotate the encryption key (if key was compromised)

```bash
pnpm rekey --old-key=<base64> --new-key=$(openssl rand -base64 32)
```

Dry-run by default — add `--execute` to apply.

## 5. Notify client

Send a message via the Telegram bot:

> ⚠️ We detected unauthorized access to your [Provider] credentials. Your token has been revoked. Please reconnect via /connect.

## 6. Post-incident

- File an incident report in `docs/incidents/YYYY-MM-DD-<slug>.md`
- Update `.env` with new `CREDENTIALS_ENCRYPTION_KEY`
- Restart the service
- Review access patterns in `AuditLog` for next 48h
