/**
 * Scene / token / synthetic-actor stand-ins for the summon framework tests.
 *
 * The harness has no canvas, scenes or tokens (tests/README.md "Gaps"), so this
 * builds just enough of them: a scene whose `createEmbeddedDocuments('Token')`
 * makes token documents carrying a synthetic (unlinked) `minion`/`npc` actor
 * cloned from a companion base actor, `delete`/`update` on both that fire the
 * Foundry hooks main.mjs listens to (createToken, deleteToken, updateToken,
 * updateActor), and `fromUuidSync` resolving `Scene.<id>.Token.<id>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
	Collection,
	createCharacter,
	deepClone,
	expandObject,
	getProperty,
	mergeObject,
	randomID,
	REPO_ROOT,
	setupWorld,
} from '../harness/index.mjs';

export const MODULE_ID = 'blue-codex-package';

export function companionSource(slug) {
	return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, `pack-sources/companions/${slug}.json`), 'utf-8'));
}

/** A world "base actor" for a companion template, as resolveCompanionBaseActor finds it. */
export function installCompanion(env, slug) {
	const source = companionSource(slug);
	const base = {
		id: randomID(),
		name: source.name,
		type: source.type,
		flags: deepClone(source.flags),
		source,
		prototypeToken: { toObject: () => deepClone(source.prototypeToken) },
		getFlag(scope, key) {
			return getProperty(this.flags?.[scope], key);
		},
	};
	env.game.actors.set(base.id, base);
	return base;
}

function applyChanges(target, changes) {
	const diff = expandObject(deepClone(changes ?? {}));
	mergeObject(target, diff, { applyOperators: true });
	return diff;
}

/** The synthetic actor of a spawned token (a plain stand-in of an unlinked token actor). */
function makeSyntheticActor(env, tokenDoc, base) {
	const source = base?.source ?? { type: 'minion', system: { attributes: { hp: { value: 1, max: 1, temp: 0 } } }, items: [] };
	const actor = {
		id: randomID(),
		name: tokenDoc.name,
		type: source.type ?? 'minion',
		isToken: true,
		token: tokenDoc,
		system: deepClone(source.system ?? {}),
		items: (source.items ?? []).map((item) => ({ ...deepClone(item), id: item._id ?? randomID() })),
		effects: [],
		statuses: new Set(),
		get uuid() {
			return `${tokenDoc.uuid}.Actor.${this.id}`;
		},
		async update(changes, options = {}) {
			const diff = applyChanges(this, changes);
			env.Hooks.callAll('updateActor', this, diff, options, env.game.user.id);
			return this;
		},
		async createEmbeddedDocuments(type, datas) {
			const created = datas.map((data) => ({ ...deepClone(data), id: data._id ?? randomID() }));
			if (type === 'Item') this.items.push(...created);
			return created;
		},
		async updateEmbeddedDocuments(type, updates) {
			for (const update of updates) {
				const item = this.items.find((i) => i.id === update._id);
				if (item) applyChanges(item, Object.fromEntries(Object.entries(update).filter(([k]) => k !== '_id')));
			}
			return updates;
		},
		async deleteEmbeddedDocuments(type, ids) {
			this.items = this.items.filter((i) => !ids.includes(i.id));
			return ids;
		},
		testUserPermission: () => true,
	};
	return actor;
}

/** A scene with token CRUD. `env.scene` is set and it becomes canvas.scene. */
export function makeScene(env, { id = 'sceneArena000001', grid = 100 } = {}) {
	globalThis.CONST.TOKEN_DISPOSITIONS ??= { SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 };
	const bases = () => [...env.game.actors.values()].filter((a) => a.source);
	const scene = {
		id,
		name: 'Arena',
		grid: { size: grid },
		tokens: new Collection(),
		async createEmbeddedDocuments(type, datas, options = {}) {
			return datas.map((data) => addToken(env, scene, data, { keepId: options.keepId, base: bases().find((b) => b.id === data.actorId) }));
		},
		async deleteEmbeddedDocuments(type, ids) {
			const gone = [];
			for (const tokenId of ids) {
				const token = scene.tokens.get(tokenId);
				if (!token) continue;
				scene.tokens.delete(tokenId);
				gone.push(token);
				env.Hooks.callAll('deleteToken', token, {}, env.game.user.id);
			}
			return gone;
		},
	};
	env.game.scenes.set(id, scene);
	globalThis.canvas.scene = scene;
	env.scene = scene;
	return scene;
}

/** Add a token document to `scene` (a placed PC/NPC, or what a spawn creates). */
export function addToken(env, scene, data, { keepId = false, base = null, actor = null } = {}) {
	const tokenId = keepId && data._id ? data._id : (data._id && !scene.tokens.has(data._id) ? data._id : randomID());
	const doc = {
		id: tokenId,
		name: data.name ?? base?.name ?? 'Token',
		x: data.x ?? 0,
		y: data.y ?? 0,
		width: data.width ?? 1,
		height: data.height ?? 1,
		hidden: false,
		disposition: data.disposition ?? 1,
		actorId: data.actorId ?? actor?.id ?? null,
		actorLink: Boolean(data.actorLink),
		flags: deepClone(data.flags ?? {}),
		parent: scene,
		get uuid() {
			return `Scene.${scene.id}.Token.${this.id}`;
		},
		get isOwner() {
			return true;
		},
		getFlag(scope, key) {
			return getProperty(this.flags?.[scope], key);
		},
		async setFlag(scope, key, value) {
			return this.update({ [`flags.${scope}.${key}`]: value });
		},
		async unsetFlag(scope, key) {
			const parts = key.split('.');
			const last = parts.pop();
			return this.update({ [['flags', scope, ...parts, `-=${last}`].join('.')]: null });
		},
		async update(changes, options = {}) {
			const diff = applyChanges(this, changes);
			env.Hooks.callAll('updateToken', this, diff, options, env.game.user.id);
			return this;
		},
		async delete() {
			return (await scene.deleteEmbeddedDocuments('Token', [this.id]))[0];
		},
		toObject() {
			return deepClone({
				_id: this.id,
				name: this.name,
				x: this.x,
				y: this.y,
				actorId: this.actorId,
				actorLink: this.actorLink,
				disposition: this.disposition,
				flags: this.flags,
			});
		},
	};
	doc.actor = actor ?? makeSyntheticActor(env, doc, base);
	scene.tokens.set(doc.id, doc);
	env.Hooks.callAll('createToken', doc, {}, env.game.user.id);
	return doc;
}

/** fromUuidSync that also resolves the stand-in scene tokens. */
export function patchUuidResolver(env) {
	const original = globalThis.fromUuidSync;
	globalThis.fromUuidSync = (uuid) => {
		const match = /^Scene\.([^.]+)\.Token\.([^.]+)$/.exec(String(uuid ?? ''));
		if (match) return env.game.scenes.get(match[1])?.tokens?.get(match[2]) ?? null;
		return original(uuid);
	};
}

/** Put the character's own (linked) token on the scene. */
export function placeCaster(env, scene, actor, [gx, gy] = [0, 0]) {
	const token = addToken(env, scene, { name: actor.name, x: gx * 100, y: gy * 100, actorId: actor.id, actorLink: true }, { actor });
	actor.getActiveTokens = () => [{ id: token.id, document: token }];
	return token;
}

/** A hostile NPC token. */
export function placeEnemy(env, scene, name, [gx, gy], extra = {}) {
	const actor = { id: randomID(), name, type: 'npc', statuses: new Set(extra.statuses ?? []), effects: [], system: { attributes: { hp: { value: 10, max: 10 } } } };
	return addToken(env, scene, { name, x: gx * 100, y: gy * 100, disposition: -1 }, { actor });
}

/** A summoned Shadow token of `caster` at grid (gx, gy). */
export function placeShadow(env, scene, caster, [gx, gy], { template = 'shadow-minion', hp = 1, flags = {}, combatId } = {}) {
	const base = [...env.game.actors.values()].find((a) => a.flags?.[MODULE_ID]?.companionTemplate === template) ?? installCompanion(env, template);
	const token = addToken(
		env,
		scene,
		{
			name: base.name,
			x: gx * 100,
			y: gy * 100,
			actorId: base.id,
			flags: { [MODULE_ID]: { summon: { template, summonerActorUuid: caster.uuid, combatId: combatId ?? null, ...flags } } },
		},
		{ base },
	);
	token.actor.system.attributes.hp.value = hp;
	return token;
}

/** A started combat stand-in (id, round/turn, combatant for a turn-start). */
export function startCombat(env, { id = 'combatArena00001' } = {}) {
	const combat = { id, started: true, round: 1, turn: 0, combatants: new Collection(), previous: { round: 0, turn: null }, scene: env.scene };
	env.game.combat = combat;
	env.game.combats.set(id, combat);
	return combat;
}

/** Owned feature (raw item: its prepared identifier = the name slug) with optional item pool. */
export async function giveFeature(actor, name, { pool, current = 1, max = 1, rules = [] } = {}) {
	const flags = pool ? { nimble: { chargePools: { [pool]: { current, max, label: name } } } } : {};
	const [item] = await actor.createEmbeddedDocuments('Item', [{ name, type: 'feature', system: { rules, description: '' }, flags }]);
	return item;
}

export function poolOf(item, pool) {
	return item.flags?.nimble?.chargePools?.[pool]?.current;
}

/** A Codex magic world with a level-`level` Shadowmancer (INT/WIL/DEX mods as given). */
export async function shadowmancerWorld({ level = 1, abilities = {}, nimPlus = false } = {}) {
	const { env, main } = await setupWorld({ nimPlus });
	const h = main.__shadowmancerInvocations__;
	const { actor } = await createCharacter(env, {
		classId: 'shadowmancer',
		abilities: { intelligence: 3, will: 1, dexterity: 2, strength: 0, ...abilities },
		render: false,
	});
	if (level > 1) await actor.update({ 'system.classData.levels': Array.from({ length: level }, () => 'shadowmancer') });
	const scene = makeScene(env);
	patchUuidResolver(env);
	installCompanion(env, 'shadow-minion');
	installCompanion(env, 'greater-shadow');
	const casterToken = placeCaster(env, scene, actor);
	const summonShadow = actor.items.find((i) => i.name === 'Summon Shadow');
	const shadowBlast = actor.items.find((i) => i.name === 'Shadow Blast');
	return { env, main, h, actor, scene, casterToken, summonShadow, shadowBlast };
}

/** The caster's summoned tokens of `template` on the scene. */
export function summonsOf(scene, actor, template = 'shadow-minion') {
	return scene.tokens.filter((t) => t.flags?.[MODULE_ID]?.summon?.template === template && t.flags[MODULE_ID].summon.summonerActorUuid === actor.uuid);
}

/** Chat cards (content) posted since `from`. */
export function cards(env, from = 0) {
	return env.ChatMessage.created.slice(from);
}
