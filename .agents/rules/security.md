# Security Rules for DeployHub Development

## Rule: Never Hard-Code Secret-Like Values

1. NEVER write credential-shaped strings (real or fake) in code, tests, fixtures, or docs.
2. NEVER write cloud database URIs with credentials or realistic token strings.
3. For tests, always use `process.env.TEST_*` with local fallbacks (`mongodb://127.0.0.1:27017/deployhub_test`, `'TEST_ONLY_PLACEHOLDER'`).
4. Always run `npm run scan:secrets` after modifying tests or configurations to verify compliance.
