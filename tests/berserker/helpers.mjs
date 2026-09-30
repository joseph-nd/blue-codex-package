/**
 * Codex Berserker world stand-ins: a Berserker character built from owned copies
 * of the real pack documents (the system's Rage with its Fury Dice pool, the
 * Codex subclass features), allies/enemies as real harness actors on a scene,
 * and the ActiveEffect CRUD / statuses / applyDamage the harness does not
 * simulate (tests/README.md "Gaps"), added per actor.
 */
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { Collection, REPO_ROOT, adoptActor, deepClone, expandObject, getProperty, mergeObject, randomID, setupWorld } from '../harness/index.mjs';
import { addToken, makeScene, patchUuidResolver, startCombat } from '../summons/helpers.mjs';

export const MODULE_ID = 'blue-codex-package';
export const SYS = 'nimble';
export const PLAYER_ID = 'player00000000a1';
const SUBCLASS_DIR = 'pack-sources/classFeatures/berserker/berserker-subclasses';
const SYSTEM_BERSERKER = '../FoundryVTT-Nimble/packs/classFeatures/core/berserker';

export const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
/** A Codex subclass feature source: codex('lycan', 'howl-in-the-night'). */
export const codex = (subclass, slug) => readJson(`${SUBCLASS_DIR}/path-of-the-${subclass}/${slug}.json`);
export const systemFeature = (rel) => readJson(`${SYSTEM_BERSERKER}/${rel}.json`);
export const RAGE = systemFeature('berserker-progression/rage');
export const TAYG = systemFeature('berserker-progression/that-all-you-got');
export const BITE = readJson('pack-sources/items/berserker/bite.json');
export const CLAWS = readJson('pack-sources/items/berserker/claws.json');
export const BATTLEAXE = readJson('../FoundryVTT-Nimble/packs/items/core/weapons/battleaxe.json');

let counter = 0;
/** An owned copy of a document, with optional item-scope charge pools. */
export function owned(doc, { pools = {} } = {}) {
	const data = structuredClone(doc);
	counter += 1;
	data._id = `bzkItem${String(counter).padStart(9, '0')}`;
	data.flags ??= {};
	if (Object.keys(pools).length) {
		data.flags[SYS] ??= {};
		data.flags[SYS].chargePools = {};
		for (const [identifier, [current, max]] of Object.entries(pools)) {
			data.flags[SYS].chargePools[identifier] = { current, max, label: identifier };
		}
	}
	return data;
}

/** The system's Rage with a Fury Dice pool state (faces, max, die size). */
export function rage({ faces = [], max = 3, dieSize = 'd4' } = {}) {
	const data = owned(RAGE);
	data.flags[SYS] = { dicePools: { fury: { faces, max, dieSize, label: 'Fury Dice', identifier: 'fury' } } };
	return data;
}

/** ActiveEffect CRUD, statuses, toggleStatusEffect and applyDamage on one actor. */
export function enableEffects(env, actor) {
	actor.effects ??= new Collection();
	const make = (data) => {
		const effect = {
			...deepClone(data),
			id: data._id ?? randomID(),
			parent: actor,
			disabled: !!data.disabled,
			flags: deepClone(data.flags ?? {}),
			getFlag(scope, key) {
				return getProperty(this.flags?.[scope], key);
			},
			async update(changes) {
				const diff = expandObject(deepClone(changes));
				mergeObject(this, diff, { applyOperators: true });
				env.Hooks.callAll('updateActiveEffect', this, diff, {}, env.game.user.id);
				return this;
			},
			async delete() {
				actor.effects.delete(this.id);
				env.Hooks.callAll('deleteActiveEffect', this, {}, env.game.user.id);
				return this;
			},
			toObject() {
				const { parent: _p, getFlag: _g, update: _u, delete: _d, toObject: _t, ...rest } = this;
				return deepClone({ ...rest, _id: this.id });
			},
		};
		return effect;
	};
	const create = actor.createEmbeddedDocuments?.bind(actor);
	const remove = actor.deleteEmbeddedDocuments?.bind(actor);
	actor.createEmbeddedDocuments = vi.fn(async (name, data = [], options = {}) => {
		if (name !== 'ActiveEffect') return create(name, data, options);
		const created = data.map(make);
		for (const effect of created) actor.effects.set(effect.id, effect);
		for (const effect of created) env.Hooks.callAll('createActiveEffect', effect, options, env.game.user.id);
		return created;
	});
	actor.deleteEmbeddedDocuments = vi.fn(async (name, ids = [], options = {}) => {
		if (name !== 'ActiveEffect') return remove(name, ids, options);
		const gone = [];
		for (const id of ids) {
			const effect = actor.effects.get(id);
			if (!effect) continue;
			actor.effects.delete(id);
			gone.push(effect);
			env.Hooks.callAll('deleteActiveEffect', effect, options, env.game.user.id);
		}
		return gone;
	});
	actor.statuses = new Set();
	actor.toggleStatusEffect = vi.fn(async (status, { active } = {}) => {
		if (active === false) actor.statuses.delete(status);
		else actor.statuses.add(status);
		return true;
	});
	actor.applyDamage = vi.fn(async (amount) => {
		const hp = actor.system.attributes.hp;
		const absorbed = Math.min(Number(hp.temp) || 0, amount);
		await actor.update({
			'system.attributes.hp.temp': (Number(hp.temp) || 0) - absorbed,
			'system.attributes.hp.value': Math.max(0, hp.value - (amount - absorbed)),
		});
	});
	return actor;
}

/** A Rage toggle effect (as the system's toggleEffect creates it) on a Berserker. */
export async function startRaging(actor) {
	const item = actor.items.find((i) => i.name === 'Rage');
	const [effect] = await actor.createEmbeddedDocuments('ActiveEffect', [
		{ name: 'Rage', disabled: false, flags: { [SYS]: { toggleEffectRuleId: 'rage-toggle', toggleEffectItemId: item.id } } },
	]);
	return effect;
}

/** A plain character (ally / Berserker) with effects support. */
export function makeCharacter(env, { id, name, level = 11, str = 3, dex = 1, hp = [30, 30], temp = 0, items = [], ownedByPlayer = false }) {
	const actor = adoptActor(env, {
		_id: id,
		name,
		type: 'character',
		ownership: ownedByPlayer ? { default: 0, [PLAYER_ID]: 3 } : { default: 0 },
		system: {
			abilities: { strength: { mod: str }, dexterity: { mod: dex }, intelligence: { mod: 0 }, will: { mod: 0 } },
			classData: { levels: Array.from({ length: level }, () => 'berserker') },
			attributes: { hp: { value: hp[0], max: hp[1], temp }, wounds: { value: 0, max: 6 }, armor: { value: 1, hint: '' } },
		},
		items: [{ _id: `${id.slice(0, 11)}Class`, name: 'Berserker', type: 'class', system: { identifier: 'berserker' } }, ...items],
	});
	return enableEffects(env, actor);
}

/** A hostile NPC as a real harness actor (so `Actor.<id>` uuids resolve). */
export function makeEnemy(env, name, hp = 20) {
	const actor = new env.classes.Actor({
		_id: `npc${name}`.padEnd(16, '0').slice(0, 16),
		name,
		type: 'npc',
		system: { attributes: { hp: { value: hp, max: hp, temp: 0 } } },
	});
	env.game.actors.set(actor.id, actor);
	return enableEffects(env, actor);
}

/** Put an actor's token on the scene at grid (gx, gy). */
export function place(env, scene, actor, [gx, gy], disposition = 1) {
	const token = addToken(env, scene, { name: actor.name, x: gx * 100, y: gy * 100, actorId: actor.id, actorLink: true, disposition }, { actor });
	actor.getActiveTokens = () => [{ id: token.id, document: token }];
	return token;
}

/** Deterministic dice: every `new Roll('NdX').evaluate()` yields the next queued faces. */
export function queueDice(...rolls) {
	const queue = rolls.map((faces) => [...faces]);
	globalThis.Roll = class QueuedRoll {
		constructor(formula) {
			this.formula = formula;
			this.terms = [];
			this.total = 0;
		}
		async evaluate() {
			const faces = queue.shift() ?? [];
			this.dice = [{ results: faces.map((result) => ({ result, active: true })) }];
			this.total = faces.reduce((a, b) => a + b, 0);
			return this;
		}
	};
	return queue;
}

/** A Codex Berserker on a scene, in a started combat. */
export async function berserkerWorld({ level = 11, str = 3, dex = 1, features = [], fury = [], furyMax = 3, dieSize = 'd4', weapons = [], hp = [30, 30], ownedByPlayer = false, isGM = true } = {}) {
	const { env, main } = await setupWorld({ isGM });
	const h = main.__codexBerserker__;
	const scene = makeScene(env);
	patchUuidResolver(env);
	const actor = makeCharacter(env, {
		id: 'berserkerActor01',
		name: 'Brakka',
		level,
		str,
		dex,
		hp,
		ownedByPlayer,
		items: [rage({ faces: fury, max: furyMax, dieSize }), owned(TAYG), ...features.map((doc) => owned(doc)), ...weapons.map((doc) => owned(doc))],
	});
	const token = place(env, scene, actor, [5, 5]);
	const combat = startCombat(env);
	const item = (name) => actor.items.find((i) => i.name === name);
	const faces = () => actor.items.find((i) => i.name === 'Rage').flags[SYS].dicePools.fury.faces;
	return { env, main, h, scene, actor, token, combat, item, faces };
}

export { startCombat };
