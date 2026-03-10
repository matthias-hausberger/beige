# Security Checklist

## Input Validation

- [ ] All user input is validated and sanitized
- [ ] File paths are validated (no path traversal)
- [ ] URLs are validated (no SSRF)
- [ ] Email addresses are validated
- [ ] Numeric inputs are bounded

## Injection Prevention

- [ ] SQL queries use parameterized statements
- [ ] No string concatenation for queries
- [ ] User input is escaped before rendering (XSS)
- [ ] No `eval()` or `Function()` with user input
- [ ] Command injection prevented in shell calls

## Authentication & Authorization

- [ ] Sensitive endpoints require authentication
- [ ] User can only access their own resources
- [ ] Admin functions are properly restricted
- [ ] Session tokens are secure and rotated
- [ ] Password reset flows are secure

## Data Protection

- [ ] Sensitive data encrypted at rest
- [ ] TLS used for data in transit
- [ ] No secrets in logs or error messages
- [ ] PII is handled according to policy
- [ ] Data retention policies followed

## Dependencies

- [ ] Dependencies are up to date
- [ ] No known vulnerabilities in dependencies
- [ ] Only necessary dependencies included
- [ ] Lock file is committed

## API Security

- [ ] Rate limiting implemented
- [ ] Input size limits enforced
- [ ] Proper HTTP status codes used
- [ ] CORS configured correctly
- [ ] API keys not exposed to client
