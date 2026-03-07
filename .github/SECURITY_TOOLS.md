# Security Tools Quick Reference

## Available Security Tools

### 1. CodeQL (Best for: Static Code Analysis)
**What it does**: Analyzes C# and JavaScript code for security vulnerabilities and code quality issues.

**Strengths**:
- Deep semantic analysis
- Finds complex vulnerabilities (SQL injection, XSS, etc.)
- Low false positive rate
- Integrated with GitHub

**When to use**: Automatically runs on every push/PR and weekly.

**View results**: Security tab → Code scanning alerts

---

### 2. Dependabot (Best for: Dependency Management)
**What it does**: Automatically updates dependencies and alerts on vulnerabilities.

**Strengths**:
- Automatic PR creation
- Vulnerability database integration
- License compliance checking
- Zero configuration needed

**When to use**: Runs automatically weekly, alerts immediately on new vulnerabilities.

**View results**: Security tab → Dependabot alerts

---

### 3. TruffleHog (Best for: Secret Detection)
**What it does**: Scans git history for accidentally committed secrets (API keys, passwords, tokens).

**Strengths**:
- Scans entire git history
- High accuracy with verification
- Finds many secret types
- Fast scanning

**When to use**: Runs on every push/PR and daily.

**View results**: Workflow run logs

---

### 4. Dependency Review (Best for: PR Validation)
**What it does**: Reviews dependency changes in pull requests for vulnerabilities and license issues.

**Strengths**:
- Blocks vulnerable dependencies
- License compliance
- Comments on PRs
- Prevents issues before merge

**When to use**: Automatically runs on every PR.

**View results**: PR checks and comments

---

### 5. OpenSSF Scorecard (Best for: Security Posture)
**What it does**: Assesses overall repository security practices and provides a score.

**Strengths**:
- Comprehensive security assessment
- Industry best practices
- Actionable recommendations
- Tracks improvement over time

**When to use**: Runs weekly.

**View results**: Security tab → Scorecard results

---

### 6. .NET Security Audit (Best for: NuGet Packages)
**What it does**: Checks NuGet packages for known vulnerabilities.

**Strengths**:
- Native .NET tooling
- Transitive dependency checking
- Fast and accurate
- No external dependencies

**When to use**: Runs daily and on every push/PR.

**View results**: Workflow run logs

---

## Comparison Matrix

| Tool | Language | Speed | Accuracy | Auto-Fix | Integration |
|------|----------|-------|----------|----------|-------------|
| CodeQL | C#, JS | Medium | High | No | Excellent |
| Dependabot | All | Fast | High | Yes (PRs) | Excellent |
| TruffleHog | All | Fast | High | No | Good |
| Dependency Review | All | Fast | High | No | Excellent |
| Scorecard | N/A | Fast | Medium | No | Good |
| .NET Audit | C# | Fast | High | No | Good |

---

## Recommended Workflow

### Daily Development
1. **Before committing**: Run local checks
2. **On PR creation**: Wait for all checks to pass
3. **Review findings**: Address CodeQL and dependency issues

### Weekly Maintenance
1. **Review Dependabot PRs**: Merge safe updates
2. **Check Scorecard**: Improve security posture
3. **Review alerts**: Triage new security findings

### Monthly Review
1. **Audit dependencies**: Review all dependencies
2. **Update workflows**: Keep actions up to date
3. **Review policies**: Update security guidelines

---

## Tool Configuration

### CodeQL
```yaml
# .github/workflows/codeql.yml
queries: +security-and-quality  # Use security-focused queries
```

### Dependabot
```yaml
# .github/dependabot.yml
open-pull-requests-limit: 10  # Max concurrent PRs
schedule:
  interval: "weekly"  # Update frequency
```

### Dependency Review
```yaml
# .github/workflows/dependency-review.yml
fail-on-severity: moderate  # Minimum severity to fail
deny-licenses: GPL-2.0, GPL-3.0  # Blocked licenses
```

---

## Interpreting Results

### CodeQL Alerts
- **Critical/High**: Fix immediately
- **Medium**: Fix before next release
- **Low**: Fix when convenient
- **Note**: Review false positives

### Dependabot Alerts
- **Critical**: Update within 24 hours
- **High**: Update within 1 week
- **Medium**: Update within 1 month
- **Low**: Update in next maintenance cycle

### Scorecard Results
- **10/10**: Excellent security posture
- **7-9/10**: Good, minor improvements needed
- **4-6/10**: Fair, several improvements needed
- **0-3/10**: Poor, immediate action required

---

## Troubleshooting

### CodeQL Not Running
- Check workflow file syntax
- Verify languages are correct
- Ensure build succeeds

### Dependabot Not Creating PRs
- Check dependabot.yml syntax
- Verify package ecosystem
- Check PR limit not reached

### False Positives
- Review alert carefully
- Add suppression if needed
- Report to tool maintainers

---

## Learn More

- [CodeQL Docs](https://codeql.github.com/docs/)
- [Dependabot Docs](https://docs.github.com/en/code-security/dependabot)
- [TruffleHog Docs](https://github.com/trufflesecurity/trufflehog)
- [OpenSSF Scorecard](https://github.com/ossf/scorecard)

---

**Pro Tip**: Enable GitHub Security Advisories to receive private vulnerability reports from security researchers!
