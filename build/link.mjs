/* eslint-disable no-console */
/**
 * Dev setup: symlink this working tree into Foundry's modules directory so the module
 * you edit is the module Foundry loads. No copy step, no reinstall — edit, reload Foundry.
 *
 * Usage:
 *   pnpm dev:link              link into the local Foundry install
 *   pnpm dev:link --unlink     remove the link
 *   FOUNDRY_DATA=/path pnpm dev:link
 *
 * The data path is read from Foundry's own Config/options.json when FOUNDRY_DATA is unset.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const moduleId = JSON.parse(fs.readFileSync(path.join(ROOT, 'module.json'), 'utf-8')).id;
if (!moduleId) throw new Error('module.json is missing id');

const unlinkOnly = process.argv.includes('--unlink');

/** Locate Foundry's user data directory. */
function resolveDataPath() {
	if (process.env.FOUNDRY_DATA) return process.env.FOUNDRY_DATA;

	const candidates = [
		path.join(os.homedir(), '.local/share/FoundryVTT'),
		path.join(os.homedir(), 'Library/Application Support/FoundryVTT'),
		path.join(os.homedir(), 'AppData/Local/FoundryVTT'),
	];

	for (const candidate of candidates) {
		// Foundry records the authoritative path in its own config; prefer it over the guess.
		const options = path.join(candidate, 'Config/options.json');
		if (fs.existsSync(options)) {
			try {
				const { dataPath } = JSON.parse(fs.readFileSync(options, 'utf-8'));
				if (dataPath && fs.existsSync(path.join(dataPath, 'Data'))) return dataPath;
			} catch {
				// Unreadable config — fall through to the directory itself.
			}
		}
		if (fs.existsSync(path.join(candidate, 'Data'))) return candidate;
	}

	throw new Error(
		'Could not find the Foundry data directory. Set FOUNDRY_DATA to the folder that contains Data/, Config/ and Logs/.',
	);
}

const dataPath = resolveDataPath();
const modulesDir = path.join(dataPath, 'Data', 'modules');
if (!fs.existsSync(modulesDir)) fs.mkdirSync(modulesDir, { recursive: true });

const target = path.join(modulesDir, moduleId);
// lstat, not exists: a link pointing at a moved working tree still needs replacing.
const existing = fs.lstatSync(target, { throwIfNoEntry: false });

if (existing) {
	if (existing.isSymbolicLink()) {
		fs.unlinkSync(target);
		console.log(`[INFO] - Removed existing link ${target}`);
	} else {
		// A real directory here is an installed release. Deleting it is the caller's call, not ours.
		throw new Error(
			`${target} is a real directory (an installed copy of the module), not a link.\n` +
				'Move or delete it yourself, then re-run this script.',
		);
	}
}

if (unlinkOnly) {
	console.log(`[INFO] - ${moduleId} is no longer linked.`);
	process.exit(0);
}

fs.symlinkSync(ROOT, target, 'junction');
console.log(`[INFO] - Linked ${target}`);
console.log(`[INFO] -     -> ${ROOT}`);

if (!fs.existsSync(path.join(ROOT, 'packs'))) {
	console.log('[WARN] - No packs/ directory yet. Run "pnpm build" before starting Foundry.');
}
