/**
 * Mock Foundry documents: Item and Actor, close enough to Foundry v14 + Nimble
 * for the module's migration and automation code.
 *
 * Fidelity notes (see tests/README.md "Gaps" for what is NOT simulated):
 *   - `_source` is the persisted data; `name`, `img`, `system`, `flags`,
 *     `_stats`… are a *prepared copy* rebuilt by `prepareData()` after every
 *     change, so mutating `item.system` in memory does not persist (as in Foundry).
 *   - Like Nimble's `NimbleBaseItem#prepareBaseData`, the prepared
 *     `system.identifier` is ALWAYS `name.slugify({strict: true})`, whatever the
 *     source says. Index entries and `toObject()` keep the stored value.
 *   - Actor `levels` is derived from `system.classData.levels` exactly as
 *     Nimble's `_prepareLevelData` does.
 *   - Updates apply with Foundry's mergeObject semantics: dotted keys expand,
 *     objects merge, `-=key`/`==key` and ForcedDeletion/ForcedReplacement work.
 *   - Embedded CRUD fires `preCreateItem`/`createItem`, `preUpdateItem`/
 *     `updateItem`, `preDeleteItem`/`deleteItem` through the harness Hooks
 *     (a `pre*` handler returning false cancels, as in Foundry) and is recorded
 *     in `actor.calls`. Updating or deleting an id the actor does not own
 *     throws, as Foundry's strict embedded lookup does.
 *
 * The classes are created per `installFoundry()` call (a factory), so a script
 * that patches `CONFIG.Item.documentClass.prototype` in one test cannot leak
 * into the next.
 */
import {
	Collection,
	deepClone,
	expandObject,
	getProperty,
	mergeObject,
	randomID,
	slugify,
} from './foundry-utils.mjs';

export const ITEM_INDEX_FIELDS = ['_id', 'name', 'img', 'type', 'sort', 'folder'];
export const ACTOR_INDEX_FIELDS = ['_id', 'name', 'img', 'type', 'sort', 'folder'];

function stripId(changes) {
	const { _id, ...rest } = changes ?? {};
	return rest;
}

/**
 * @param {object} env  the harness env (for hooks / user / database)
 * @returns {{Document: Function, Item: Function, Actor: Function}}
 */
export function createDocumentClasses(env) {
	class Document {
		constructor(data = {}, { parent = null, pack = null } = {}) {
			this._source = deepClone(data);
			this._source._id ??= randomID();
			this.parent = parent;
			this.pack = pack;
			this.apps = {};
			this.prepareData();
		}

		static get implementation() {
			return this;
		}

		get id() {
			return this._source._id;
		}
		get _id() {
			return this._source._id;
		}
		get documentName() {
			return this.constructor.documentName;
		}
		get uuid() {
			const name = this.documentName;
			if (this.pack) return `Compendium.${this.pack}.${name}.${this.id}`;
			if (this.parent) return `${this.parent.uuid}.${name}.${this.id}`;
			return `${name}.${this.id}`;
		}
		get isEmbedded() {
			return !!this.parent;
		}
		get compendium() {
			return this.pack ? env.game.packs.get(this.pack) : undefined;
		}
		get inCompendium() {
			return !!this.pack;
		}

		prepareData() {
			const src = this._source;
			for (const key of ['name', 'img', 'type', 'sort', 'folder', 'ownership']) this[key] = deepClone(src[key]);
			this.system = deepClone(src.system ?? {});
			this.flags = deepClone(src.flags ?? {});
			this._stats = deepClone(src._stats ?? {});
			this.prepareBaseData();
			this.prepareDerivedData();
		}
		prepareBaseData() {}
		prepareDerivedData() {}

		toObject(source = true) {
			if (source) return deepClone(this._source);
			return deepClone({ ...this._source, name: this.name, img: this.img, system: this.system, flags: this.flags });
		}
		toJSON() {
			return this.toObject();
		}
		clone(data = {}, { keepId = false } = {}) {
			const src = mergeObject(this.toObject(), data, { inplace: false });
			if (!keepId) delete src._id;
			return new this.constructor(src, { parent: this.parent, pack: this.pack });
		}

		getFlag(scope, key) {
			return getProperty(this.flags?.[scope], key);
		}
		async setFlag(scope, key, value) {
			return this.update({ [`flags.${scope}.${key}`]: value });
		}
		async unsetFlag(scope, key) {
			const parts = key.split('.');
			const last = parts.pop();
			const path = ['flags', scope, ...parts, `-=${last}`].join('.');
			return this.update({ [path]: null });
		}

		/** Apply an update to `_source` with Foundry merge semantics; returns the expanded diff. */
		_applyUpdate(changes) {
			const diff = expandObject(stripId(changes));
			mergeObject(this._source, deepClone(diff), { applyOperators: true });
			this.prepareData();
			return diff;
		}

		async update(changes = {}, options = {}) {
			if (this.parent) {
				const [updated] = await this.parent.updateEmbeddedDocuments(
					this.documentName,
					[{ ...changes, _id: this.id }],
					options,
				);
				return updated;
			}
			const name = this.documentName;
			const userId = env.game.user.id;
			if (env.Hooks.call(`preUpdate${name}`, this, changes, options, userId) === false) return undefined;
			const diff = this._applyUpdate(changes);
			env.log.push({ method: 'update', document: this.uuid, changes: deepClone(diff), options });
			env.Hooks.callAll(`update${name}`, this, diff, options, userId);
			return this;
		}

		async delete(options = {}) {
			if (this.parent) {
				const [deleted] = await this.parent.deleteEmbeddedDocuments(this.documentName, [this.id], options);
				return deleted;
			}
			env.game[`${this.documentName.toLowerCase()}s`]?.delete?.(this.id);
			env.log.push({ method: 'delete', document: this.uuid, options });
			env.Hooks.callAll(`delete${this.documentName}`, this, options, env.game.user.id);
			return this;
		}

		testUserPermission(user, permission) {
			if (user?.isGM) return true;
			const level = this.ownership?.[user?.id] ?? this.ownership?.default ?? 0;
			const wanted = typeof permission === 'number' ? permission : { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 }[permission] ?? 3;
			return level >= wanted;
		}
		get isOwner() {
			if (this.parent) return this.parent.isOwner;
			return this.testUserPermission(env.game.user, 'OWNER');
		}
	}

	class Item extends Document {
		static documentName = 'Item';
		static metadata = { name: 'Item', compendiumIndexFields: ITEM_INDEX_FIELDS };
		static get database() {
			return env.database;
		}

		prepareBaseData() {
			// NimbleBaseItem#prepareBaseData — the prepared identifier is always the name slug.
			if (this.system && typeof this.name === 'string') {
				this.system.identifier = slugify(this.name, { strict: true });
			}
		}

		get actor() {
			return this.parent?.documentName === 'Actor' ? this.parent : null;
		}
		/** NimbleBaseItem#identifier */
		get identifier() {
			return this._source.system?.identifier || slugify(this.name, { strict: true });
		}
		/** NimbleBaseItem#sourceId */
		get sourceId() {
			return this._stats?.compendiumSource ?? this.flags?.core?.sourceId ?? null;
		}
		get grantedBy() {
			const id = this.system?.grantedById;
			return id ? (this.parent?.items?.get(id) ?? null) : null;
		}
	}

	class Actor extends Document {
		static documentName = 'Actor';
		static metadata = { name: 'Actor', compendiumIndexFields: ACTOR_INDEX_FIELDS };
		static get database() {
			return env.database;
		}

		constructor(data = {}, options = {}) {
			const { items = [], ...rest } = data;
			super({ ...rest, items: [] }, options);
			/** Every embedded CRUD call, in order: {method, embeddedName, data|updates|ids, options, result}. */
			this.calls = [];
			this.items = new Collection();
			for (const itemData of items) {
				const item = new env.classes.Item(itemData, { parent: this });
				this.items.set(item.id, item);
			}
			this.effects = new Collection();
			this.prepareData();
		}

		prepareData() {
			super.prepareData();
			this.prepareEmbeddedDocuments?.();
		}

		prepareDerivedData() {
			// NimbleCharacterData#_prepareLevelData
			const levelData = this.system?.classData?.levels ?? [];
			const classes = levelData.reduce((acc, identifier) => {
				acc[identifier] ??= 0;
				acc[identifier] += 1;
				return acc;
			}, {});
			this.levels = { character: levelData.length, classes };
		}

		get isOwner() {
			return this.testUserPermission(env.game.user, 'OWNER');
		}

		toObject(source = true) {
			const out = super.toObject(source);
			out.items = this.items?.map((i) => i.toObject(source)) ?? [];
			return out;
		}

		getEmbeddedCollection(name) {
			if (name === 'Item') return this.items;
			if (name === 'ActiveEffect') return this.effects;
			throw new Error(`harness: embedded collection "${name}" is not simulated`);
		}

		getRollData() {
			return { ...deepClone(this.system ?? {}), level: this.levels?.character ?? 0 };
		}

		#assertItems(name) {
			if (name !== 'Item') throw new Error(`harness: embedded ${name} CRUD is not simulated (only Item)`);
		}

		async createEmbeddedDocuments(name, data = [], options = {}) {
			this.#assertItems(name);
			const userId = env.game.user.id;
			const created = [];
			for (const raw of data) {
				const src = deepClone(raw instanceof Document ? raw.toObject() : raw);
				if (!options.keepId || !src._id) src._id = randomID();
				if (this.items.has(src._id)) throw new Error(`harness: Item id ${src._id} already exists on ${this.name}`);
				const item = new env.classes.Item(src, { parent: this });
				if (env.Hooks.call('preCreateItem', item, src, options, userId) === false) continue;
				// A preCreate handler may have called item.updateSource — re-read its source.
				this.items.set(item.id, item);
				created.push(item);
			}
			this.calls.push({
				method: 'createEmbeddedDocuments',
				embeddedName: name,
				data: deepClone(data.map((d) => (d instanceof Document ? d.toObject() : d))),
				options,
				result: created.map((i) => i.id),
			});
			env.log.push({ method: 'createEmbeddedDocuments', actor: this.uuid, ids: created.map((i) => i.id) });
			this.prepareData();
			for (const item of created) env.Hooks.callAll('createItem', item, options, userId);
			return created;
		}

		async updateEmbeddedDocuments(name, updates = [], options = {}) {
			this.#assertItems(name);
			const userId = env.game.user.id;
			const updated = [];
			const diffs = [];
			for (const update of updates) {
				const item = this.items.get(update?._id);
				if (!item) throw new Error(`harness: Item "${update?._id}" does not exist on ${this.name}`);
				const changes = stripId(update);
				if (env.Hooks.call('preUpdateItem', item, changes, options, userId) === false) continue;
				const diff = item._applyUpdate(changes);
				updated.push(item);
				diffs.push(diff);
			}
			this.calls.push({
				method: 'updateEmbeddedDocuments',
				embeddedName: name,
				updates: updates.map((u) => deepClone(u)),
				options,
				result: updated.map((i) => i.id),
			});
			env.log.push({ method: 'updateEmbeddedDocuments', actor: this.uuid, ids: updated.map((i) => i.id) });
			this.prepareData();
			updated.forEach((item, i) => env.Hooks.callAll('updateItem', item, diffs[i], options, userId));
			return updated;
		}

		async deleteEmbeddedDocuments(name, ids = [], options = {}) {
			this.#assertItems(name);
			const userId = env.game.user.id;
			const deleted = [];
			for (const id of ids) {
				const item = this.items.get(id);
				if (!item) throw new Error(`harness: Item "${id}" does not exist on ${this.name}`);
				if (env.Hooks.call('preDeleteItem', item, options, userId) === false) continue;
				this.items.delete(id);
				deleted.push(item);
			}
			this.calls.push({
				method: 'deleteEmbeddedDocuments',
				embeddedName: name,
				ids: [...ids],
				options,
				result: deleted.map((i) => i.id),
			});
			env.log.push({ method: 'deleteEmbeddedDocuments', actor: this.uuid, ids: deleted.map((i) => i.id) });
			this.prepareData();
			for (const item of deleted) env.Hooks.callAll('deleteItem', item, options, userId);
			return deleted;
		}

		/** Every recorded embedded call of one method (`'create'|'update'|'delete'` or full name). */
		callsOf(method) {
			const full = method.endsWith('EmbeddedDocuments') ? method : `${method}EmbeddedDocuments`;
			return this.calls.filter((c) => c.method === full);
		}
	}

	/**
	 * Nimble's character document (`NimbleCharacter`), reduced to what the Codex
	 * scripts read: `classes`, the mana max and `highestUnlockedSpellTier` derived in
	 * `prepareDerivedData` (character.ts: `_prepareMaxMana`,
	 * `_prepareHighestUnlockedSpellTier` → `getHighestSpellTier`), and
	 * `triggerLevelUp`, which runs the harness's port of the native level-up flow
	 * (./nimble.mjs `runLevelUp`). Lives on its own prototype so main.mjs's
	 * `wrapTriggerLevelUp` / `prepareDerivedData` wraps patch this class only.
	 */
	class Character extends Actor {
		/** character.ts `get classes()`: identifier → owned class item. */
		get classes() {
			const out = {};
			for (const item of this.items ?? []) {
				if (item.type !== 'class') continue;
				out[item.identifier] = item;
			}
			return out;
		}

		prepareDerivedData() {
			super.prepareDerivedData();
			if (!this.items) return; // Actor constructor: first prepare runs before items exist
			const system = this.system;
			system.resources ??= {};
			const mana = (system.resources.mana ??= {});
			mana.baseMax = Number(mana.baseMax ?? 0) || 0;
			mana.current = Number(mana.current ?? 0) || 0;
			mana.value = mana.current;
			mana.max = prepareMaxMana(this);
			system.resources.highestUnlockedSpellTier ??= prepareHighestUnlockedSpellTier(this);
		}

		/** Runs the ported native level-up (see ./nimble.mjs). `options` scripts the dialog. */
		async triggerLevelUp(options = {}) {
			const { runLevelUp } = await import('./nimble.mjs');
			return runLevelUp(env, this, options);
		}
	}

	// Foundry's Item#updateSource, used by preCreate handlers.
	Item.prototype.updateSource = function updateSource(changes) {
		const diff = expandObject(stripId(changes));
		mergeObject(this._source, deepClone(diff), { applyOperators: true });
		this.prepareData();
		return diff;
	};

	return { Document, Item, Actor, Character };
}

/** Nimble getHighestSpellTier (utils/spell/getHighestSpellTier.ts). */
export const NIMBLE_SPELL_TIER_LEVELS = [1, 4, 6, 8, 10, 12, 14, 16, 18];
export function nimbleHighestSpellTier(level) {
	for (let i = NIMBLE_SPELL_TIER_LEVELS.length - 1; i >= 0; i -= 1) {
		if (level >= NIMBLE_SPELL_TIER_LEVELS[i]) return i + 1;
	}
	return 0;
}

/**
 * Deterministic value of a class mana formula such as `(max(@dexterity, 0))`:
 * `@<ability>` is the ability's `baseValue` (Nimble roll data exposes the mod as
 * the ability key), `@level` the character level.
 */
export function evalManaFormula(formula, actor) {
	const text = String(formula ?? '').trim();
	if (!text) return 0;
	const abilities = actor.system?.abilities ?? {};
	const expr = text.replace(/@([a-zA-Z]+)/g, (_m, key) => {
		if (key === 'level') return String(actor.levels?.character ?? 0);
		const ability = abilities[key];
		return String(Number(ability?.mod ?? ability?.baseValue ?? 0) || 0);
	});
	if (!/^[\d\s+\-*/().,a-z]*$/.test(expr)) throw new Error(`harness: unsupported mana formula "${formula}"`);
	// eslint-disable-next-line no-new-func
	return Number(new Function('max', 'min', 'floor', 'ceil', `return (${expr});`)(Math.max, Math.min, Math.floor, Math.ceil)) || 0;
}

/** character.ts `_prepareMaxMana`. */
function prepareMaxMana(actor) {
	const classes = Object.values(actor.classes ?? {});
	const baseMax = actor.system.resources.mana.baseMax;
	if (classes.length === 0) return baseMax;
	if (actor.levels.character === 1) return baseMax;
	let max = baseMax;
	for (const cls of classes) max += evalManaFormula(cls.system?.mana?.formula, actor);
	return max;
}

/** character.ts `_prepareHighestUnlockedSpellTier`. */
function prepareHighestUnlockedSpellTier(actor) {
	const classes = Object.values(actor.classes ?? {});
	if (classes.length === 0) return 0;
	if (!(actor.system.resources.mana.max > 0)) return null;
	return nimbleHighestSpellTier(actor.levels.character);
}
