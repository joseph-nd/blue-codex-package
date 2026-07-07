/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import IdBuilder from './lib/IdBuilder.mjs';
import Pack from './lib/Pack.mjs';

console.log('[INFO] - Starting build process.');

const dirName = fileURLToPath(new URL('.', import.meta.url));
const dataPath = path.resolve(dirName, '../pack-sources');

if (!fs.existsSync(dataPath)) {
	console.warn(`[WARN] - Source directory ${dataPath} does not exist; nothing to build.`);
	process.exit(0);
}

const dirPaths = fs
	.readdirSync(dataPath)
	.map((name) => path.resolve(dirName, dataPath, name))
	.filter((p) => fs.statSync(p).isDirectory());

console.log('[INFO] - Validating and Updating document ids.');
const idBuilder = new IdBuilder();
idBuilder.loadIds();

console.log(`[INFO] - Loading ${dirPaths.length} packs.`);
const packs = dirPaths.reduce((acc, pack) => {
	acc.push(Pack.loadJSONFiles(pack));
	return acc;
}, []);

console.log(`[INFO] - Loaded ${packs.length} packs.`);

const counts = await Promise.all(packs.map((p) => p.saveAsPack()));
const totalCount = counts.reduce((acc, curr) => acc + curr, 0);

console.log(`[INFO] - Successfully built ${counts.length} packs with a total of ${totalCount} documents.`);
console.log(`[INFO] - ${idBuilder.summary}`);
