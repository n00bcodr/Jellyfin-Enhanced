# Security Guidelines for Contributors

## Overview

This document provides security guidelines for contributors to Jellyfin Enhanced. Following these practices helps maintain the security and integrity of the plugin.

## Code Security Best Practices

### 1. Input Validation

Always validate and sanitize user inputs:

```csharp
// Good - Validate input
public IActionResult GetItem(string itemId)
{
    if (string.IsNullOrWhiteSpace(itemId) || !Guid.TryParse(itemId, out _))
    {
        return BadRequest("Invalid item ID");
    }
    // Process valid input
}

// Bad - No validation
public IActionResult GetItem(string itemId)
{
    // Directly using itemId without validation
}
```

### 2. API Key Management

Never hardcode API keys or secrets:

```csharp
// Good - Use configuration
var apiKey = _config.GetValue<string>("TmdbApiKey");

// Bad - Hardcoded key
var apiKey = "abc123xyz";
```

### 3. SQL Injection Prevention

Use parameterized queries:

```csharp
// Good - Parameterized
var query = "SELECT * FROM Items WHERE Id = @id";
command.Parameters.AddWithValue("@id", itemId);

// Bad - String concatenation
var query = $"SELECT * FROM Items WHERE Id = '{itemId}'";
```

### 4. XSS Prevention (JavaScript)

Sanitize user-generated content:

```javascript
// Good - Escape HTML
function displayUserContent(content) {
    const div = document.createElement('div');
    div.textContent = content; // Automatically escapes
    return div.innerHTML;
}

// Bad - Direct HTML injection
function displayUserContent(content) {
    element.innerHTML = content;
}
```

### 5. CSRF Protection

Use Jellyfin's built-in authentication:

```csharp
// Good - Require authentication
[Authorize]
[HttpPost]
public IActionResult UpdateSettings([FromBody] Settings settings)
{
    // Protected endpoint
}
```

### 6. Path Traversal Prevention

Validate file paths:

```csharp
// Good - Validate path
public IActionResult GetFile(string filename)
{
    var safePath = Path.GetFileName(filename); // Removes directory info
    var fullPath = Path.Combine(_basePath, safePath);

    if (!fullPath.StartsWith(_basePath))
    {
        return BadRequest("Invalid path");
    }
    // Process file
}

// Bad - No validation
public IActionResult GetFile(string filename)
{
    var fullPath = Path.Combine(_basePath, filename);
    // Vulnerable to ../../../etc/passwd
}
```

## Dependency Management

### NuGet Packages

1. **Keep dependencies updated**: Use Dependabot to stay current
2. **Review dependencies**: Check for known vulnerabilities before adding
3. **Minimize dependencies**: Only add what's necessary
4. **Pin versions**: Use specific versions in production

```xml
<!-- Good - Specific version -->
<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />

<!-- Bad - Wildcard version -->
<PackageReference Include="Newtonsoft.Json" Version="*" />
```

### JavaScript Dependencies

1. **No external CDNs**: Bundle all JavaScript dependencies
2. **Subresource Integrity**: If using CDN, use SRI hashes
3. **Regular audits**: Run `npm audit` regularly

## Authentication & Authorization

### User Context

Always verify user permissions:

```csharp
// Good - Check permissions
public IActionResult DeleteItem(Guid itemId)
{
    var user = _userManager.GetUserById(UserId);
    if (!user.HasPermission(PermissionKind.DeleteLibraryItems))
    {
        return Forbid();
    }
    // Proceed with deletion
}
```

### Session Management

- Use Jellyfin's session management
- Don't create custom authentication
- Validate session tokens on every request

## Data Protection

### Sensitive Data

1. **Never log sensitive data**: API keys, passwords, tokens
2. **Encrypt at rest**: Use Jellyfin's encryption for stored secrets
3. **Secure transmission**: Always use HTTPS in production

```csharp
// Good - Redact sensitive data
_logger.LogInformation("API call to {Service}", serviceName);

// Bad - Log sensitive data
_logger.LogInformation("API call with key {ApiKey}", apiKey);
```

### Personal Information

- Follow GDPR principles
- Minimize data collection
- Provide data export/deletion capabilities
- Document data retention policies

## Error Handling

### Information Disclosure

Don't expose internal details in errors:

```csharp
// Good - Generic error
catch (Exception ex)
{
    _logger.LogError(ex, "Failed to process request");
    return StatusCode(500, "An error occurred");
}

// Bad - Expose details
catch (Exception ex)
{
    return StatusCode(500, ex.ToString());
}
```

## Testing Security

### Security Tests

Include security-focused tests:

```csharp
[Fact]
public void GetItem_WithInvalidId_ReturnsBadRequest()
{
    // Test input validation
    var result = _controller.GetItem("../../../etc/passwd");
    Assert.IsType<BadRequestResult>(result);
}

[Fact]
public void DeleteItem_WithoutPermission_ReturnsForbidden()
{
    // Test authorization
    var result = _controller.DeleteItem(itemId);
    Assert.IsType<ForbidResult>(result);
}
```

## Code Review Checklist

Before submitting a PR, verify:

- [ ] All user inputs are validated
- [ ] No hardcoded secrets or API keys
- [ ] SQL queries use parameterization
- [ ] HTML content is properly escaped
- [ ] File paths are validated
- [ ] Authentication is required for sensitive operations
- [ ] Errors don't expose sensitive information
- [ ] Dependencies are up to date
- [ ] Security tests are included
- [ ] Documentation is updated

## Reporting Security Issues

See [SECURITY.md](../../SECURITY.md) for reporting vulnerabilities.

## Security Tools

We use the following tools:

1. **CodeQL**: Static analysis for C# and JavaScript
2. **Dependabot**: Automated dependency updates
3. **TruffleHog**: Secret scanning
4. **OpenSSF Scorecard**: Security posture assessment
5. **Dependency Review**: License and vulnerability checking

## Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [CWE Top 25](https://cwe.mitre.org/top25/)
- [.NET Security Guidelines](https://docs.microsoft.com/en-us/dotnet/standard/security/)
- [Jellyfin Security](https://jellyfin.org/docs/general/security/)

## Questions?

If you have security questions, please:
1. Check existing documentation
2. Ask in GitHub Discussions
3. Contact maintainers privately for sensitive topics
