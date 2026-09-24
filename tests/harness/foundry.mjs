/**
 * Fresh Foundry v14 + Nimble globals for one test.
 *
 *   const env = installFoundry();             // call in beforeEach
 *   await installPacks(env);                  // real pack data → game.packs (./packs.mjs)
 *   const [main] = await importScripts(['scripts/main.mjs']);
 *   await env.boot();                         // init → setup → ready hooks
 *
 * Everything a test may want to inspect or script hangs off `env`:
 *   env.Hooks           real registry + env.hooks.log of every on/once/call/callAll
 *   env.notifications   {info, warn, error} as vi.fn spies + env.notifications.all
 *   env.dialogs         scriptable DialogV2/Dialog answers + env.dialogs.log
 *   env.settings        game.settings backing store
 *   env.database        compendium database mock + request log
 *   env.log             world-level document writes
 *   env.setUser({isGM}) switch between GM and player
 *   env.libWrapper      the libWrapper mock (installFoundry({libWrapper: true}))
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { vi } from 'vitest';
import { Collection, ForcedDeletion, ForcedReplacement, operators, randomID, slugify, utils } from './foundry-utils.mjs';
import { createDocumentClasses } from './documents.mjs';
import { createCompendiumCollectionClass, createDatabase } from './compendium.mjs';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
export const MODULE_ID = 'blue-codex-package';
/** The sibling module whose Nimble 0.2 playtest copies blue-codex treats as official (optional). */
export const NIM_PLUS_ID = 'nim-plus-package';

/** Nimble's six built-in spell schools (CONFIG.NIMBLE.spellSchools / spellSchoolIcons at init). */
export const CORE_SPELL_SCHOOLS = {
	fire: { label: 'NIMBLE.spellSchools.fire', icon: 'fa-solid fa-fire' },
	ice: { label: 'NIMBLE.spellSchools.ice', icon: 'fa-solid fa-snowflake' },
	lightning: { label: 'NIMBLE.spellSchools.lightning', icon: 'fa-solid fa-bolt' },
	necrotic: { label: 'NIMBLE.spellSchools.necrotic', icon: 'fa-solid fa-skull' },
	radiant: { label: 'NIMBLE.spellSchools.radiant', icon: 'fa-solid fa-sun' },
	wind: { label: 'NIMBLE.spellSchools.wind', icon: 'fa-solid fa-wind' },
};
const MODULE_JSON = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'module.json'), 'utf-8'));

/* ───────────────────────────── Hooks ───────────────────────────── */

function createHooks() {
	const handlers = new Map(); // name → [{fn, once, id}]
	let nextId = 1;
	const log = [];
	const add = (name, fn, once) => {
		const id = nextId++;
		if (!handlers.has(name)) handlers.set(name, []);
		handlers.get(name).push({ fn, once, id });
		log.push({ kind: once ? 'once' : 'on', name, id });
		return id;
	};
	const run = (name, args, { stopOnFalse }) => {
		const list = [...(handlers.get(name) ?? [])];
		const results = [];
		for (const entry of list) {
			if (entry.once) Hooks.off(name, entry.id);
			let result;
			try {
				result = entry.fn(...args);
			} catch (error) {
				// Foundry logs and continues; keep the error visible to tests.
				Hooks.errors.push({ name, error });
				console.error(`harness Hooks: ${name} handler threw`, error);
				continue;
			}
			results.push(result);
			if (stopOnFalse && result === false) return { stopped: true, results };
		}
		return { stopped: false, results };
	};
	const Hooks = {
		events: {},
		errors: [],
		log,
		on: (name, fn) => add(name, fn, false),
		once: (name, fn) => add(name, fn, true),
		off(name, fnOrId) {
			const list = handlers.get(name);
			if (!list) return;
			const i = list.findIndex((e) => e.id === fnOrId || e.fn === fnOrId);
			if (i >= 0) list.splice(i, 1);
		},
		/** Foundry `Hooks.call`: stops at, and returns false for, the first handler returning false. */
		call(name, ...args) {
			log.push({ kind: 'call', name, args });
			return !run(name, args, { stopOnFalse: true }).stopped;
		},
		/** Foundry `Hooks.callAll`: runs every handler, ignores results (async ones are NOT awaited). */
		callAll(name, ...args) {
			log.push({ kind: 'callAll', name, args });
			run(name, args, { stopOnFalse: false });
			return true;
		},
		/** Harness-only: like callAll, but awaits every promise a handler returned. */
		async callAllAsync(name, ...args) {
			log.push({ kind: 'callAll', name, args });
			const { results } = run(name, args, { stopOnFalse: false });
			await Promise.all(results.filter((r) => r && typeof r.then === 'function'));
			return true;
		},
		/** Harness-only: registered handler count for a hook name. */
		count(name) {
			return handlers.get(name)?.length ?? 0;
		},
		/** Harness-only: names with at least one handler. */
		names() {
			return [...handlers.entries()].filter(([, l]) => l.length).map(([n]) => n);
		},
	};
	return Hooks;
}

/* ───────────────────────────── settings ───────────────────────────── */

function createSettings(env, presets = {}) {
	const registered = new Map(); // "ns.key" → config
	const values = new Map(Object.entries(presets));
	return {
		registered,
		values,
		register(namespace, key, config = {}) {
			registered.set(`${namespace}.${key}`, { namespace, key, ...config });
		},
		registerMenu() {},
		/** Throws for an unregistered key, like Foundry. */
		get(namespace, key) {
			const full = `${namespace}.${key}`;
			if (full === 'core.compendiumConfiguration') return {};
			if (!registered.has(full)) throw new Error(`"${full}" is not a registered game setting`);
			return values.has(full) ? values.get(full) : registered.get(full).default;
		},
		async set(namespace, key, value) {
			const full = `${namespace}.${key}`;
			if (!registered.has(full)) throw new Error(`"${full}" is not a registered game setting`);
			values.set(full, value);
			registered.get(full).onChange?.(value);
			env.log.push({ method: 'settings.set', key: full, value });
			return value;
		},
		/** Harness-only: preset a value (works before registration). */
		preset(full, value) {
			values.set(full, value);
		},
	};
}

/* ───────────────────────────── dialogs ───────────────────────────── */

/**
 * Scripted dialog answers. Each DialogV2.wait/confirm/prompt (and legacy
 * Dialog.confirm/wait) call consumes the first queued answer whose matcher
 * accepts it; unmatched calls use `env.dialogs.fallback` ('close' → returns
 * null, like closing a `rejectClose: false` dialog; 'throw' → test error).
 *
 * An answer is one of:
 *   - a function `(config, call) => result`            full control
 *   - `{ action, checked?, value? }`                    press button `action`: its
 *        callback runs with a fake button whose `form.querySelectorAll(...:checked)`
 *        yields `checked` (default: inputs marked `checked` in the content)
 *   - `true`/`false` for confirm dialogs (yes/no); for wait, returned as-is
 *   - a string: the button action to press. As in Foundry v14, the result is
 *     the callback's return value, or the action string when the callback
 *     returns null/undefined (or there is no callback)
 *   - `null`: the dialog is closed (header ×/Escape → null)
 */
function createDialogs() {
	const queue = [];
	const log = [];
	const dialogs = {
		log,
		queue,
		fallback: 'close',
		/** Queue answers consumed in order by any dialog. */
		answer(...answers) {
			for (const a of answers) queue.push({ match: null, answer: a });
			return dialogs;
		},
		/** Queue an answer for the next dialog whose title/content matches (substring or RegExp or fn). */
		answerWhen(match, answer) {
			queue.push({ match, answer });
			return dialogs;
		},
		pending() {
			return queue.length;
		},
		reset() {
			queue.length = 0;
			log.length = 0;
		},
	};

	const titleOf = (config) => config?.window?.title ?? config?.title ?? '';
	const matchOf = (match, config) => {
		if (!match) return true;
		const text = `${titleOf(config)}\n${config?.content ?? ''}`;
		if (typeof match === 'function') return match(config);
		if (match instanceof RegExp) return match.test(text);
		return text.includes(match);
	};

	const checkedFromContent = (content) =>
		[...String(content ?? '').matchAll(/<input[^>]*>/g)]
			.map((m) => m[0])
			.filter((tag) => /\schecked\b/.test(tag))
			.map((tag) => /value="([^"]*)"/.exec(tag)?.[1])
			.filter((v) => v !== undefined)
			.map((v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));

	const fakeButton = (checked, value) => {
		const inputs = (checked ?? []).map((v) => ({ value: v, checked: true }));
		const form = {
			querySelectorAll: (sel) => (String(sel).includes(':checked') ? inputs : inputs),
			querySelector: (sel) => (String(sel).includes(':checked') ? (inputs[0] ?? null) : (inputs[0] ?? null)),
			elements: {},
		};
		return { form, value, dataset: {} };
	};

	async function resolve(kind, config) {
		const i = queue.findIndex((q) => matchOf(q.match, config));
		const entry = i >= 0 ? queue.splice(i, 1)[0] : null;
		const call = { kind, title: titleOf(config), content: config?.content ?? '', config, answer: undefined, result: undefined };
		log.push(call);
		if (!entry) {
			if (dialogs.fallback === 'throw') throw new Error(`harness: unscripted ${kind} dialog "${call.title}"`);
			call.answer = '<closed>';
			call.result = kind === 'confirm' && config?.rejectClose === false ? null : null;
			return call.result;
		}
		const answer = entry.answer;
		call.answer = answer;
		let result;
		if (typeof answer === 'function') result = await answer(config, call);
		else if (answer === null) result = null;
		else if (kind === 'confirm' && typeof answer === 'boolean') {
			const button = answer ? config?.yes : config?.no;
			result = button?.callback ? await button.callback({}, fakeButton([]), {}) : answer;
		} else if (typeof answer === 'boolean') result = answer;
		else {
			const spec = typeof answer === 'string' ? { action: answer } : answer;
			const buttons = config?.buttons ?? [];
			const button = buttons.find((b) => b.action === spec.action);
			if (!button) throw new Error(`harness: dialog "${call.title}" has no button "${spec.action}"`);
			const checked = spec.checked ?? checkedFromContent(config?.content);
			const fake = fakeButton(checked, spec.value);
			// Foundry v14 DialogV2#_onSubmit: `(await callback(event, button, dialog)) ?? button.action`
			// — a callback returning null/undefined resolves to the button's action string.
			result = (await button.callback?.({}, fake, {})) ?? spec.action;
		}
		call.result = result;
		return result;
	}

	class DialogV2 {
		constructor(config = {}) {
			this.options = config;
		}
		static async wait(config = {}) {
			return resolve('wait', config);
		}
		static async confirm(config = {}) {
			return resolve('confirm', config);
		}
		static async prompt(config = {}) {
			return resolve('prompt', config);
		}
		static async input(config = {}) {
			return resolve('input', config);
		}
		async render() {
			const result = await resolve('render', this.options);
			this.options?.submit?.(result);
			return this;
		}
		async close() {}
	}

	class Dialog {
		constructor(data = {}, options = {}) {
			this.data = data;
			this.options = options;
		}
		static async confirm(config = {}) {
			const r = await resolve('confirm', { ...config, window: { title: config.title } });
			if (r) config.yes?.();
			else if (r === false) config.no?.();
			return r;
		}
		static async prompt(config = {}) {
			return resolve('prompt', { ...config, window: { title: config.title } });
		}
		static async wait(data = {}) {
			return resolve('wait', { ...data, window: { title: data.title } });
		}
		render() {
			resolve('render', { ...this.data, window: { title: this.data.title } });
			return this;
		}
		close() {}
	}

	return { dialogs, DialogV2, Dialog };
}

/* ───────────────────────────── uuids ───────────────────────────── */

function createUuidResolvers(env) {
	const parse = (uuid) => {
		const parts = String(uuid ?? '').split('.');
		if (parts[0] === 'Compendium') {
			// Compendium.<pkg>.<pack>[.<Type>].<id>[.<Embedded>.<id>]
			const collection = `${parts[1]}.${parts[2]}`;
			const rest = parts.slice(3);
			const id = rest.length >= 2 ? rest[1] : rest[0];
			return { compendium: true, collection, id, embedded: rest.slice(2) };
		}
		return { compendium: false, type: parts[0], id: parts[1], embedded: parts.slice(2) };
	};
	const embedded = (doc, path) => {
		let cur = doc;
		for (let i = 0; cur && i < path.length; i += 2) cur = cur.getEmbeddedCollection?.(path[i])?.get(path[i + 1]) ?? null;
		return cur ?? null;
	};
	async function fromUuid(uuid) {
		const p = parse(uuid);
		env.uuidLog.push(uuid);
		if (p.compendium) {
			const pack = env.game.packs.get(p.collection);
			if (!pack) return null;
			const doc = await pack.getDocument(p.id);
			return doc ? embedded(doc, p.embedded) : null;
		}
		const coll = { Actor: env.game.actors, Item: env.game.items }[p.type];
		const doc = coll?.get(p.id) ?? null;
		return doc ? embedded(doc, p.embedded) : null;
	}
	function fromUuidSync(uuid) {
		const p = parse(uuid);
		env.uuidLog.push(uuid);
		if (p.compendium) {
			const pack = env.game.packs.get(p.collection);
			if (!pack) return null;
			// Foundry returns the loaded document if cached, else the index entry.
			return pack.get(p.id) ?? pack.index.get(p.id) ?? null;
		}
		const coll = { Actor: env.game.actors, Item: env.game.items }[p.type];
		const doc = coll?.get(p.id) ?? null;
		return doc ? embedded(doc, p.embedded) : null;
	}
	return { fromUuid, fromUuidSync };
}

/* ───────────────────────────── libWrapper ───────────────────────────── */

/**
 * Minimal libWrapper: `register(pkg, target, fn, 'WRAPPER'|'MIXED'|'OVERRIDE')`
 * resolves `target` (a dotted path from globalThis) and chains `fn(wrapped, ...args)`
 * in front of the current method, `this` preserved. `wrapped` is a plain function
 * that forwards its arguments with the same `this` — calling `wrapped.call(x, …)`
 * ignores `x`, as the real library does. Registrations are logged in `.registered`.
 */
function createLibWrapper() {
	const registered = [];
	return {
		registered,
		register(pkg, target, fn, type = 'MIXED') {
			const parts = String(target).split('.');
			const key = parts.pop();
			let owner = globalThis;
			for (const part of parts) {
				owner = owner?.[part];
				if (owner == null) throw new Error(`harness libWrapper: cannot resolve "${target}"`);
			}
			const previous = owner[key];
			if (typeof previous !== 'function') throw new Error(`harness libWrapper: "${target}" is not a function`);
			owner[key] = function libWrapperChain(...args) {
				const self = this;
				const wrapped = (...a) => previous.apply(self, a);
				if (type === 'OVERRIDE') return fn.apply(self, args);
				return fn.call(self, wrapped, ...args);
			};
			registered.push({ pkg, target, type });
			return registered.length;
		},
		unregister() {},
	};
}

/* ───────────────────────────── install ───────────────────────────── */

/**
 * Install fresh Foundry globals. Call in `beforeEach` (every call replaces the
 * previous globals, classes and state completely).
 *
 * @param {object} [options]
 * @param {boolean} [options.isGM=true]
 * @param {Record<string, unknown>} [options.settings]  presets, keyed "namespace.key"
 * @param {string} [options.systemId='nimble']         e.g. 'nimble-dev' to test sysId() handling
 * @param {'close'|'throw'} [options.dialogFallback='close']
 * @returns {object} env
 */
export function installFoundry({
	isGM = true,
	settings = {},
	systemId = 'nimble',
	dialogFallback = 'close',
	modules = {},
	libWrapper = false,
} = {}) {
	const env = { log: [], uuidLog: [], classes: {} };

	const Hooks = createHooks();
	env.Hooks = Hooks;
	env.hooks = Hooks;

	const notifications = {
		all: [],
		info: vi.fn((msg) => void notifications.all.push({ level: 'info', message: String(msg) })),
		warn: vi.fn((msg) => void notifications.all.push({ level: 'warn', message: String(msg) })),
		error: vi.fn((msg) => void notifications.all.push({ level: 'error', message: String(msg) })),
		notify: vi.fn((msg, level = 'info') => void notifications.all.push({ level, message: String(msg) })),
		messages(level) {
			return notifications.all.filter((n) => !level || n.level === level).map((n) => n.message);
		},
	};
	env.notifications = notifications;

	const { dialogs, DialogV2, Dialog } = createDialogs();
	dialogs.fallback = dialogFallback;
	env.dialogs = dialogs;

	env.database = createDatabase(env);
	const classes = createDocumentClasses(env);
	env.classes = classes;
	const CompendiumCollection = createCompendiumCollectionClass(env);
	env.CompendiumCollection = CompendiumCollection;

	const users = [
		{ id: 'gmUser000000000a', name: 'Gamemaster', isGM: true, active: true },
		{ id: 'player00000000a1', name: 'Player', isGM: false, active: true },
	];
	const userCollection = new Collection(users.map((u) => [u.id, u]));

	const game = {
		ready: false,
		system: { id: systemId, version: '0.0.0-test' },
		world: { id: 'test-world' },
		user: isGM ? users[0] : users[1],
		users: userCollection,
		actors: new Collection(),
		items: new Collection(),
		combats: new Collection(),
		messages: new Collection(),
		scenes: new Collection(),
		folders: new Collection(),
		packs: new Collection(),
		modules: new Collection([
			[MODULE_ID, { id: MODULE_ID, active: true, version: MODULE_JSON.version, title: MODULE_JSON.title }],
			// Extra modules, e.g. { 'nim-plus-package': { active: true, api: {…} } }.
			...Object.entries(modules).map(([id, data]) => [id, { id, active: true, ...data }]),
		]),
		combat: null,
		i18n: {
			lang: 'en',
			localize: (k) => k,
			format: (k, data) => `${k}${data ? ` ${JSON.stringify(data)}` : ''}`,
			has: () => false,
		},
		compendiumArt: { get: () => undefined, enabled: false },
		documentIndex: { lookup: () => [] },
		keyboard: { isModifierActive: () => false },
	};
	env.game = game;
	env.settings = createSettings(env, settings);
	game.settings = env.settings;

	env.setUser = ({ isGM: gm = true } = {}) => {
		game.user = gm ? users[0] : users[1];
		return game.user;
	};
	env.users = { gm: users[0], player: users[1] };

	const CONFIG = {
		debug: {},
		Item: { documentClass: classes.Item, compendiumIndexFields: [], sheetClasses: {} },
		Actor: { documentClass: classes.Actor, compendiumIndexFields: [], sheetClasses: {} },
		ChatMessage: { documentClass: class {} },
		Combat: { documentClass: class {} },
		Dice: { rolls: [], terms: {} },
		statusEffects: [],
		NIMBLE: {
			Item: { documentClasses: {} },
			Actor: { documentClasses: { character: classes.Character, npc: classes.Actor, minion: classes.Actor } },
			spellSchools: Object.fromEntries(Object.entries(CORE_SPELL_SCHOOLS).map(([k, v]) => [k, v.label])),
			spellSchoolIcons: Object.fromEntries(Object.entries(CORE_SPELL_SCHOOLS).map(([k, v]) => [k, v.icon])),
			ruleDataModels: {},
		},
	};
	env.CONFIG = CONFIG;

	const { fromUuid, fromUuidSync } = createUuidResolvers(env);

	const foundry = {
		utils: { ...utils },
		data: { operators: { ...operators }, fields: {} },
		abstract: { Document: classes.Document, DataModel: class {}, TypeDataModel: class {} },
		documents: {
			Item: classes.Item,
			Actor: classes.Actor,
			BaseItem: classes.Item,
			BaseActor: classes.Actor,
			Folder: class Folder {},
			collections: { CompendiumCollection },
		},
		applications: {
			api: {
				ApplicationV2: class ApplicationV2 {},
				HandlebarsApplicationMixin: (B) => B,
				DialogV2,
			},
			ux: { TextEditor: { implementation: { enrichHTML: async (v) => v } } },
			handlebars: { renderTemplate: async () => '', loadTemplates: async () => {} },
			sheets: {},
		},
		dice: { terms: {} },
		canvas: {},
	};
	env.foundry = foundry;

	class Roll {
		constructor(formula, data = {}) {
			this.formula = String(formula);
			this.data = data;
			this.terms = [];
			this.total = 0;
			this._evaluated = false;
		}
		async evaluate() {
			this._evaluated = true;
			return this;
		}
		evaluateSync() {
			this._evaluated = true;
			return this;
		}
		static async create(formula, data) {
			return new Roll(formula, data);
		}
	}

	const ChatMessage = {
		created: [],
		async create(data) {
			ChatMessage.created.push(data);
			return { id: randomID(), ...data };
		},
		getSpeaker: ({ actor } = {}) => ({ actor: actor?.id ?? null, alias: actor?.name ?? '' }),
		getSpeakerActor: (speaker) => (speaker?.actor ? game.actors.get(speaker.actor) : null),
	};
	env.ChatMessage = ChatMessage;

	const globals = {
		game,
		CONFIG,
		foundry,
		Hooks,
		ui: { notifications, windows: {}, sidebar: {} },
		canvas: { ready: false, scene: null, tokens: { placeables: [], controlled: [] }, grid: { size: 100 } },
		CONST: {
			CHAT_MESSAGE_STYLES: { OTHER: 0, OOC: 1, IC: 2, EMOTE: 3 },
			DOCUMENT_OWNERSHIP_LEVELS: { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
			GRID_TYPES: { SQUARE: 1 },
			vtt: 'Foundry VTT',
		},
		Actor: classes.Actor,
		Item: classes.Item,
		Roll,
		ChatMessage,
		Dialog,
		CompendiumCollection,
		Token: class Token {},
		TokenDocument: class TokenDocument {},
		MeasuredTemplateDocument: class MeasuredTemplateDocument {},
		fromUuid,
		fromUuidSync,
		renderTemplate: async () => '',
		loadTemplates: async () => {},
		Handlebars: { registerHelper: () => {} },
		_replace: ForcedReplacement.create,
		_del: new ForcedDeletion(),
		_loc: (k) => k,
		// DOM stand-ins: main.mjs guards its sheet/dialog DOM work with
		// `x instanceof HTMLElement`; nothing here is ever an element, so those paths no-op.
		HTMLElement: globalThis.HTMLElement ?? class HTMLElement {},
		// A class (not a plain object): vitest's own matchers test `x instanceof Node`.
		Node: globalThis.Node ?? class Node { static TEXT_NODE = 3; static ELEMENT_NODE = 1; },
		MutationObserver: globalThis.MutationObserver ?? class MutationObserver { observe() {} disconnect() {} },
	};
	for (const [key, value] of Object.entries(globals)) globalThis[key] = value;
	// libWrapper: absent by default (main.mjs then patches prototypes directly);
	// `libWrapper: true` installs a minimal WRAPPER-only mock (see createLibWrapper).
	if (libWrapper) {
		env.libWrapper = createLibWrapper();
		globalThis.libWrapper = env.libWrapper;
	} else {
		delete globalThis.libWrapper;
	}
	if (!Object.hasOwn(String.prototype, 'slugify')) {
		Object.defineProperty(String.prototype, 'slugify', {
			value(options) {
				return slugify(this, options);
			},
			configurable: true,
			writable: true,
		});
	}

	/**
	 * Fire the startup hooks in Foundry's order, awaiting async handlers.
	 * @param {object} [opts]
	 * @param {'init'|'setup'|'ready'} [opts.until='ready']
	 */
	env.boot = async ({ until = 'ready' } = {}) => {
		for (const stage of ['init', 'i18nInit', 'setup', 'ready']) {
			if (stage === 'ready') game.ready = true;
			await Hooks.callAllAsync(stage);
			await flushPromises();
			if (stage === until) break;
		}
		return env;
	};

	/** Harness-only: let queued microtasks/async hook work settle. */
	env.flush = flushPromises;

	return env;
}

/**
 * Let queued microtasks, immediates AND short timers settle: main.mjs defers some
 * work with `setTimeout(…, 0)` (preCreateItem substitutes, school re-registration),
 * which Node may schedule after a burst of immediates. Two passes separated by a
 * real timer tick cover chains of either.
 */
export async function flushPromises(rounds = 20) {
	for (let pass = 0; pass < 2; pass += 1) {
		for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
		await new Promise((r) => setTimeout(r, 2));
	}
	for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
}

/* ───────────────────────────── script loading ───────────────────────────── */

/**
 * Import module scripts with a FRESH module registry (vi.resetModules), so their
 * top-level `Hooks.on/once` calls register against the current env and their
 * module-level state (supersede cache, patch sentinels) starts clean.
 *
 * @param {string|string[]} paths  repo-relative paths, e.g. 'scripts/main.mjs'
 * @param {object} [opts]
 * @param {boolean} [opts.reset=true]  false = reuse already-imported instances
 * @returns {Promise<object|object[]>} the module namespace(s), same shape as `paths`
 */
export async function importScripts(paths, { reset = true } = {}) {
	if (reset) vi.resetModules();
	const list = Array.isArray(paths) ? paths : [paths];
	const out = [];
	for (const p of list) {
		const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
		out.push(await import(/* @vite-ignore */ pathToFileURL(abs).href));
	}
	return Array.isArray(paths) ? out : out[0];
}
