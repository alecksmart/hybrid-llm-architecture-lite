# Security Policy

## Supported Versions
This project is provided as a reference/template. Security fixes may not be backported.
If you use it in production, pin versions and maintain your own patch process.

## Reporting a Vulnerability
If you discover a security issue, please do not open a public GitHub issue.

Suggested process:
1. Create a private report with:
   - a clear description of the issue
   - minimal reproduction steps
   - impact assessment (data exposure, auth bypass, etc.)
2. Send it to the repository maintainer via a private channel (email or private message).
3. Wait for acknowledgement before disclosing publicly.

## Scope notes
Common risk areas for this project:
- leaked tokens/API keys (proxy key, Open WebUI key, cloud credentials)
- unintended cloud routing of sensitive inputs
- over-permissive IAM or logging/telemetry
- file/image handling pathways (upload → fetch → forward)

## Hardening checklist (high level)
- Do not commit secrets. Use environment variables and secret stores.
- Minimize IAM permissions to invoke-only.
- Disable web search features unless explicitly required.
- Set explicit quotas/limits for cloud calls.
- Review logs for accidental payload retention.
