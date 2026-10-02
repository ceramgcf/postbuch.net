# Security Policy

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting instead:

1. Open the repository's **Security** tab
2. Click **Report a vulnerability**
3. Fill in the advisory form and submit

The report is only visible to you and the maintainer, and all further
communication happens inside the private advisory – no email required.
You will normally get a first response within a few days.

## Supported Versions

Only the **latest stable release** receives security fixes. If you opted in
to pre-releases, the latest pre-release is supported as well; fixes ship as a
new version, never by replacing an existing release.

Please update before reporting: use the update card under **Einstellungen →
Allgemein** or run `./deploy-pages/install.sh --update` in the installation
directory. Releases come from
[GitHub Releases](https://github.com/ceramgcf/postbuch.net/releases) and are
signed; the installer refuses archives whose signature or checksum does not
match.

## Scope

postbuch.net is a self-hosted application. Reports about the following
are in scope:

- Authentication/session handling, role model (`admin` / `vollzugriff` / `lesezugriff`)
- Injection issues (SQL, command, path traversal) in the API or pipeline
- Leakage of OneDrive tokens, API keys or other secrets
- The scanner/cleaner webhook endpoints

Out of scope: vulnerabilities in third-party services (OneDrive, Discord,
DuckDNS, LLM providers) and issues that require an already-compromised host.

# Installation und Release-Prüfung

Die Erstinstallation erfolgt bewusst direkt:

```bash
curl -fsSL https://github.com/ceramgcf/postbuch.net/releases/latest/download/install.sh | bash
```

Der Installer prüft anschließend die signierte Release-Beschreibung und den
Hash des Release-Archivs, bevor er dieses verwendet. Diese Prüfung schützt den
ausgelieferten Release-Inhalt; die Entscheidung, einen per Pipe geladenen
Installer zu starten, trifft die Person am Terminal.
