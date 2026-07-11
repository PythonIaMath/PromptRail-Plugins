# Security Policy

## Report a vulnerability

Do not open a public issue for a vulnerability involving credentials, authentication, local proxy
access, or cross-user data exposure.

Email [support@promptrail.ai](mailto:support@promptrail.ai) with the subject `Security report` and
include reproduction steps, affected versions, and impact.

## Security properties

- Local proxies bind to `127.0.0.1` only.
- Provider API-key traffic is rejected by subscription-only routes.
- PromptRail endpoints require a separate PromptRail access token.
- Provider bearer tokens are forwarded only to the fixed provider upstream.
- Unsupported proxy paths are rejected.
- Redirects are not followed automatically.
- Configuration and install-state files use user-only permissions.
- Uninstall refuses to overwrite provider configuration changed after installation.

## User responsibility

Treat the PromptRail access token as a secret. Do not commit it, paste it into issue reports, or
share router configuration files.
