# Seerr proxy write outcomes

Server side of SEERR-CORE-06 / SRC-R1-004. Jellyfin 12.x only.

`ProxyJellyseerrRequest` in `Features/Seerr/JeSeerrController.cs` forwards the browser's Seerr calls. Its only writes are `POST /api/v1/request` (`jellyseerr/request` and `jellyseerr/request/tv/{tmdbId}/seasons`) and `POST /api/v1/issue` (`jellyseerr/issue`). Seerr has no idempotency key, so a write that may already have been applied must not be repeated, and the browser must be told when the proxy cannot know whether it was applied.

## Contract

A failed write returns the existing failure envelope with one more property:

```json
{ "error": true, "code": "unreachable", "message": "Can't reach Seerr right now. Please try again in a moment.", "requestOutcome": "unknown" }
```

| `requestOutcome` | Meaning | Browser treatment |
| --- | --- | --- |
| `unknown` | The write was handed to the network and Seerr may have applied it. | Uncertain: refresh the title's status, do not report a definite failure or invite a blind retry. |
| `rejected` | Seerr answered with its own JSON 4xx (other than 408): quota, permission, duplicate (409), validation, rate limit, API key (401/403). | Definite failure. |
| `not_sent` | JE refused or failed the write before any byte reached a Seerr URL. | Definite failure; retrying is safe. |

- The property name is lowercase `requestOutcome` under every host serializer (default, PascalCase, CamelCase profile); the value is exactly one of the three strings. The typed contract is `Shared/Seerr/SeerrRequestOutcome.cs`: `SeerrRequestOutcome` (enum, pinned wire names), `SeerrRequestOutcomes.PropertyName`, and `SeerrProxyErrorResponse` (the envelope).
- Successful writes are unchanged: Seerr's JSON body is returned as-is (`ContentResult`, `application/json`) with no envelope.
- Reads never carry `requestOutcome`; their envelopes are byte-for-byte what they were.
- `code`, `message`, `error`, `httpStatus` and the HTTP status keep their existing values. Non-admins get the sanitized message only; Jellyfin administrators also get the technical message, `url` and `cfRay`, as before.
- A failed write without `requestOutcome` can still occur in exactly one case: the principal carries no Jellyfin user id, which answers an empty `ForbidResult` (403) before any lookup. It is unreachable behind `[Authorize]` and is pre-dispatch. Route validation in `RequestTvSeasons` (`400 invalid_tmdb_id`, `media_type_mismatch`, `media_id_mismatch`) also answers before the proxy and has no outcome; it is pre-dispatch too.

### Which failures get which outcome

| Failure | HTTP / `code` | `requestOutcome` |
| --- | --- | --- |
| Seerr disabled or not configured | 503 / `not_configured` (writes now get this JSON envelope; reads keep the plain-text body) | `not_sent` |
| Every Seerr URL unreachable during the user lookup | 502 / `unreachable` | `not_sent` |
| User blocked from Seerr / not linked | 403 `blocked` / 404 `unlinked` | `not_sent` |
| JE permission gate (`no_request_permission`, `no_issue_permission`) | 403 (no `error` field, as before) | `not_sent` |
| Parental rating block on the request body | 403 / `parental_block` | `not_sent` |
| DNS failure or refused / unroutable TCP connect on every URL | 502 / `unreachable` | `not_sent` |
| Request could not be built for a URL (malformed configured URL) | 502 / `unreachable` | `not_sent` |
| Seerr JSON 401 / 403 | 401 `Unauthorized` / 403 `Forbidden` | `rejected` |
| Seerr JSON 4xx except 408 (400, 404, 409, 429, ...) | same status / `UpstreamError` | `rejected` |
| Seerr JSON 408 or 5xx | same status / `UpstreamError` | `unknown` |
| Non-JSON reply of any status (HTML 2xx login page, 204, proxy 403/504 page) | 502 / `HtmlResponse` | `unknown` |
| Redirect | 502 / `UpstreamRedirect` | `unknown` |
| Cloudflare 520-530 | 502 / `Cloudflare5xx` | `unknown` |
| JSON 2xx whose body is empty, truncated or malformed | 502 / `ParseError` (new code, writes only) | `unknown` |
| Timeout (`HttpClient.Timeout`, 15 s), connection reset or closed after sending, response ended early, body read failure, TLS failure, any other exception after dispatch | 502 / `unreachable` | `unknown` |

A non-JSON 4xx (for example a reverse-proxy or WAF block page) is deliberately `unknown`, not `rejected`: it is not Seerr's validated answer. TLS handshake failures are also `unknown`: they are not distinguished from later transport faults.

## Dispatch and failover

- **Reads** are unchanged: up to three attempts per URL on a JSON 5xx (400 ms, 800 ms back-off), then the next configured URL; exceptions fail over; a browser abort answers 499 and does not fail over. Only verified JSON 2xx responses are cached; the parental filter and Spoiler Guard redaction run on the way out.
- **Writes** get one attempt. Once a write has been passed to `HttpClient.SendAsync` for a URL, it ends there whatever happens: a response of any kind, a timeout, or a lost connection returns immediately and is never retried on that URL or sent to another one. Baseline failed a write over to the next URL after a 4xx/5xx, a non-JSON reply or any exception, so a quota refusal or a lost reply produced a second, independent request.
- The only write failover left is when the exception proves nothing was sent: `HttpRequestException` with `HttpRequestError.NameResolutionError` or `ConnectionError` **and** an inner `SocketException` of `ConnectionRefused`, `HostNotFound`, `TryAgain`, `NoData`, `HostUnreachable`, `NetworkUnreachable` or `AddressNotAvailable` (`SeerrRequestOutcomes.IsProvablyUnsent`). A failure to build the request for a URL also fails over. Everything else is `unknown`.
- Writes are never cancelled by the browser going away (unchanged): the upstream call runs to completion with `CancellationToken.None`.
- `SeerrCsrfHandler` still repeats a write once when Seerr's CSRF middleware answers 403 with a body mentioning `csrf`. That first answer is a complete refusal from Seerr before route handling, so the repeat is not a duplicate write. Its status probe failures are swallowed and do not affect the outcome.

## Cache

A successful `POST /api/v1/request` evicts the title's cached `/movie/{id}` and `/tv/{id}` entries for every user (unchanged). An `unknown` request outcome now evicts them too, so the browser's follow-up status read reaches Seerr rather than a cached pre-write answer. A `rejected` or `not_sent` outcome leaves the cache alone.

## Tests

- `tests/backend/Features/Seerr/ApiSeerrProxyOutcomeTests.cs` drives the real `JellyseerrRequest` / `ReportJellyseerrIssue` / `GetMovie` / `GetTvShow` routes with two configured Seerr URLs through the production client shape (`SeerrCsrfHandler` over the primary handler). Synthetic-transport cases cover every row of the table above, admin/non-admin message privacy, cache eviction, read retry/failover and browser cancellation. Real-socket cases use a loopback HTTP/1.1 server and the production primary handler (`HttpClientHandler`, no redirects, no cookies): an accepted write whose connection is dropped or whose body is cut short is `unknown` with exactly one POST across both URLs; the same on a reused pooled keep-alive connection is still sent once; a refused port fails over and the second URL receives the only POST; refusal on every URL is `not_sent`. These tests only read the serialized envelope, so they also compile against the baseline controller.
- `tests/backend/Shared/SeerrRequestOutcomeContractTests.cs` pins the wire values and property names under Jellyfin's default, PascalCase and CamelCase serializer options, checks read envelopes are identical to the old anonymous shapes, and tables the classification rules.

## Not covered

- No live Seerr, reverse proxy or Jellyfin host was exercised. Behaviour of real proxies (nginx, Traefik, Cloudflare) answering mid-write is inferred from their status codes.
- Platform resend: the test shows .NET 10's handler did not resend the POST after a silent close on a reused connection in this case; it does not prove no runtime version or HTTP/2 path ever does.
- Seerr writes outside this proxy were not changed: just-in-time user import (`TryAutoImportJellyseerrUser`, still fails over after an error or `HttpRequestException`; importing the same Jellyfin id is not a new request), approve/decline (`arr/requests/{id}/approve|decline`, first valid URL only, no failover) and the administrator's recently-added scan trigger.
- The browser consumer of `requestOutcome` is owned separately and is not part of this change.
