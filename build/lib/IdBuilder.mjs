import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';
import { getProperty, setProperty } from '../helpers.mjs';

const SOURCE_DIR = path.resolve(
	fileURLToPath(new URL('.', import.meta.url)),
	'../../pack-sources',
);

export default class IdBuilder {
	constructor() {
		this.ids = {
			Actor: new Set(),
			Item: new Set(),
			Journal: new Set(),
			RollTable: new Set(),
		};

		this.mappedIds = 0;
		this.generatedIds = 0;
		this.updatedReferences = 0;

		this.idMigrations = new Map();
	}

	get summary() {
		let msg = `Generated ${this.generatedIds} ids and fixed ${this.mappedIds} ids.`;
		if (this.updatedReferences > 0) {
			msg += ` Updated ${this.updatedReferences} UUID references.`;
		}
		return msg;
	}

	loadIds() {
		const dataPath = SOURCE_DIR;
		const dirPaths = fs.readdirSync(dataPath).map((p) => path.resolve(dataPath, p));

		const savedIdsPath = path.resolve(dataPath, 'ids.json');
		const savedIdData = JSON.parse(fs.readFileSync(savedIdsPath, { encoding: 'utf-8' }).toString());

		dirPaths.forEach((folder) => {
			if (folder.endsWith('.json')) return;
			if (!fs.statSync(folder).isDirectory()) return;

			const fileNames = globSync(`${folder}/**/*.json`);

			for (const file of fileNames) {
				let jsonData;

				try {
					jsonData = JSON.parse(fs.readFileSync(file, { encoding: 'utf-8' }).toString());
				} catch (err) {
					console.error(err);
					console.warn(`[ERROR] - ${file} failed to parse.`);
					continue;
				}

				if (!jsonData) continue;

				const docType = IdBuilder.documentType(jsonData);
				if (!docType) {
					console.warn(`[ERROR] - ${file} doesn't have a valid type.`);
					continue;
				}

				const originalId = jsonData._id;
				const idPath = IdBuilder.getIdKey(file);
				const existingId = getProperty(savedIdData, idPath);

				if (!originalId || existingId !== originalId) {
					let id;

					if (existingId) {
						id = existingId;
						this.mappedIds += 1;

						if (originalId && originalId !== existingId) {
							this.idMigrations.set(originalId, existingId);
						}
					} else {
						id = this.generateId(docType);
						this.generatedIds += 1;

						if (originalId) {
							this.idMigrations.set(originalId, id);
						}

						setProperty(savedIdData, idPath, id);
					}

					jsonData._id = id;
					fs.writeFileSync(file, JSON.stringify(jsonData, null, '\t'), {
						encoding: 'utf-8',
					});

					this.ids[docType].add(id);
				} else {
					this.ids[docType].add(originalId);
				}
			}
		});

		if (this.generatedIds) {
			const replacer = (_, value) =>
				value instanceof Object && !Array.isArray(value)
					? Object.keys(value)
							.sort()
							.reduce((sorted, key) => {
								sorted[key] = value[key];
								return sorted;
							}, {})
					: value;

			fs.writeFileSync(savedIdsPath, JSON.stringify(savedIdData, replacer, '\t'), {
				encoding: 'utf-8',
			});
		}

		if (this.idMigrations.size > 0) {
			console.log(`[INFO] - Migrating ${this.idMigrations.size} ID references...`);
			this.updateUuidReferences(dataPath);
		}
	}

	generateId(type) {
		let id = IdBuilder.randomId();
		while (this.ids[type]?.has(id)) id = IdBuilder.randomId();
		return id;
	}

	updateUuidReferences(dataPath) {
		const fileNames = globSync(`${dataPath}/**/*.json`);

		// UUID references can target either the system's packs or this module's packs.
		const uuidPattern =
			/Compendium\.(?:nimble|blue-codex-package)\.[\w-]+\.(Item|Actor|JournalEntry|RollTable)\.([A-Za-z0-9]{16})/g;

		for (const file of fileNames) {
			if (file.endsWith('ids.json')) continue;

			let content;
			try {
				content = fs.readFileSync(file, { encoding: 'utf-8' });
			} catch {
				continue;
			}

			let modified = false;
			const updatedContent = content.replace(uuidPattern, (match, _docType, id) => {
				if (this.idMigrations.has(id)) {
					const newId = this.idMigrations.get(id);
					modified = true;
					this.updatedReferences += 1;
					return match.replace(id, newId);
				}
				return match;
			});

			if (modified) {
				fs.writeFileSync(file, updatedContent, { encoding: 'utf-8' });
				console.log(`[INFO] - Updated UUID references in ${path.basename(file)}`);
			}
		}
	}

	static documentType(doc) {
		if (IdBuilder.#isActor(doc)) return 'Actor';
		if (IdBuilder.#isItem(doc)) return 'Item';
		if (IdBuilder.#isJournal(doc)) return 'Journal';
		if (IdBuilder.#isRollTable(doc)) return 'RollTable';
		return null;
	}

	static getIdKey(absoluteFilePath) {
		let filePath = absoluteFilePath;

		if (os.platform() === 'linux' || os.platform() === 'darwin') {
			filePath = path.relative(SOURCE_DIR, absoluteFilePath);
		}

		const parts = filePath.split(path.sep);
		if (os.platform() === 'win32') parts.shift();
		parts.push(parts.pop().replace('.json', ''));

		return parts.join('.');
	}

	static randomId(length = 16) {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		const cutoff = 0x100000000 - (0x100000000 % chars.length);
		const random = new Uint32Array(length);
		do {
			crypto.getRandomValues(random);
		} while (random.some((x) => x >= cutoff));
		let id = '';
		for (let i = 0; i < length; i += 1) id += chars[random[i] % chars.length];
		return id;
	}

	static #isActor(doc) {
		return 'system' in doc && doc.system && 'items' in doc && Array.isArray(doc.items);
	}

	static #isItem(doc) {
		return 'system' in doc && doc.system && !IdBuilder.#isActor(doc) && !('text' in doc);
	}

	static #isJournal(doc) {
		return 'pages' in doc;
	}

	static #isRollTable(doc) {
		return 'results' in doc;
	}
}
