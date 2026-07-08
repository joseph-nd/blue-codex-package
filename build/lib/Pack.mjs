import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';
import moduleJSON from '../../module.json' with { type: 'json' };
import LevelDatabase from './LevelDB.mjs';

const MINOR_BOON_TYPE = 'minor';
const MAJOR_BOON_TYPE = 'major';
const EPIC_BOON_TYPE = 'epic';
const LODGING_BOON_TYPE = 'lodging';

const CONFIGURED_BOON_TYPES = [MINOR_BOON_TYPE, MAJOR_BOON_TYPE, EPIC_BOON_TYPE, LODGING_BOON_TYPE];

const MODULE_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

export default class Pack {
	static #PACK_DEST = path.resolve(MODULE_ROOT, 'packs');

	static #packsMetadata = moduleJSON.packs;

	// New classes shipped by this module — sort priority for class-feature folders.
	static #CLASS_FEATURE_CLASS_SORT_ORDER = new Map([
		['hexbinder', 0],
		['artificer', 1],
	]);

	constructor(dirName, data) {
		const sourceDir = path.basename(dirName);
		const metadata = Pack.#packsMetadata.find(
			(p) => p?.flags?.sourceDir === sourceDir,
		);

		if (!metadata) throw Error(`[ERROR] - Pack source dir "${sourceDir}" isn't setup in module.json.`);

		/** @type {string} */
		this.systemId = metadata.system;
		/** @type {string} */
		this.packId = metadata.name;
		/** @type {string} */
		this.documentType = metadata.type;
		/** @type {string} */
		this.outDirName = path.basename(metadata.path);

		/** @type {string} */
		this.dirPath = dirName;
		/** @type {string} */
		this.dirName = sourceDir;
		/** @type {Map<string, any>} */
		this.data = data;
		/** @type {any[]} */
		this.folderDocuments = [];
	}

	cleanAndValidate() {
		const folderAssignments = this.#prepareFolderAssignments();

		[...this.data.entries()].map(([file, source]) => {
			this.#cleanDocument(source);

			const folderId = source?._id ? folderAssignments.get(source._id) : null;
			if (folderId) source.folder = folderId;

			fs.writeFileSync(file, JSON.stringify(source, null, '\t'), { encoding: 'utf-8' });

			return source;
		});
	}

	#prepareFolderAssignments() {
		this.folderDocuments = [];

		const folderAssignmentHandlers = [
			{
				matches: this.dirName === 'monsters' && this.documentType === 'Actor',
				prepare: () => this.#prepareMonsterFolderAssignments(),
			},
			{
				matches: this.dirName === 'boons' && this.documentType === 'Item',
				prepare: () => this.#prepareBoonFolderAssignments(),
			},
			{
				matches: this.dirName === 'subclasses',
				prepare: () => this.#prepareSubclassFolderAssignments(),
			},
			{
				matches: this.dirName === 'classFeatures',
				prepare: () => this.#prepareClassFeatureFolderAssignments(),
			},
			{
				matches: this.dirName === 'spells',
				prepare: () => this.#prepareSpellFolderAssignments(),
			},
			{
				matches: this.dirName === 'items',
				prepare: () => this.#prepareItemFolderAssignments(),
			},
			{
				matches: this.dirName === 'ancestries',
				prepare: () => this.#prepareAncestryFolderAssignments(),
			},
		];

		const matchedHandler = folderAssignmentHandlers.find((handler) => handler.matches);
		return matchedHandler ? matchedHandler.prepare() : new Map();
	}

	#prepareSubclassFolderAssignments() {
		const subclasses = [...this.data.values()].filter(
			(source) => source?.type === 'subclass' && typeof source?.system?.parentClass === 'string',
		);
		if (subclasses.length === 0) return new Map();

		const statsTemplate = this.#getFolderStatsTemplate(subclasses);
		const classIds = [
			...new Set(
				subclasses.map((source) => source.system.parentClass.trim().toLowerCase()).filter(Boolean),
			),
		].sort((a, b) => this.#toDisplayClassName(a).localeCompare(this.#toDisplayClassName(b)));

		const foldersByClass = classIds.reduce((acc, classId, index) => {
			const folder = {
				_id: this.#getStableFolderId(classId),
				_stats: { ...statsTemplate },
				color: null,
				description: '',
				flags: {},
				folder: null,
				name: this.#toDisplayClassName(classId),
				sort: index * 10,
				sorting: 'a',
				type: this.documentType,
			};

			acc.set(classId, folder);
			return acc;
		}, new Map());

		this.folderDocuments = [...foldersByClass.values()];

		return subclasses.reduce((acc, source) => {
			const classId = source.system.parentClass.trim().toLowerCase();
			const folder = foldersByClass.get(classId);
			if (folder && source._id) acc.set(source._id, folder._id);
			return acc;
		}, new Map());
	}

	#prepareMonsterFolderAssignments() {
		const monsters = [...this.data.entries()].filter(
			([, source]) => typeof source?._id === 'string',
		);
		if (monsters.length === 0) return new Map();

		const folderLabelByKey = new Map();
		const folderKeyByActorId = new Map();

		for (const [file, source] of monsters) {
			const folderKey = this.#getMonsterFolderKey(file);
			if (!folderKey) continue;

			folderKeyByActorId.set(source._id, folderKey);
			if (!folderLabelByKey.has(folderKey)) {
				folderLabelByKey.set(folderKey, this.#toDisplayMonsterFolderName(folderKey));
			}
		}

		if (folderLabelByKey.size === 0) return new Map();

		const statsTemplate = this.#getFolderStatsTemplate(monsters.map(([, source]) => source));
		const foldersByKey = [...folderLabelByKey.entries()]
			.sort((a, b) => a[1].localeCompare(b[1]))
			.reduce((acc, [folderKey, folderName], index) => {
				const folder = {
					_id: this.#getMonsterFolderId(folderKey),
					_stats: { ...statsTemplate },
					color: null,
					description: '',
					flags: {},
					folder: null,
					name: folderName,
					sort: index * 10,
					sorting: 'a',
					type: this.documentType,
				};

				acc.set(folderKey, folder);
				return acc;
			}, new Map());

		this.folderDocuments = [...foldersByKey.values()];

		return [...folderKeyByActorId.entries()].reduce((acc, [actorId, folderKey]) => {
			const folder = foldersByKey.get(folderKey);
			if (folder) acc.set(actorId, folder._id);
			return acc;
		}, new Map());
	}

	#prepareBoonFolderAssignments() {
		const boons = [...this.data.values()].filter(
			(source) => typeof source?._id === 'string' && typeof source?.system?.boonType === 'string',
		);
		if (boons.length === 0) return new Map();

		const statsTemplate = this.#getFolderStatsTemplate(boons);
		const boonTypes = [
			...new Set(
				boons.map((source) => source.system.boonType.trim().toLowerCase()).filter(Boolean),
			),
		].sort((a, b) => {
			const aIndex = CONFIGURED_BOON_TYPES.indexOf(a);
			const bIndex = CONFIGURED_BOON_TYPES.indexOf(b);
			if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
			if (aIndex !== -1) return -1;
			if (bIndex !== -1) return 1;
			return this.#toDisplayBoonFolderName(a).localeCompare(this.#toDisplayBoonFolderName(b));
		});

		const foldersByType = boonTypes.reduce((acc, boonType, index) => {
			const folder = {
				_id: this.#getBoonFolderId(boonType),
				_stats: { ...statsTemplate },
				color: null,
				description: '',
				flags: {},
				folder: null,
				name: this.#toDisplayBoonFolderName(boonType),
				sort: index * 10,
				sorting: 'a',
				type: this.documentType,
			};

			acc.set(boonType, folder);
			return acc;
		}, new Map());

		this.folderDocuments = [...foldersByType.values()];

		return boons.reduce((acc, source) => {
			const boonType = source.system.boonType.trim().toLowerCase();
			const folder = foldersByType.get(boonType);
			if (folder) acc.set(source._id, folder._id);
			return acc;
		}, new Map());
	}

	// Blue's Codex spell organisation: one folder per school, nested under
	// its Book. Utility spells (school "utility") and Secret Spells (any
	// school, `secretSpell` property selected) get top-level folders of
	// their own. Schools outside the map fall back to a flat folder.
	static #SPELL_BOOKS = [
		{
			slug: 'elements',
			label: 'Book of Elements',
			schools: ['fire', 'ice', 'earth', 'lightning', 'water', 'wind'],
		},
		{
			slug: 'ether',
			label: 'Book of Ether',
			schools: ['illusion', 'domination', 'inspiration'],
		},
		{
			slug: 'radiance',
			label: 'Book of Radiance',
			schools: ['radiant', 'protection', 'divination', 'nature'],
		},
		{
			slug: 'ruin',
			label: 'Book of Ruin',
			schools: ['shadow', 'death', 'blood', 'curse'],
		},
	];

	#prepareSpellFolderAssignments() {
		const spells = [...this.data.values()].filter(
			(source) =>
				typeof source?._id === 'string' &&
				typeof source?.system?.school === 'string' &&
				source.system.school.trim().length > 0,
		);
		if (spells.length === 0) return new Map();

		const isSecret = (source) =>
			Array.isArray(source.system.properties?.selected) &&
			source.system.properties.selected.includes('secretSpell');
		const schoolOf = (source) => source.system.school.trim().toLowerCase();

		const usedSchools = new Set();
		let hasUtility = false;
		let hasSecret = false;
		for (const source of spells) {
			if (isSecret(source)) {
				hasSecret = true;
				continue;
			}
			const school = schoolOf(source);
			if (school === 'utility') hasUtility = true;
			else usedSchools.add(school);
		}

		const statsTemplate = this.#getFolderStatsTemplate(spells);
		const folders = new Map();
		let sort = 0;
		const makeFolder = (key, _id, name, parentId = null) => {
			const folder = {
				_id,
				_stats: { ...statsTemplate },
				color: null,
				description: '',
				flags: {},
				folder: parentId,
				name,
				sort: (sort += 10),
				sorting: 'a',
				type: this.documentType,
			};
			folders.set(key, folder);
			return folder;
		};

		if (hasUtility) {
			makeFolder('utility', this.#getSpellSchoolFolderId('utility'), 'Utility Spells');
		}

		for (const book of Pack.#SPELL_BOOKS) {
			const bookSchools = book.schools.filter((school) => usedSchools.has(school));
			if (bookSchools.length === 0) continue;
			const bookFolder = makeFolder(
				`book:${book.slug}`,
				this.#getSpellBookFolderId(book.slug),
				book.label,
			);
			for (const school of bookSchools) {
				makeFolder(
					school,
					this.#getSpellSchoolFolderId(school),
					this.#toDisplaySpellSchoolName(school),
					bookFolder._id,
				);
			}
		}

		const mappedSchools = new Set(Pack.#SPELL_BOOKS.flatMap((book) => book.schools));
		const straySchools = [...usedSchools]
			.filter((school) => !mappedSchools.has(school))
			.sort((a, b) => this.#toDisplaySpellSchoolName(a).localeCompare(this.#toDisplaySpellSchoolName(b)));
		for (const school of straySchools) {
			makeFolder(school, this.#getSpellSchoolFolderId(school), this.#toDisplaySpellSchoolName(school));
		}

		if (hasSecret) {
			makeFolder('secret', this.#getSpellBookFolderId('secret'), 'Secret Spells');
		}

		this.folderDocuments = [...folders.values()];

		return spells.reduce((acc, source) => {
			const key = isSecret(source) ? 'secret' : schoolOf(source);
			const folder = folders.get(key);
			if (folder) acc.set(source._id, folder._id);
			return acc;
		}, new Map());
	}

	// Volume items live under items/<volume>/<category>/ and get one
	// compendium folder per category (named after the zine's sections).
	// Items outside a volume dir (hexbinder, artificer) keep their existing
	// folderless layout.
	static #VOLUME_ITEM_FOLDERS = new Map([
		['vol4/weapons', 'Vol IV — Weapons'],
		['vol4/armor-and-shields', 'Vol IV — Armor & Shields'],
		['vol4/accessories', 'Vol IV — Accessories'],
		['vol4/utility-and-exploration', 'Vol IV — Utility & Exploration'],
		['vol4/consumables-and-wands', 'Vol IV — Consumables & Wands'],
		['vol4/dverung-runes', 'Vol IV — Dverung Runes'],
		['vol4/mystic-michaels', "Vol IV — Mystic Michael's Machinations"],
		['vol1/starting-kits', 'Vol I — Variant Starting Equipment'],
		['vol1/gear', 'Vol I — Adventuring Gear'],
	]);

	#prepareItemFolderAssignments() {
		return this.#prepareDirectoryFolderAssignments(
			Pack.#VOLUME_ITEM_FOLDERS,
			(parts) => (parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null),
		);
	}

	// Vol I ancestries: exotic/ holds the new ancestries, variants/<group>/
	// holds the sub-ancestry variants (one folder per zine heading).
	static #ANCESTRY_FOLDERS = new Map([
		['exotic', 'Vol I — Exotic Ancestries'],
		['variants/human-adaptations', 'Variants — Human Adaptations'],
		['variants/dwarven-hearths', 'Variants — Dwarven Hearths'],
		['variants/elven-clades', 'Variants — Elven Clades'],
		['variants/halfling-traditions', 'Variants — Halfling Traditions'],
		['variants/gnomish-branches', 'Variants — Gnomish Branches'],
		['variants/dragonborn-horns', 'Variants — Dragonborn Horns'],
		['variants/fiendkin-curses', 'Variants — Fiendkin Curses'],
		['variants/goblinoid-tribes', 'Variants — Goblinoid Tribes'],
		['variants/kobold-clans', 'Variants — Kobold Clans'],
		['variants/orcish-kin', 'Variants — Orcish Kin'],
		['variants/oozeling-construct-permutations', 'Variants — Oozeling/Construct Permutations'],
	]);

	#prepareAncestryFolderAssignments() {
		return this.#prepareDirectoryFolderAssignments(Pack.#ANCESTRY_FOLDERS, (parts) => {
			if (parts[0] === 'exotic') return 'exotic';
			if (parts[0] === 'variants' && parts.length >= 3) return `variants/${parts[1]}`;
			return null;
		});
	}

	// Shared engine: map each source file's directory to a compendium folder
	// via `categoryFromParts` (relative path segments -> key into folderNames).
	#prepareDirectoryFolderAssignments(folderNames, categoryFromParts) {
		const items = [...this.data.entries()].filter(([, source]) => typeof source?._id === 'string');
		if (items.length === 0) return new Map();

		const usedCategories = new Map();
		const categoryByItemId = new Map();

		for (const [file, source] of items) {
			const relativePath = path.relative(this.dirPath, file);
			const parts = relativePath.split(path.sep).filter(Boolean);
			const category = categoryFromParts(parts);
			if (!category) continue;

			const folderName = folderNames.get(category);
			if (!folderName) continue;

			categoryByItemId.set(source._id, category);
			if (!usedCategories.has(category)) usedCategories.set(category, folderName);
		}

		if (usedCategories.size === 0) return new Map();

		const statsTemplate = this.#getFolderStatsTemplate(items.map(([, source]) => source));
		const categoryOrder = [...folderNames.keys()];
		const foldersByCategory = [...usedCategories.entries()]
			.sort((a, b) => categoryOrder.indexOf(a[0]) - categoryOrder.indexOf(b[0]))
			.reduce((acc, [category, folderName], index) => {
				acc.set(category, {
					// vol4/<cat> hashes to the same id as the previous
					// `<packId>-vol4-folder-<cat>` scheme, keeping published
					// folder ids stable.
					_id: Pack.#folderIdForDocument(
						(([head, ...rest]) =>
							[this.packId, head, 'folder', ...rest].join('-'))(category.split('/')),
					),
					_stats: { ...statsTemplate },
					color: null,
					description: '',
					flags: {},
					folder: null,
					name: folderName,
					sort: index * 10,
					sorting: 'a',
					type: this.documentType,
				});
				return acc;
			}, new Map());

		this.folderDocuments = [...foldersByCategory.values()];

		return [...categoryByItemId.entries()].reduce((acc, [itemId, category]) => {
			const folder = foldersByCategory.get(category);
			if (folder) acc.set(itemId, folder._id);
			return acc;
		}, new Map());
	}

	#prepareClassFeatureFolderAssignments() {
		const features = [...this.data.entries()].filter(
			([, source]) => typeof source?._id === 'string',
		);
		if (features.length === 0) return new Map();

		const statsTemplate = this.#getFolderStatsTemplate(features.map(([, source]) => source));
		const classFolderData = new Map();

		for (const [file, source] of features) {
			const classId = this.#getClassId(file, source);
			if (!classId) continue;

			const className = this.#toDisplayClassName(classId);
			let classData = classFolderData.get(classId);
			if (!classData) {
				classData = {
					name: className,
					progressionName: `${className} Progression`,
					subclasses: new Map(),
					// subclassId -> Map(poolGroup -> poolName): the choose/gain pools
					// nested under each subclass folder, kept distinct from the fixed
					// level-3/7/11/15 features.
					subclassPools: new Map(),
				};
				classFolderData.set(classId, classData);
			}

			const subclassId = this.#getSubclassId(file, source);
			if (!subclassId) continue;

			const subclassName = this.#getSubclassFolderName(file, source, subclassId);
			if (!classData.subclasses.has(subclassId)) classData.subclasses.set(subclassId, subclassName);

			const pool = Pack.#getPoolInfo(source);
			if (pool) {
				if (!classData.subclassPools.has(subclassId)) {
					classData.subclassPools.set(subclassId, new Map());
				}
				const pools = classData.subclassPools.get(subclassId);
				if (!pools.has(pool.group)) pools.set(pool.group, pool.name);
			}
		}

		const folders = [];
		const classFolderLookup = new Map();
		const sortedClasses = [...classFolderData.entries()].sort(
			([aClassId, aData], [bClassId, bData]) => {
				const aOrder =
					Pack.#CLASS_FEATURE_CLASS_SORT_ORDER.get(aClassId) ?? Number.MAX_SAFE_INTEGER;
				const bOrder =
					Pack.#CLASS_FEATURE_CLASS_SORT_ORDER.get(bClassId) ?? Number.MAX_SAFE_INTEGER;
				if (aOrder !== bOrder) return aOrder - bOrder;

				return aData.name.localeCompare(bData.name, undefined, { sensitivity: 'base' });
			},
		);

		sortedClasses.forEach(([classId, classData], classIndex) => {
			const classFolderId = Pack.#folderIdForClassId(classId);
			const progressionFolderId = Pack.#folderIdForProgressionId(classId);

			folders.push({
				_id: classFolderId,
				_stats: { ...statsTemplate },
				color: null,
				description: '',
				flags: {},
				folder: null,
				name: classData.name,
				sort: classIndex * 10,
				sorting: 'm',
				type: this.documentType,
			});

			folders.push({
				_id: progressionFolderId,
				_stats: { ...statsTemplate },
				color: null,
				description: '',
				flags: {},
				folder: classFolderId,
				name: classData.progressionName,
				sort: 0,
				sorting: 'm',
				type: this.documentType,
			});

			const subclassFolderLookup = new Map();
			// `${subclassId}:${poolGroup}` -> nested pool folder id.
			const poolFolderLookup = new Map();
			const sortedSubclasses = [...classData.subclasses.entries()].sort(([, aName], [, bName]) =>
				aName.localeCompare(bName, undefined, { sensitivity: 'base' }),
			);

			sortedSubclasses.forEach(([subclassId, subclassName], subclassIndex) => {
				const subclassFolderId = Pack.#folderIdForSubclassId(classId, subclassId);
				subclassFolderLookup.set(subclassId, subclassFolderId);

				folders.push({
					_id: subclassFolderId,
					_stats: { ...statsTemplate },
					color: null,
					description: '',
					flags: {},
					folder: classFolderId,
					name: subclassName,
					sort: (subclassIndex + 1) * 10,
					sorting: 'm',
					type: this.documentType,
				});

				// Nested "choose/gain pool" folders under the subclass folder,
				// one per pool (Savage Arsenal, Sacred Decrees, ...), so the
				// selectable pool is visually separate from the fixed features.
				const pools = classData.subclassPools.get(subclassId);
				if (pools) {
					[...pools.entries()]
						.sort(([, aName], [, bName]) =>
							aName.localeCompare(bName, undefined, { sensitivity: 'base' }),
						)
						.forEach(([poolGroup, poolName], poolIndex) => {
							const poolFolderId = Pack.#folderIdForPool(classId, subclassId, poolGroup);
							poolFolderLookup.set(`${subclassId}:${poolGroup}`, poolFolderId);

							folders.push({
								_id: poolFolderId,
								_stats: { ...statsTemplate },
								color: null,
								description: '',
								flags: {},
								folder: subclassFolderId,
								name: poolName,
								sort: (poolIndex + 1) * 10,
								sorting: 'm',
								type: this.documentType,
							});
						});
				}
			});

			classFolderLookup.set(classId, {
				classFolderId,
				progressionFolderId,
				subclassFolderLookup,
				poolFolderLookup,
			});
		});

		this.folderDocuments = folders;

		const folderAssignments = new Map();
		for (const [file, source] of features) {
			const classId = this.#getClassId(file, source);
			if (!classId || !source._id) continue;

			const classFolders = classFolderLookup.get(classId);
			if (!classFolders) continue;

			const subclassId = this.#getSubclassId(file, source);

			// Pool options land in their nested pool folder under the subclass.
			const pool = Pack.#getPoolInfo(source);
			if (pool && subclassId) {
				const poolFolderId = classFolders.poolFolderLookup?.get(`${subclassId}:${pool.group}`);
				if (poolFolderId) {
					folderAssignments.set(source._id, poolFolderId);
					continue;
				}
			}

			if (subclassId && classFolders.subclassFolderLookup.has(subclassId)) {
				folderAssignments.set(source._id, classFolders.subclassFolderLookup.get(subclassId));
				continue;
			}

			folderAssignments.set(
				source._id,
				classFolders.progressionFolderId ?? classFolders.classFolderId,
			);
		}

		return folderAssignments;
	}

	#getFolderStatsTemplate(sources) {
		const sourceStats = sources.find((source) => source?._stats)?._stats;
		const now = Date.now();

		return {
			coreVersion:
				sourceStats?.coreVersion ??
				String(moduleJSON.compatibility.verified ?? moduleJSON.compatibility.minimum),
			systemId: sourceStats?.systemId ?? 'nimble',
			systemVersion:
				sourceStats?.systemVersion ??
				moduleJSON.relationships?.systems?.[0]?.compatibility?.minimum ??
				'0.8.4',
			createdTime: sourceStats?.createdTime ?? now,
			modifiedTime: sourceStats?.modifiedTime ?? now,
			lastModifiedBy: sourceStats?.lastModifiedBy ?? null,
		};
	}

	#toDisplayClassName(classId) {
		if (classId === 'the-cheat') return 'The Cheat';

		return classId
			.replace(/[-_]+/g, ' ')
			.split(' ')
			.filter(Boolean)
			.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
			.join(' ');
	}

	#getStableFolderId(classId) {
		return crypto
			.createHash('sha1')
			.update(`blue-codex-subclasses-folder:${classId}`)
			.digest('hex')
			.slice(0, 16);
	}

	#getMonsterFolderKey(filePath) {
		const relativePath = path.relative(this.dirPath, filePath);
		const directory = path.dirname(relativePath);
		if (!directory || directory === '.') return null;

		const segments = directory.split(path.sep).filter(Boolean);
		if (!segments.length) return null;

		if (segments[0] === 'core' || segments[0] === 'blue-codex') return segments[1] ?? null;
		return segments[0];
	}

	#toDisplayMonsterFolderName(folderKey) {
		return folderKey
			.split(/[-_]+/g)
			.filter(Boolean)
			.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
			.join(' ');
	}

	#getMonsterFolderId(folderKey) {
		return crypto
			.createHash('sha1')
			.update(`${this.packId}-folder:${folderKey}`)
			.digest('hex')
			.slice(0, 16);
	}

	#toDisplayBoonFolderName(boonType) {
		switch (boonType) {
			case MINOR_BOON_TYPE:
				return 'Minor Boons';
			case MAJOR_BOON_TYPE:
				return 'Major Boons';
			case EPIC_BOON_TYPE:
				return 'Epic Boons';
			default:
				return `${boonType
					.replace(/[-_]+/g, ' ')
					.split(' ')
					.filter(Boolean)
					.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
					.join(' ')} Boons`;
		}
	}

	#getBoonFolderId(boonType) {
		return crypto
			.createHash('sha1')
			.update(`${this.packId}-boon-folder:${boonType}`)
			.digest('hex')
			.slice(0, 16);
	}

	#toDisplaySpellSchoolName(school) {
		return school
			.split(/[-_]+/g)
			.filter(Boolean)
			.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
			.join(' ');
	}

	#getSpellSchoolFolderId(school) {
		return crypto
			.createHash('sha1')
			.update(`${this.packId}-spell-school-folder:${school}`)
			.digest('hex')
			.slice(0, 16);
	}

	#getSpellBookFolderId(bookSlug) {
		return crypto
			.createHash('sha1')
			.update(`${this.packId}-spell-book-folder:${bookSlug}`)
			.digest('hex')
			.slice(0, 16);
	}

	#cleanDocument(source) {
		if (!source.flags) source.flags = {};
		delete source.flags?.exportSource;
		delete source.flags?.importSource;

		Object.entries(source.flags).forEach(([flagId, flag]) => {
			if (!['core', 'nimble', 'blue-codex-package'].includes(flagId)) delete source.flags[flagId];

			if (flag && Object.keys(flag).length === 0) delete source.flags[flagId];
		});

		source.folder = null;

		if (source.ownership) delete source.ownership;

		if (Array.isArray(source?.effects)) {
			for (const e of source.effects) this.#cleanDocument(e);
		}
		if (Array.isArray(source?.items)) {
			for (const i of source.items) this.#cleanDocument(i);
		}
	}

	async saveAsPack() {
		if (!fs.lstatSync(Pack.#PACK_DEST, { throwIfNoEntry: false })?.isDirectory()) {
			fs.mkdirSync(Pack.#PACK_DEST, { recursive: true });
		}

		const outDir = path.join(Pack.#PACK_DEST, this.outDirName);
		if (fs.lstatSync(outDir, { throwIfNoEntry: false })?.isDirectory()) {
			fs.rmSync(outDir, { recursive: true });
		}

		this.cleanAndValidate();

		const db = new LevelDatabase(outDir, { packName: this.packId });
		await db.createPack([...this.data.values()], { folders: this.folderDocuments });
		const count = this.data.size;

		console.log(`[INFO] - Pack "${this.packId}" with ${count} documents built successfully.`);

		return count;
	}

	static loadJSONFiles(dirPath) {
		const filenames = globSync(`${dirPath}/**/*.json`);
		const files = new Map();

		for (const file of filenames) {
			let jsonData;

			try {
				jsonData = JSON.parse(fs.readFileSync(file, { encoding: 'utf-8' }).toString());
			} catch (err) {
				console.error(err);
				console.warn(`[ERROR] - ${file} failed to parse.`);
				continue;
			}

			if (!jsonData) continue;

			files.set(file, jsonData);
		}

		return new Pack(dirPath, files);
	}

	#getClassId(filePath, source) {
		const relativePath = path.relative(this.dirPath, filePath);
		const pathParts = relativePath.split(path.sep).filter(Boolean);
		// Layout under classFeatures/: <class>/<group>/<feature>.json
		const pathClass = pathParts.length >= 2 ? Pack.#normalizeClassId(pathParts[0]) : null;
		if (pathClass) return pathClass;

		return Pack.#normalizeClassId(source?.system?.class);
	}

	#getSubclassId(filePath, source) {
		const sourceSubclass = Pack.#normalizeSubclassId(source?.system?.subclass);
		if (sourceSubclass) return sourceSubclass;

		const relativePath = path.relative(this.dirPath, filePath);
		const pathParts = relativePath.split(path.sep).filter(Boolean);
		const subclassMarkerIndex = pathParts.findIndex((part) => part.endsWith('-subclasses'));
		const pathSubclass = subclassMarkerIndex >= 0 ? pathParts[subclassMarkerIndex + 1] : null;

		return Pack.#normalizeSubclassId(pathSubclass);
	}

	#getSubclassFolderName(filePath, source, subclassId) {
		if (typeof source?.system?.subclass === 'string') {
			const subclassName = source.system.subclass.trim();
			if (subclassName) return subclassName;
		}

		const relativePath = path.relative(this.dirPath, filePath);
		const pathParts = relativePath.split(path.sep).filter(Boolean);
		const subclassMarkerIndex = pathParts.findIndex((part) => part.endsWith('-subclasses'));
		const pathSubclass = subclassMarkerIndex >= 0 ? pathParts[subclassMarkerIndex + 1] : null;
		if (pathSubclass) {
			const normalizedPathSubclass = Pack.#normalizeClassId(pathSubclass);
			if (normalizedPathSubclass) return this.#toDisplayClassName(normalizedPathSubclass);
		}

		return this.#toDisplayClassName(subclassId);
	}

	static #normalizeClassId(classId) {
		if (typeof classId !== 'string') return null;
		const normalized = classId.trim().toLowerCase().replaceAll('_', '-').replace(/\s+/g, '-');
		return normalized || null;
	}

	static #normalizeSubclassId(subclassId) {
		if (typeof subclassId !== 'string') return null;
		const normalized = subclassId
			.trim()
			.toLowerCase()
			.replace(/[’']/g, '')
			.replaceAll('&', 'and')
			.replaceAll('_', '-')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');

		return normalized || null;
	}

	static #folderIdForDocument(documentId) {
		return crypto.createHash('sha256').update(documentId).digest('hex').slice(0, 16);
	}

	static #folderIdForClassId(classId) {
		return Pack.#folderIdForDocument(`blue-codex-class-features-${classId}`);
	}

	static #folderIdForSubclassId(classId, subclassId) {
		return Pack.#folderIdForDocument(`blue-codex-class-features-${classId}-${subclassId}`);
	}

	static #folderIdForProgressionId(classId) {
		return Pack.#folderIdForDocument(`blue-codex-class-features-${classId}-progression`);
	}

	static #folderIdForPool(classId, subclassId, poolGroup) {
		return Pack.#folderIdForDocument(
			`blue-codex-class-features-${classId}-${subclassId}-pool-${poolGroup}`,
		);
	}

	// Foldering metadata stamped by the content generator, driving the nested
	// folder a feature lands in under its subclass. Either:
	//   flags['blue-codex-package'].pool   = { subclass, name, group, … } (choose pools), or
	//   flags['blue-codex-package'].folder = { name, group }              (e.g. Zephyr forms).
	static #getPoolInfo(source) {
		const flags = source?.flags?.['blue-codex-package'];
		const info = flags?.pool ?? flags?.folder;
		if (!info || typeof info !== 'object') return null;
		const group = typeof info.group === 'string' ? info.group : null;
		if (!group) return null;
		const name = typeof info.name === 'string' && info.name.trim() ? info.name.trim() : group;
		return { group, name };
	}
}
