/**
 * Mock compendium layer mirroring Foundry v14
 * `client/documents/collections/compendium-collection.mjs`:
 *
 *   - the constructor seeds `pack.index` from the pack's documents with only the
 *     core `compendiumIndexFields`, and records those as the indexed fields;
 *   - `getIndex({fields})` returns `this.index` untouched when every requested
 *     field is already indexed, otherwise asks the database for the WHOLE pack
 *     again and `index.set()`s every entry back (merging into existing ones) —
 *     which is exactly what resurrects entries a filter deleted;
 *   - `set()` → `indexDocument()` (re-adds a loaded document to the index);
 *     `getDocument(s)` go through the database and `set()` new documents;
 *   - `delete(id)` removes from the index AND the loaded-document cache.
 *
 * The database (`documentClass.database.get`) serves `{query, index,
 * indexFields, pack}` requests from the pack's raw JSON sources, supporting the
 * query operators the scripts use (`_id`, `field__in`, `field__ne`, `field__nin`,
 * dotted paths). Every request is recorded in `env.database.log`.
 */
import { Collection, deepClone, getProperty, setProperty } from './foundry-utils.mjs';

function project(src, fields) {
	const out = { _id: src._id };
	for (const field of fields) {
		const value = getProperty(src, field);
		if (value !== undefined) setProperty(out, field, deepClone(value));
	}
	return out;
}

function matches(src, query) {
	for (const [rawKey, wanted] of Object.entries(query ?? {})) {
		const m = /^(.*?)__(in|ne|nin)$/.exec(rawKey);
		const key = m ? m[1] : rawKey;
		const op = m ? m[2] : 'eq';
		const value = getProperty(src, key);
		if (op === 'eq' && value !== wanted) return false;
		if (op === 'ne' && value === wanted) return false;
		if (op === 'in' && !wanted.includes(value)) return false;
		if (op === 'nin' && wanted.includes(value)) return false;
	}
	return true;
}

export function createDatabase(env) {
	return {
		/** Every request: {pack, index, indexFields, query, count}. */
		log: [],
		async get(cls, { query = {}, index = false, indexFields = [], pack } = {}, _user) {
			const collection = env.game.packs.get(pack);
			if (!collection) throw new Error(`harness database: no pack ${pack}`);
			const sources = [...collection._sources.values()];
			if (index) {
				const out = sources.map((src) => project(src, indexFields));
				this.log.push({ pack, index: true, indexFields: [...indexFields], count: out.length });
				return out;
			}
			const hits = sources.filter((src) => matches(src, query));
			this.log.push({ pack, index: false, query: deepClone(query), count: hits.length });
			return hits.map((src) => new cls(deepClone(src), { pack }));
		},
	};
}

export function createCompendiumCollectionClass(env) {
	class CompendiumCollection extends Collection {
		/** Loaded-document ids this pack tried to index but could not (mirror only). */
		invalidDocumentIds = new Set();
		_source = [];
		#indexedFields;

		/**
		 * @param {object} metadata  {id, packageName, packageType, name, label, type, documents: raw sources[]}
		 */
		constructor(metadata) {
			super();
			const { documents = [], ...meta } = metadata;
			this.metadata = { packageType: 'module', system: 'nimble', ...meta };
			/** Raw persisted sources, id → source (never handed out without a clone). */
			this._sources = new Map(documents.map((d) => [d._id, d]));
			this.index = new Collection();
			this.apps = [];
			this.tree = { children: [], entries: [] };
			this.treeInitializations = 0;
			/** Calls to getIndex/getDocument(s)/indexDocument, for assertions. */
			this.calls = [];
			this.#indexedFields = new Set(this.documentClass.metadata.compendiumIndexFields);
			for (const src of this._sources.values()) {
				const entry = project(src, this.#indexedFields);
				entry.uuid = this.getUuid(entry._id);
				this.index.set(entry._id, entry);
			}
		}

		get collection() {
			return this.metadata.id;
		}
		get documentName() {
			return this.metadata.type;
		}
		get documentClass() {
			return env.CONFIG[this.documentName].documentClass;
		}
		get title() {
			return this.metadata.label;
		}
		get locked() {
			return true;
		}
		get visible() {
			return true;
		}
		get folders() {
			return new Collection();
		}
		get indexFields() {
			const coreFields = this.documentClass.metadata.compendiumIndexFields;
			const configFields = env.CONFIG[this.documentName].compendiumIndexFields || [];
			return new Set([...coreFields, ...configFields]);
		}
		get indexed() {
			return this.indexFields.isSubsetOf(this.#indexedFields);
		}
		/** Harness-only: the fields the index currently holds. */
		get indexedFields() {
			return new Set(this.#indexedFields);
		}

		get(key, options) {
			return super.get(key, options);
		}

		set(id, document) {
			this.indexDocument(document);
			return super.set(id, document);
		}

		delete(id) {
			this.index.delete(id);
			return super.delete(id);
		}

		clear() {
			for (const doc of this.values()) super.delete(doc.id);
		}

		async getIndex({ fields = [] } = {}) {
			this.calls.push({ method: 'getIndex', fields: [...fields] });
			const cls = this.documentClass;
			const indexFields = new Set([...this.indexFields, ...fields]);
			if (indexFields.isSubsetOf(this.#indexedFields)) return this.index;

			const index = await cls.database.get(
				cls,
				{ query: {}, index: true, indexFields: Array.from(indexFields), pack: this.collection },
				env.game.user,
			);
			for (const i of index) {
				const x = this.index.get(i._id);
				const indexed = x ? env.foundry.utils.mergeObject(x, i) : i;
				indexed.uuid = this.getUuid(indexed._id);
				indexed.img = env.game.compendiumArt.get(indexed.uuid)?.img ?? indexed.img;
				this.index.set(i._id, indexed);
			}
			this.#indexedFields = indexFields;
			return this.index;
		}

		async getDocument(id) {
			this.calls.push({ method: 'getDocument', id });
			if (!id) return undefined;
			const cached = this.get(id);
			if (cached instanceof env.foundry.abstract.Document) return cached;
			const documents = await this.getDocuments({ _id: id });
			return documents.length ? documents.shift() : null;
		}

		async getDocuments(query = {}) {
			this.calls.push({ method: 'getDocuments', query: deepClone(query) });
			const cls = this.documentClass;
			const documents = await cls.database.get(cls, { query, pack: this.collection }, env.game.user);
			for (const d of documents) {
				if (!this.has(d.id)) this.set(d.id, d);
			}
			return documents;
		}

		indexDocument(document) {
			this.calls.push({ method: 'indexDocument', id: document?.id });
			const data = document._source;
			const { id, uuid } = document;
			const baseIndexData = { _id: id, uuid };
			const index = [...this.#indexedFields].reduce((obj, field) => {
				env.foundry.utils.setProperty(obj, field, env.foundry.utils.getProperty(data, field));
				return obj;
			}, baseIndexData);
			index.img = data.thumb ?? data.img;
			this.index.set(id, index);
		}

		getUuid(id) {
			return `Compendium.${this.collection}.${this.documentName}.${id}`;
		}

		/** DirectoryCollectionMixin#initializeTree — counted, not built. */
		initializeTree() {
			this.treeInitializations += 1;
		}

		render() {}
	}
	return CompendiumCollection;
}
