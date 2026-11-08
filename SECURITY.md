# Security

Tacit reads private data (your Claude Code history) and can write configuration files, so it is built to be safe by
default:

- The server listens on `127.0.0.1` only and rejects requests whose `Host` header is not localhost.
- Requests that change anything need a random token created at launch, and cross-origin requests are refused.
- A strict Content-Security-Policy applies; the UI loads nothing from the network.
- Secrets in prompts are redacted before they are cached, displayed or exported.
- Files are written only inside folders from your history or the Claude config folder, after confirmation, with backups.
- API keys entered in Settings are held in memory for the current run and never written to disk.

## Reporting a vulnerability

Please report security issues privately through GitHub's
[security advisory form](https://github.com/abuhuraira99/tacit/security/advisories/new) rather than a public issue.
Include steps to reproduce and the impact. You'll get a reply within a few days.
