import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);

// yt-dlp ships its own certificate list rather than reading the operating system's.
// That breaks on any machine where TLS is intercepted — antivirus suites such as
// Avast, Kaspersky and ESET re-sign every HTTPS connection with a private root that
// only the Windows trust store knows about, and corporate proxies do the same.
//
// Exporting the Windows roots to a PEM and pointing yt-dlp at it keeps certificate
// verification switched on: yt-dlp ends up trusting exactly what the system trusts,
// rather than trusting nothing.

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const EXPORT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$certs = Get-ChildItem -Path Cert:\\LocalMachine\\Root, Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue
$seen = @{}
$lines = New-Object System.Collections.Generic.List[string]
foreach ($c in $certs) {
  if ($seen.ContainsKey($c.Thumbprint)) { continue }
  $seen[$c.Thumbprint] = $true
  $lines.Add('# ' + $c.Subject)
  $lines.Add('-----BEGIN CERTIFICATE-----')
  $lines.Add([Convert]::ToBase64String($c.RawData, 'InsertLineBreaks'))
  $lines.Add('-----END CERTIFICATE-----')
}
if ($seen.Count -lt 1) { throw 'no root certificates found' }
[System.IO.File]::WriteAllText($env:SCRUB_CA_OUT, ($lines -join "\`n"), [System.Text.Encoding]::ASCII)
Write-Output $seen.Count
`;

async function isFresh(file) {
  try {
    const stat = await fs.stat(file);
    return stat.size > 1000 && Date.now() - stat.mtimeMs < MAX_AGE_MS;
  } catch {
    return false;
  }
}

// Returns a path to a PEM bundle of the system's trusted roots, or null when the
// platform already exposes them to yt-dlp (macOS and Linux do).
export async function systemCaBundle(rootDir) {
  if (process.platform !== 'win32') return null;

  const file = path.join(rootDir, 'certs', 'windows-roots.pem');
  if (await isFresh(file)) return file;

  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', EXPORT_SCRIPT],
      { env: { ...process.env, SCRUB_CA_OUT: file }, maxBuffer: 1024 * 1024 },
    );
    const count = parseInt(String(stdout).trim(), 10);
    console.log(`Exported ${count} system root certificates for yt-dlp.`);
    return file;
  } catch (err) {
    console.warn('Could not export the Windows certificate store:', err.message);
    return null;
  }
}

// Environment yt-dlp reads for its CA bundle. Its networking goes through both
// curl_cffi and Python's ssl module depending on the site, and they read different
// variables, so all three are set.
export function caEnv(bundlePath) {
  if (!bundlePath) return {};
  return {
    SSL_CERT_FILE: bundlePath,
    CURL_CA_BUNDLE: bundlePath,
    REQUESTS_CA_BUNDLE: bundlePath,
  };
}
