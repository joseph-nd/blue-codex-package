/**
 * Faithful ports of the `foundry.utils` helpers and `foundry.data.operators`
 * that the module scripts rely on, taken from Foundry v14
 * (`common/utils/helpers.mjs`, `common/data/operators.mjs`,
 * `common/utils/collection.mjs`). Kept semantically identical where it
 * matters: dotted-key expansion, `-=`/`==` legacy keys, ForcedDeletion /
 * ForcedReplacement handling in mergeObject, deepClone of plain objects only,
 * and a Collection whose iterator yields *values*.
 */

/* ───────────────────────────── operators ───────────────────────────── */

export const OPERATOR_VALUE = Symbol('DataFieldOperatorValue');

export class DataFieldOperator {
	constructor(value) {
		this[OPERATOR_VALUE] = value;
	}
	toJSON() {
		const v = this[OPERATOR_VALUE];
		return { __$OPERATOR$__: this.constructor.name, value: typeof v?.toJSON === 'function' ? v.toJSON() : v };
	}
	static create(value) {
		return new this(value);
	}
	static get(value) {
		return value instanceof DataFieldOperator ? value[OPERATOR_VALUE] : value;
	}
	static set(operator, value) {
		return (operator[OPERATOR_VALUE] = value);
	}
}

export class ForcedDeletion extends DataFieldOperator {
	constructor(_value) {
		super();
	}
}

export class ForcedReplacement extends DataFieldOperator {
	constructor(value) {
		super(ForcedReplacement.get(value));
	}
	static create(value) {
		return new Proxy(new ForcedReplacement(value), {
			get(target, prop, receiver) {
				if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
				const v = target[OPERATOR_VALUE];
				if (v && typeof v === 'object') return Reflect.get(v, prop, receiver);
				return undefined;
			},
			has(target, key) {
				if (Reflect.has(target, key)) return true;
				const v = target[OPERATOR_VALUE];
				if (v && typeof v === 'object') return Reflect.has(v, key);
				return false;
			},
			set(target, prop, value) {
				if (Reflect.has(target, prop)) return Reflect.set(target, prop, value);
				const v = target[OPERATOR_VALUE];
				if (v && typeof v === 'object') return Reflect.set(v, prop, value);
				return false;
			},
			ownKeys(target) {
				const v = target[OPERATOR_VALUE];
				return v && typeof v === 'object' ? Reflect.ownKeys(v) : [];
			},
			getOwnPropertyDescriptor(target, prop) {
				const v = target[OPERATOR_VALUE];
				if (v && typeof v === 'object') {
					const descriptor = Reflect.getOwnPropertyDescriptor(v, prop);
					if (descriptor?.configurable === false) Object.defineProperty(target, prop, descriptor);
					return descriptor;
				}
				return undefined;
			},
		});
	}
}

export const operators = { DataFieldOperator, ForcedDeletion, ForcedReplacement, OPERATOR_VALUE };

/* ───────────────────────────── helpers ───────────────────────────── */

const plainObjectPrototype = Object.getPrototypeOf({});
const SKIPPED_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(value) {
	if (!value) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === plainObjectPrototype || prototype === null;
}

export function getType(variable) {
	const typeOf = typeof variable;
	if (typeOf !== 'object') return typeOf;
	if (variable === null) return 'null';
	if (isPlainObject(variable)) return 'Object';
	if (Array.isArray(variable)) return 'Array';
	for (const [cls, type] of [
		[Set, 'Set'],
		[Map, 'Map'],
		[Promise, 'Promise'],
		[Error, 'Error'],
	]) {
		if (variable instanceof cls) return type;
	}
	return 'Unknown';
}

export function isDeletionKey(key) {
	if (typeof key !== 'string') return false;
	return key[1] === '=' && (key[0] === '=' || key[0] === '-');
}

function migrateDeletionKey(k, v) {
	const key = k.slice(2);
	let value;
	if (k[0] === '-') {
		if (v !== null) throw new Error(`Removing a key using the deprecated -= deletion syntax requires null (${k})`);
		value = new ForcedDeletion();
	} else {
		value = ForcedReplacement.create(v);
	}
	return { key, value };
}

export function deepClone(original, { strict = false, prune = false } = {}) {
	return _deepClone(original, strict, prune, 0);
}

function _deepClone(original, strict, prune, d) {
	if (d > 100) throw new Error('Maximum depth exceeded. Be sure your object does not contain cyclical data structures.');
	d += 1;
	if (typeof original !== 'object' || original === null) return original;
	if (Array.isArray(original)) return original.map((o) => _deepClone(o, strict, prune, d));
	if (original instanceof Date) return new Date(original);
	if (!isPlainObject(original)) {
		if (strict) throw new Error('deepClone cannot clone advanced objects');
		return original;
	}
	const clone = {};
	for (const k of Object.keys(original)) {
		if (original[k] === undefined && prune) continue;
		clone[k] = _deepClone(original[k], strict, prune, d);
	}
	return clone;
}

export function applyDataOperators(obj) {
	if (obj instanceof DataFieldOperator) obj = DataFieldOperator.get(obj);
	if (Array.isArray(obj)) return obj.map(applyDataOperators);
	if (!isPlainObject(obj)) return obj;
	const clone = {};
	for (let key in obj) {
		let value = obj[key];
		if (isDeletionKey(key)) ({ key, value } = migrateDeletionKey(key, value));
		if (value instanceof ForcedDeletion) delete clone[key];
		else clone[key] = applyDataOperators(value);
	}
	return clone;
}

export function getProperty(object, key) {
	if (!key || !object) return undefined;
	if (key in object) return object[key];
	let target = object;
	for (const p of key.split('.')) {
		if (!target) return undefined;
		const type = typeof target;
		if (type !== 'object' && type !== 'function') return undefined;
		if (p in target) target = target[p];
		else return undefined;
	}
	return target;
}

export function hasProperty(object, key) {
	if (!key || !object) return false;
	if (key in object) return true;
	let target = object;
	for (const p of key.split('.')) {
		if (!target || typeof target !== 'object') return false;
		if (p in target) target = target[p];
		else return false;
	}
	return true;
}

export function setProperty(object, key, value) {
	if (!key || SKIPPED_PROPERTIES.has(key)) return false;
	let target = object;
	if (key.indexOf('.') !== -1) {
		const parts = key.split('.');
		if (parts.some((p) => SKIPPED_PROPERTIES.has(p))) return false;
		key = parts.pop();
		target = parts.reduce((t, p) => {
			if (t[p] === undefined) t[p] = {};
			return t[p];
		}, object);
	}
	if (target[key] !== value) {
		target[key] = value;
		return true;
	}
	return false;
}

export function expandObject(obj) {
	const expand = (value, depth) => {
		if (depth > 32) throw new Error('Maximum object expansion depth exceeded');
		if (!value) return value;
		if (Array.isArray(value)) return value.map((v) => expand(v, depth + 1));
		if (!isPlainObject(value)) return value;
		const expanded = {};
		for (const [k, v] of Object.entries(value)) setProperty(expanded, k, expand(v, depth + 1));
		return expanded;
	};
	return expand(obj, 0);
}

export function flattenObject(obj, d = 0) {
	const flat = {};
	if (d > 100) throw new Error('Maximum depth exceeded');
	for (const [k, v] of Object.entries(obj)) {
		if (isPlainObject(v)) {
			if (Object.keys(v).length === 0) flat[k] = v;
			for (const [ik, iv] of Object.entries(flattenObject(v, d + 1))) flat[`${k}.${ik}`] = iv;
		} else flat[k] = v;
	}
	return flat;
}

export function mergeObject(
	original,
	other = {},
	{
		insertKeys = true,
		insertValues = true,
		overwrite = true,
		recursive = true,
		inplace = true,
		enforceTypes = false,
		applyOperators = false,
		performDeletions = false,
	} = {},
	_d = 0,
) {
	if (!(original instanceof Object) || !(other instanceof Object)) {
		throw new Error('One of original or other are not Objects!');
	}
	if (performDeletions) applyOperators ||= performDeletions;
	const options = { insertKeys, insertValues, overwrite, recursive, inplace, enforceTypes, applyOperators };

	if (_d === 0) {
		if (Object.keys(other).some((k) => k.includes('.'))) other = expandObject(other);
		if (Object.keys(original).some((k) => k.includes('.'))) {
			const expanded = expandObject(original);
			if (options.inplace) {
				Object.keys(original).forEach((k) => delete original[k]);
				Object.assign(original, expanded);
			} else original = expanded;
		} else if (!options.inplace) original = deepClone(original);
	}

	for (let k of Object.keys(other)) {
		let v = other[k];
		if (isDeletionKey(k)) ({ key: k, value: v } = migrateDeletionKey(k, v));
		if (Object.hasOwn(original, k)) mergeUpdate(original, k, v, _d + 1, options);
		else mergeInsert(original, k, v, _d + 1, options);
	}
	return original;
}

function mergeInsert(original, k, v, d, options) {
	const canInsert = (d <= 1 && options.insertKeys) || (d > 1 && options.insertValues);
	if (!canInsert || v instanceof ForcedDeletion) return;
	if (v instanceof ForcedReplacement) {
		original[k] = options.applyOperators ? applyDataOperators(v) : v;
		return;
	}
	original[k] = options.applyOperators ? applyDataOperators(v) : deepClone(v);
}

function mergeUpdate(original, k, v, d, options) {
	const x = original[k];
	const tv = getType(v);
	const tx = getType(x);
	const ov = tv === 'Object' || tv === 'Unknown';
	const ox = tx === 'Object' || tx === 'Unknown';
	if (v instanceof ForcedDeletion) {
		if (options.overwrite === false) return;
		if (options.applyOperators) delete original[k];
		else original[k] = v;
		return;
	}
	if (v instanceof ForcedReplacement) {
		if (options.overwrite === false) return;
		original[k] = options.applyOperators ? applyDataOperators(v) : v;
		return;
	}
	if (ov && ox && options.recursive) {
		mergeObject(x, v, { ...options, inplace: true }, d);
		return;
	}
	if (options.overwrite) {
		if (tx !== 'undefined' && tv !== tx && options.enforceTypes) {
			throw new Error('Mismatched data types encountered during object merge.');
		}
		original[k] = options.applyOperators ? applyDataOperators(v) : deepClone(v);
	}
}

export function randomID(length = 16) {
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

export function equals(a, b) {
	return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v) {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (isPlainObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
	return v;
}

export function debounce(fn, _ms) {
	// Tests never wait on timers; a debounced call is simply dropped.
	return () => {};
}

export function buildUuid({ id, documentName, pack, parent } = {}) {
	if (pack) return `Compendium.${pack}.${documentName}.${id}`;
	if (parent) return `${parent.uuid}.${documentName}.${id}`;
	return `${documentName}.${id}`;
}

/**
 * Foundry's `String.prototype.slugify` (common/primitives/string.mjs). The
 * accent CHAR_MAP is approximated with NFD normalisation.
 */
export function slugify(str, { replacement = '-', strict = false, lowercase = true } = {}) {
	let slug = String(str).normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
	if (lowercase) slug = slug.toLowerCase();
	const esc = replacement.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
	slug = slug.replace(new RegExp(`[\\s${esc}]+`, 'g'), replacement);
	if (strict) slug = slug.replace(new RegExp(`[^a-zA-Z0-9${esc}]`, 'g'), '');
	return slug;
}

/* ───────────────────────────── Collection ───────────────────────────── */

/** `foundry.utils.Collection`: a Map whose iterator yields values. */
export class Collection extends Map {
	*[Symbol.iterator]() {
		yield* this.values();
	}
	get contents() {
		return Array.from(this.values());
	}
	find(fn) {
		for (const [k, v] of this.entries()) if (fn(v, k, this)) return v;
		return undefined;
	}
	filter(fn) {
		const out = [];
		for (const [k, v] of this.entries()) if (fn(v, k, this)) out.push(v);
		return out;
	}
	map(fn) {
		const out = [];
		for (const [k, v] of this.entries()) out.push(fn(v, k, this));
		return out;
	}
	some(fn) {
		for (const [k, v] of this.entries()) if (fn(v, k, this)) return true;
		return false;
	}
	every(fn) {
		for (const [k, v] of this.entries()) if (!fn(v, k, this)) return false;
		return true;
	}
	reduce(fn, initial) {
		let acc = initial;
		for (const [k, v] of this.entries()) acc = fn(acc, v, k, this);
		return acc;
	}
	forEach(fn) {
		for (const [k, v] of this.entries()) fn(v, k, this);
	}
	get(key, { strict = false } = {}) {
		const entry = super.get(key);
		if (strict && entry === undefined) throw new Error(`The key ${key} does not exist in the ${this.constructor.name} Collection`);
		return entry;
	}
	getName(name, { strict = false } = {}) {
		const entry = this.find((e) => e.name === name);
		if (strict && entry === undefined) throw new Error(`An entry with name ${name} does not exist in the collection`);
		return entry ?? undefined;
	}
	toJSON() {
		return this.map((e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e));
	}
}

export const utils = {
	applyDataOperators,
	buildUuid,
	Collection,
	debounce,
	deepClone,
	duplicate: (v) => JSON.parse(JSON.stringify(v)),
	equals,
	expandObject,
	flattenObject,
	getProperty,
	getType,
	hasProperty,
	isDeletionKey,
	isEmpty: (v) => (v == null ? true : typeof v === 'object' ? Object.keys(v).length === 0 : false),
	isPlainObject,
	mergeObject,
	randomID,
	setProperty,
	escapeHTML: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
	sleep: async () => {},
	isNewerVersion: (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }) > 0,
	logCompatibilityWarning: () => {},
};
