# Report issues

Show how to reproduce the problem so the JE project can investigate it. Your report helps identify whether the failure is in JE, Jellyfin, your client, or an integration.

## Before Reporting

Check for an existing report and rule out common setup problems before opening an issue.

1. Search [existing issues](https://github.com/n00bcodr/Jellyfin-Enhanced/issues) for the same symptom. Add useful reproduction details to a matching report rather than opening a duplicate.
2. Check your running JE version and Jellyfin build target using [installation troubleshooting](../installation/troubleshooting.md). If you can update, retest with the current matching release.
3. Check [Compatibility](../getting-started/compatibility.md) and the relevant feature/settings guide. For installation, use [Troubleshooting installation](../installation/troubleshooting.md); for integrations, use [Seerr settings](../seerr/seerr-settings.md) or [*arr troubleshooting](../arr/troubleshooting-support.md).
4. Test with a clean browser profile or temporarily disable browser extensions/custom CSS. Record whether the problem remains.
5. If you normally access Jellyfin remotely, compare your remote URL with direct local access and record the result.

If you need help narrowing down a problem before it is reproducible, use [Discussions or Discord](support.md).

## Gather evidence

Collect the logs and images that show the failure.

1. Follow [How do I gather logs for bug reports?](faq.md#how-do-i-gather-logs-for-bug-reports) for console, **Network**, and server logs.
2. Note the reproduction time. Include the failed request, its status, and the surrounding error lines.
3. Attach screenshots or a short recording when the behavior is visual.

!!! warning

    Redact credentials and personal information before sharing. Check request URLs, headers, response bodies, logs, and screenshots for API keys, tokens, cookies, passwords, private addresses, and usernames. Review a network export before uploading it.

??? note "Details"

    Do not turn on **Dev Mode** just to submit a report. Use it only when checking which individual script fails to load, as described in [Scripts Not Loading](../installation/troubleshooting.md#scripts-not-loading).

## Create Issue

Use the bug report template to keep the information in one place.

1. Open the [bug report template](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/new?template=bug.md). If it does not open directly, use the [issue chooser](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/new/choose) and select the bug template.
2. Give the issue a title that identifies the affected feature and failure.
3. Complete the template with the information below.

Include:

- A clear description, numbered reproduction steps, and expected versus actual behavior.
- Exact Jellyfin server and JE versions, including the JE build target if a mismatch is possible.
- Installation method, such as a container image, Linux package, or Windows service.
- Device, operating system, exact app/browser name and version, and playback mode when relevant.
- Theme and relevant custom CSS.
- External access method when the issue occurs remotely, such as a reverse proxy, tunnel, or VPN; say whether local access also fails.
- Relevant companion and upstream service versions. See the details below for what to include.
- Relevant administrator switches and personal overrides, redacted logs, failed request details, and screenshots.

State how often it happens and whether other accounts, devices, or library items reproduce it. Keep one distinct problem per report unless the symptoms clearly share the same reproduction.

??? note "Details"

    State whether FileTransformation is installed, as the template asks. Include versions of other relevant companions, such as Plugin Pages or Custom Tabs, and upstream service versions when relevant.

## After submitting

Reply with requested details and test results in the same issue. If you find a workaround or a version where it stops happening, include that result so others can reproduce the comparison.

For proposed functionality rather than a bug, use [Feature Requests](feature-requests.md).
