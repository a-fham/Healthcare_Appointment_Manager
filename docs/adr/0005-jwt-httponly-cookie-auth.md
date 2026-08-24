# JWT in httpOnly cookie for role-based auth

We decided on stateless JWTs carrying `{ sub, role }`, issued at login,
transported in an `httpOnly, SameSite=Lax` cookie, verified by an Express
middleware that also enforces role gates (`requireRole('doctor')`).
Passwords are hashed with bcrypt.

## Why

- Three roles (patient / doctor / admin) with clean route-level separation map
  directly to a token claim + middleware guard , the simplest mechanism that
  fully satisfies "role-based auth" without external services.
- httpOnly cookie beats localStorage storage: no XSS token theft; SameSite=Lax
  blunts CSRF for our JSON-only API.
- No session store needed (stateless), which keeps the dependency list at zero
  extra infrastructure.

## Considered options

- **Server sessions + connect-pg-simple** , equally secure, slightly simpler to
  revoke; rejected because JWT keeps the API stateless and the pattern is more
  portable knowledge. Revocation needs are modest: logout clears the cookie;
  password reset is out of scope.
- **Passport.js strategies** , abstraction overhead with no benefit for two
  flows (password register/login).
- **Auth0/Supabase auth** , violates the minimal-dependency guideline and hides
  exactly the skills being evaluated.
- **Access + refresh token pair** , more correct for long-lived apps, but this
  demo's sessions are short; a single 7-day token with clear trade-off notes is
  proportionate. Documented as future hardening.

## Consequences

- Token revocation before expiry isn't supported (accepted, documented).
- The client never parses the token; it calls `/api/auth/me` to learn identity
  and role, keeping the cookie opaque to JS.
