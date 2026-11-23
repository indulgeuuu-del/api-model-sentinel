# Security policy

## Reporting

Please use this repository's **Security → Report a vulnerability** when private reporting is enabled. Never post live API keys, connection codes, decrypted state or complete service logs in public issues. Revoke any accidentally exposed credential at the provider before discussing it.

The current1.x line receives security fixes. No response-time or long-term support contract is implied.

## Trust boundaries

- HTTP binds only to `127.0.0.1`; Host/Origin and cross-site checks reject browser requests from other sites. APIs require a256-bit local connection code. Static assets and `/health` contain no private configuration.
- The connection code is put in the initial URL fragment, immediately removed from the address bar and kept in tab session storage. It controls monitoring and shutdown. “Lock panel” clears this tab's token, not other copies; restart or locking does not rotate the persistent code.
- API keys are write-only from the browser's point of view. Config/history output removes known credentials and sensitive fields. Scrubbing is defense in depth, not a guarantee against arbitrary provider text containing a transformed secret.
- AES-256-GCM protects local state. WindowsDPAPI wraps the master key for the current user. Other platforms keep the key in a mode600 file and data directory in mode700. Programs running as the same user can generally read/use the service and its key; disk encryption is recommended for physical access protection.
- User-configured HTTPS providers receive the prompt, model settings and their authentication key. PlainHTTP is allowed only for loopback development endpoints. Redirects are rejected. Only start profiles whose endpoint you trust.
- Provider responses are untrusted data. They are byte-limited, parsed as JSON/SSE and rendered with textContent. CSP blocks inline scripts; CSV export prefixes formula-like values.
- The optional Codex adapter depends on private local interfaces and can stop user work when explicitly enabled. It is experimental, uses readiness checks and has no process-killing fallback.

No telemetry, third-party frontend assets, hosted account system, webhook delivery or remote access tunnel is included. Do not expose the panel through a public proxy. Do not commit runtime data, encryption keys or logs; release packaging uses an explicit source allowlist.

## Updating dependencies

Production runtime dependencies: none. Development dependencies are lockfile-pinned. Review Dependabot changes, run `npm run verify`, and inspect the allowlisted archive before tagging a release.
