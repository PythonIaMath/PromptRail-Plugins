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
- Interactive Infinite installation requires a signed-in PromptRail account, an active Infinite
  entitlement, and explicit approval of a short-lived device authorization.
- Device grants and install grants expire and are single-use. The resulting Infinite machine key is
  scoped and revocable, and PromptRail stores only its hash.
- Provider bearer tokens are forwarded only to the fixed provider upstream.
- Unsupported proxy paths are rejected.
- Redirects are not followed automatically.
- Configuration and install-state files use user-only permissions.
- Uninstall removes only PromptRail-owned configuration and preserves unrelated changes made after
  installation.

## User responsibility

Treat PromptRail access tokens and Infinite machine keys as secrets. Do not commit them, paste them
into issue reports, or share router configuration or credential files.
