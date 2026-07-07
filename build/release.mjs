/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MODULE_JSON_PATH = path.join(ROOT, 'module.json');
const DIST_DIR = path.join(ROOT, 'dist');
const STAGING_DIR = path.join(DIST_DIR, 'blue-codex-package');

const moduleJson = JSON.parse(fs.readFileSync(MODULE_JSON_PATH, 'utf-8'));
const moduleId = moduleJson.id;
const version = process.env.RELEASE_VERSION ?? moduleJson.version;
const repository = process.env.GITHUB_REPOSITORY; // e.g. "owner/repo" set by GitHub Actions

if (!moduleId) throw new Error('module.json is missing id');
if (!version) throw new Error('No version available (set RELEASE_VERSION or module.json.version)');

console.log(`[INFO] - Releasing ${moduleId} v${version}`);

// Rewrite manifest/download URLs so they point at this release on GitHub.
const releaseManifest = { ...moduleJson, version };
if (repository) {
	releaseManifest.url = `https://github.com/${repository}`;
	releaseManifest.manifest = `https://github.com/${repository}/releases/latest/download/module.json`;
	releaseManifest.download = `https://github.com/${repository}/releases/download/v${version}/module.zip`;
}

// Clean staging.
fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(STAGING_DIR, { recursive: true });

// Stage module.json (with rewritten URLs).
fs.writeFileSync(
	path.join(STAGING_DIR, 'module.json'),
	`${JSON.stringify(releaseManifest, null, '\t')}\n`,
	'utf-8',
);

// Stage packs/ directory (LevelDB output produced by build:compendia).
const packsSrc = path.join(ROOT, 'packs');
if (!fs.existsSync(packsSrc)) {
	throw new Error(`No built packs at ${packsSrc} — run "pnpm build" before releasing.`);
}
fs.cpSync(packsSrc, path.join(STAGING_DIR, 'packs'), { recursive: true });

// Stage README + LICENSE + CHANGELOG so they ship inside the module.
for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
	const src = path.join(ROOT, file);
	if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGING_DIR, file));
}

// Stage scripts/ (esmodules referenced by module.json) and assets/ (icons).
for (const dir of ['scripts', 'assets']) {
	const src = path.join(ROOT, dir);
	if (fs.existsSync(src)) {
		fs.cpSync(src, path.join(STAGING_DIR, dir), { recursive: true });
	}
}

// Also publish the manifest at the dist root so GitHub Actions can upload it as a separate
// release asset (Foundry's "Install Module" form expects a URL pointing directly at module.json).
fs.copyFileSync(path.join(STAGING_DIR, 'module.json'), path.join(DIST_DIR, 'module.json'));

// Create the zip.
const zipPath = path.join(DIST_DIR, 'module.zip');
fs.rmSync(zipPath, { force: true });

// Use system `zip`. Bail loudly if it's missing — preferable to shipping an empty archive.
try {
	execFileSync('zip', ['-r', '-q', zipPath, 'blue-codex-package'], { cwd: DIST_DIR, stdio: 'inherit' });
} catch (err) {
	throw new Error(
		`Failed to create ${zipPath}. Ensure the "zip" CLI is installed.\n${err.message ?? err}`,
	);
}

const stat = fs.statSync(zipPath);
console.log(`[INFO] - Wrote ${zipPath} (${(stat.size / 1024).toFixed(1)} KiB)`);
console.log(`[INFO] - Wrote ${path.join(DIST_DIR, 'module.json')}`);
