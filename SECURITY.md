# DeployHub Security Policy & Guardrails

## 1. Absolute Rule: Never Hard-Code Secret-Like Values

**NEVER** hard-code real OR fake credential-shaped values in source-controlled files.

This includes:
- MongoDB Atlas URIs with credentials
- Connection strings with embedded username and password credentials
- Real or fake Bearer JWT tokens
- API keys, OAuth secrets, Cloudinary secrets, Stripe keys, AWS access keys
- Private key blocks (PEM / RSA / OpenSSH)
- Passwords or sensitive tokens in test files, fixtures, documentation, or examples

GitHub Secret Scanning flags realistic credential formats even if the values are fake or placeholders.

---

## 2. Safe Test Values Policy

When writing tests, mocks, or fixtures:

1. **Supply credentials via environment variables:**
   ```typescript
   const mongoUri = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/deployhub_test';
   const accessTokenSecret = process.env.TEST_ACCESS_TOKEN_SECRET || 'TEST_ONLY_PLACEHOLDER';
   ```
2. **Use clearly local and non-secret fallback identifiers:**
   - `"TEST_ONLY_PLACEHOLDER"`
   - `"unit-test-secret"`
   - `"local-test-token"`
   - Local loopback addresses: `127.0.0.1:27017`, `localhost:6379`
3. **Never use realistic cloud domains or URI schemes in test strings:**
   - Always prefer local database endpoints without embedded passwords.
   - Example: `mongodb://127.0.0.1:27017/testdb`

---

## 3. Environment Variable Policy

All sensitive production and staging configurations MUST only be loaded through process environment variables or an approved secret store:
- `process.env.MONGODB_URI`
- `process.env.JWT_SECRET`
- `process.env.ACCESS_TOKEN_SECRET`
- `process.env.REFRESH_TOKEN_SECRET`
- `process.env.CLOUDINARY_API_KEY`
- `process.env.CLOUDINARY_API_SECRET`
- `process.env.GITHUB_CLIENT_SECRET`

---

## 4. Automated Secret Scanning Guardrail

DeployHub includes a repository-wide secret scanner:

```bash
npm run scan:secrets
```

Run this command before committing or pushing changes to verify that no credential-shaped strings exist in tracked files.
