# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| < Latest| :x:                |

We recommend always using the latest version of Jellyfin Enhanced to ensure you have the most recent security updates.

## Reporting a Vulnerability

We take the security of Jellyfin Enhanced seriously. If you believe you have found a security vulnerability, please report it to us responsibly.

### Please DO NOT:
- Open a public GitHub issue for security vulnerabilities
- Disclose the vulnerability publicly before it has been addressed

### Please DO:
1. **Report privately** via GitHub Security Advisories:
   - Go to the [Security tab](../../security/advisories)
   - Click "Report a vulnerability"
   - Provide detailed information about the vulnerability

2. **Include in your report:**

   - Description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact
   - Suggested fix (if any)
   - Your contact information

### What to expect:
- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days with our assessment
- **Fix Timeline**: Depends on severity and complexity
  - Critical: Within 7 days
  - High: Within 30 days
  - Medium: Within 90 days
  - Low: Next regular release

## Security Best Practices for Users

### Plugin Configuration:
1. **API Keys**: Store API keys securely and never commit them to version control
2. **Access Control**: Use Jellyfin's built-in user permissions appropriately
3. **HTTPS**: Always access Jellyfin over HTTPS in production
4. **Updates**: Keep Jellyfin Enhanced and Jellyfin server up to date

### External Integrations:
1. **Seerr**: Ensure your Seerr instance is properly secured
2. **TMDB API**: Protect your TMDB API key and monitor usage
3. **Network Access**: Restrict access to your Jellyfin server appropriately

### Client-Side Security:
- The plugin runs JavaScript in the browser context
- Review custom CSS/JS modifications before applying
- Be cautious with user-generated content

## Known Security Considerations

### Client-Side Storage:
- Bookmarks and settings are stored per-user in Jellyfin's database
- No sensitive credentials are stored client-side

### API Communications:
- All API calls use Jellyfin's authentication system
- External API calls (TMDB, Seerr) are proxied through the plugin backend when possible
- API keys are stored server-side in plugin configuration

### Content Security:
- External content (posters, metadata) is fetched from trusted sources (TMDB, Jellyfin)
- User-provided URLs are validated before use
- XSS protection is implemented for user-generated content

## Spoiler Blur — Operational Notes

The Spoiler Blur feature blurs unwatched-episode images server-side via a
SkiaSharp Gaussian blur applied in an MVC action filter. Two
authentication paths are supported:

1. **Native clients** (Swiftfin, Findroid, Streamyfin, AndroidTV, etc.)
   — the plugin identifies the user from the active Jellyfin session
   that matches the request's remote IP. No special configuration needed.

2. **Web client** — the plugin's client-side JS appends `&api_key=<accessToken>`
   to every Jellyfin `/Items/{id}/Images/...` URL so that the server
   filter can identify the requesting user. Browsers issue anonymous
   `<img src>` requests by default, so without this rewrite the filter
   would have no user context and would pass everything through unblurred.

   **Operational implication for reverse-proxy / log-aggregation
   deployments**: the user's session token now appears in the query
   string of image URLs. Default `nginx` and `apache2` access-log
   formats capture full URLs including query strings, which means the
   token is persisted in cleartext for the log retention window. This
   is a regression compared to Jellyfin's default behaviour (anonymous
   image fetches). Operators using shared hosting, log aggregators, or
   long-retention access logs should either:

   - Scrub `api_key=...` from the access-log format before shipping
     logs. Sample nginx config:
     ```nginx
     map $request_uri $clean_uri {
         "~^(?<prefix>.*[?&])api_key=[^&]*(?<suffix>.*)$"
              $prefix"api_key=REDACTED"$suffix;
         default $request_uri;
     }
     log_format jellyfin_scrubbed '$remote_addr - $remote_user [$time_local] '
                                  '"$request_method $clean_uri $server_protocol" '
                                  '$status $body_bytes_sent';
     access_log /var/log/nginx/jellyfin.log jellyfin_scrubbed;
     ```
   - OR disable Spoiler Blur (`SpoilerBlurEnabled=false` in plugin config)
     until a cookie-based auth path is available.

   The token is the user's normal Jellyfin access token; rotating it
   (logging out and back in) invalidates anything that has been logged.

### Spoiler Blur — Shared-IP Limitations

The session-by-IP fallback used for native clients matches a request to
its user by looking up active Jellyfin sessions whose `RemoteEndPoint`
IP equals the request's `RemoteIpAddress`. Two operational caveats
apply:

1. **Reverse-proxy / NAT collapse.** If Jellyfin runs behind a reverse
   proxy (nginx, Traefik) and `KnownProxies` / `ForwardedHeadersOptions`
   is not configured to trust `X-Forwarded-For`, every request appears
   to come from the proxy's loopback address (typically `127.0.0.1`).
   When two users are simultaneously logged in through the same proxy,
   each anonymous image request matches BOTH sessions; the most
   recently-active one wins. Until the activity disambiguates, User A
   may see images blurred per User B's spoiler list, and vice versa.
   The plugin detects this case (multiple distinct users active within
   a 60-second window from the same IP) and **fails closed** — passes
   through unblurred rather than apply the wrong user's preferences.
   Configure Jellyfin's `KnownProxies` to trust your proxy's
   `X-Forwarded-For` so that the request IP reflects the actual client.

2. **Same-LAN multi-user.** Two devices behind the same external NAT
   IP are isolated only if Jellyfin sees distinct LAN IPs. On a typical
   home LAN the router presents each device's own LAN IP to Jellyfin,
   so this works correctly. On unusual setups (carrier-grade NAT,
   hairpin DNS, IPv6 prefix delegation collapse) two clients may share
   an apparent IP and the same fail-closed behaviour kicks in: blur is
   silently disabled rather than applied to the wrong user.

In both shared-IP scenarios, the failure mode is "no blur" rather than
"wrong-user blur"; no images are leaked TO an unauthorized user, but
the privileged user's spoiler-blur experience is degraded until the IP
disambiguates.

### Spoiler Blur — Header Fingerprint

When Spoiler Blur is enabled for a series, image responses for episodes
of that series carry `Cache-Control: private, no-store, max-age=0,
must-revalidate` and have `ETag` / `Last-Modified` removed — both for
blurred-bytes responses and for watched-episode pass-through. Image
responses for episodes that are NOT on any of the user's spoiler-list
series carry Jellyfin's default `Cache-Control: public, max-age=...`
plus standard validators.

A passive on-path observer with TLS visibility (corporate TLS-inspection
proxy, or operator of a non-HTTPS Jellyfin install) can therefore
distinguish "this episode belongs to a series the user has spoiler-mode
enabled for" from "this episode does not". The episode bytes themselves
are unchanged for watched episodes, so the leak is metadata only — the
series-membership-in-spoiler-list itself, not the user's watched/unwatched
state per-episode. Operators who want to eliminate this fingerprint
should ensure Jellyfin is fronted by HTTPS with no TLS-inspection
intermediaries, which is the recommended baseline for any Jellyfin
deployment.

## Contact

For security concerns that don't constitute a vulnerability, you can:
- Open a regular GitHub issue
- Start a discussion in GitHub Discussions
- Contact the maintainers directly

Thank you for helping keep Jellyfin Enhanced secure!
