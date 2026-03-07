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
1. **Jellyseerr/Overseerr**: Ensure your Seerr instance is properly secured
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

## Contact

For security concerns that don't constitute a vulnerability, you can:
- Open a regular GitHub issue
- Start a discussion in GitHub Discussions
- Contact the maintainers directly

Thank you for helping keep Jellyfin Enhanced secure!
