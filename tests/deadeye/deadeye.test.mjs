/**
 * Tools of the Deadeye (Cheat subclass) — scripts/main.mjs "Tools of the
 * Deadeye" section and the pack content it drives:
 *
 *   - the INT/Safe Rest and 1/Field Rest counters (native chargePool +
 *     chargeConsumer), Interceptive Shot's Reaction cost, Improviser's grant of
 *     the Improvised Weapon;
 *   - Ricochet Shot (one Sneak Attack die of the current size, second target
 *     picked from the scene, Undo card), Press the Advantage (one free follow-up
 *     that cannot chain), Impossible Angle (attack first at advantage with Nim+'s
 *     maximised Sneak Attack arm; cancel = nothing spent), Interceptive Shot
 *     (disadvantage mark tagged with the Cheat → free-attack card on a miss);
 *   - Hamstringer / Temple Strike as options of Nim+'s Sneak Attack prompt;
 *   - Master Thrower's +4 thrown range (derived data).
 *
 * The harness has no canvas, combat or item activation: the tests build a
 * minimal scene (token documents), stub `activate` on the items, and call the
 * section's functions through `main.__deadeye__`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Collection, REPO_ROOT, setupWorld } from '../harness/index.mjs';

const MODULE_ID = 'blue-codex-package';
const SYS = 'nimble';
const DEADEYE_DIR = 'pack-sources/classFeatures/the-cheat/the-cheat-subclasses/tools-of-the-deadeye';
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
const deadeye = (slug) => readJson(`${DEADEYE_DIR}/${slug}.json`);
const SNEAK_ATTACK = JSON.parse(
	fs.readFileSync(
		path.join(REPO_ROOT, '../FoundryVTT-Nimble/packs/classFeatures/core/the-cheat/the-cheat-progression/sneak-attack.json'),
		'utf-8',
	),
);
const DAGGER = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '../FoundryVTT-Nimble/packs/items/core/weapons/dagger.json'), 'utf-8'));
const IMPROVISED = readJson('pack-sources/items/the-cheat/improvised-weapon.json');

function withPool(doc, identifier, current, max) {
	const copy = structuredClone(doc);
	copy.flags ??= {};
	copy.flags[SYS] = { chargePools: { [identifier]: { current, max, label: identifier } } };
	return copy;
}

async function world({ level = 11, features = [], weapons = [DAGGER], nimPlus = null, int = 2 } = {}) {
	const { env, main } = await setupWorld();
	if (nimPlus) env.game.modules.set('nim-plus-package', { id: 'nim-plus-package', active: true, api: { cheat: nimPlus } });
	const h = main.__deadeye__;
	const items = [SNEAK_ATTACK, ...features, ...weapons].map((doc, i) => ({
		...structuredClone(doc),
		_id: `deadeyeItem${String(i).padStart(5, '0')}`,
	}));
	const actor = new env.classes.Character({
		_id: 'deadeyeCheat0001',
		name: 'Deadeye',
		type: 'character',
		system: { classData: { levels: Array(level).fill('the-cheat') }, abilities: { intelligence: { mod: int } } },
		items,
	});
	env.game.actors.set(actor.id, actor);
	const item = (name) => actor.items.find((i) => i.name === name);
	return { env, main, h, actor, item };
}

/** A scene with token documents at grid positions; `canvas.scene` points at it. */
function scene(env, entries) {
	const sc = { id: 'sceneDeadeye0001', name: 'Range', grid: { size: 100 }, tokens: new Collection() };
	env.game.scenes.set(sc.id, sc);
	globalThis.canvas.scene = sc;
	const docs = {};
	for (const [key, { name, at: [gx, gy], actor = null, disposition = -1 }] of Object.entries(entries)) {
		const doc = {
			id: `${key}Token`.padEnd(16, '0'),
			name,
			x: gx * 100,
			y: gy * 100,
			width: 1,
			height: 1,
			hidden: false,
			disposition,
			parent: sc,
			actor: actor ?? { id: `${key}Actor`.padEnd(16, '0'), type: 'npc', system: { attributes: { hp: { value: 5 } } } },
			actorId: actor?.id ?? null,
			actorLink: Boolean(actor),
			uuid: `Scene.${sc.id}.Token.${key}`,
		};
		sc.tokens.set(doc.id, doc);
		docs[key] = doc;
	}
	return docs;
}

const target = (env, ...docs) => {
	env.game.user.targets = new Set(docs.map((doc) => ({ id: doc.id, document: doc })));
};

/* ───────────────────────── content ───────────────────────── */

describe('Tools of the Deadeye content', () => {
	it.each([
		['ricochet-shot', 'ricochet-shot-uses', '@intelligence', ['safeRest']],
		['interceptive-shot', 'interceptive-shot-uses', '@intelligence', ['safeRest']],
		['impossible-angle', 'impossible-angle-uses', '1', ['fieldRest', 'safeRest']],
	])('%s: visible pool %s (max %s) + consumer', (slug, identifier, max, triggers) => {
		const rules = deadeye(slug).system.rules;
		const pool = rules.find((r) => r.type === 'chargePool');
		expect(pool).toMatchObject({ identifier, max, scope: 'item', hidden: false, initial: 'max' });
		expect(pool.recoveries.map((r) => r.trigger)).toEqual(triggers);
		expect(rules.find((r) => r.type === 'chargeConsumer')).toMatchObject({ poolIdentifier: identifier, poolScope: 'item', cost: '1' });
		expect(deadeye(slug).system.description).toContain('[A]');
	});

	it('Interceptive Shot is a 1-action Reaction (the system type), not "reaction"', () => {
		expect(deadeye('interceptive-shot').system.activation.cost).toMatchObject({ type: 'action', quantity: 1, isReaction: true });
	});

	it('Ricochet Shot rolls its own non-missing damage node', () => {
		const [node] = deadeye('ricochet-shot').system.activation.effects;
		expect(node).toMatchObject({ type: 'damage', canMiss: false, canCrit: false });
	});

	it('Improviser grants the Improvised Weapon (1d4+DEX, Light, Thrown), whose id is registered', () => {
		const [grant] = deadeye('improviser').system.rules;
		expect(grant).toMatchObject({ type: 'grantItem', uuid: `Compendium.${MODULE_ID}.blue-codex-items.Item.${IMPROVISED._id}` });
		expect(readJson('pack-sources/ids.json').items['the-cheat']['improvised-weapon']).toBe(IMPROVISED._id);
		expect(IMPROVISED.system.activation.effects[0].formula).toBe('1d4 + @dexterity');
		expect(IMPROVISED.system.properties.selected).toEqual(['light', 'thrown']);
		expect(IMPROVISED.system.objectType).toBe('weapon');
	});

	it('Temple Strike says Deafened is not a Nimble condition', () => {
		expect(deadeye('temple-strike').system.description).toContain('Deafened is not a Nimble condition');
	});
});

/* ───────────────────────── Sneak Attack dice & Ricochet die ───────────────────────── */

describe('Sneak Attack dice', () => {
	it.each([
		[7, '2d8', 8],
		[9, '2d10', 10],
		[15, '2d20', 20],
	])('level %i reads %s from the feature table; Ricochet rolls 1d%i fast-forwarded', async (level, formula, faces) => {
		const { h, actor, item } = await world({ level, features: [withPool(deadeye('ricochet-shot'), 'ricochet-shot-uses', 2, 2)] });
		expect(h.deadeyeSneakDice(actor)).toMatchObject({ formula, faces });
		const prep = await h.prepareDeadeyeActivation(item('Ricochet Shot'), { rollMode: 0 });
		expect(prep.options).toEqual({ rollMode: 0, fastForward: true, rollFormula: `1d${faces}` });
	});

	it("Nim+'s reading wins when its api is there", async () => {
		const sneakAttackDice = vi.fn(() => ({ formula: '3d20', count: 3, faces: 20 }));
		const { h, actor } = await world({ level: 3, nimPlus: { sneakAttackDice } });
		expect(h.deadeyeSneakDice(actor).formula).toBe('3d20');
	});
});

/* ───────────────────────── Master Thrower ───────────────────────── */

describe('Master Thrower', () => {
	it('thrown weapons of its owner show Thrown +4; others are untouched', async () => {
		const { h, item } = await world({ features: [deadeye('master-thrower')], weapons: [DAGGER, IMPROVISED] });
		const dagger = item('Dagger');
		h.applyMasterThrowerRange(dagger);
		expect(dagger.system.properties.thrownRange).toBe(8);
		const { h: h2, item: item2 } = await world({ weapons: [DAGGER] });
		const plain = item2('Dagger');
		h2.applyMasterThrowerRange(plain);
		expect(plain.system.properties.thrownRange).toBe(4);
	});
});

/* ───────────────────────── Nim+ Sneak Attack options ───────────────────────── */

describe('Hamstringer / Temple Strike options', () => {
	it('each forgoes ⌊dice/2⌋; the thrown box is reported to Nim+', async () => {
		const { h, actor, item } = await world({ features: [deadeye('hamstringer'), deadeye('temple-strike')] });
		const dagger = item('Dagger');
		h.deadeyeDialogState.set(dagger.uuid, { thrown: true, press: false });
		const context = { actor, item: dagger, options: [], thrown: null };
		h.addDeadeyeSneakOptions(context);
		expect(context.thrown).toBe(true);
		expect(context.options.map((o) => o.id)).toEqual(['bcx-hamstringer', 'bcx-temple-strike']);
		expect(context.options.map((o) => o.forgoDice(3))).toEqual([1, 1]);
		expect(context.options[0].forgoDice(1)).toBe(0);
	});

	it('the effects: speed 0 overrides for 1 round; Blinded + Stunned + a Deafened reminder for 2', async () => {
		const { h } = await world();
		const [ham] = h.deadeyeRiderEffects('hamstringer');
		expect(ham.duration).toEqual({ value: 1, units: 'rounds' });
		expect(ham.system.changes.map((c) => c.key)).toContain('system.attributes.movement.walk');
		expect(ham.system.changes.every((c) => c.type === 'override' && c.value === '0')).toBe(true);
		const temple = h.deadeyeRiderEffects('temple');
		expect(temple.map((e) => e.statuses ?? [])).toEqual([['blinded'], ['stunned'], []]);
		expect(temple[2].name).toContain('Deafened');
		expect(temple.every((e) => e.duration.value === 2)).toBe(true);
	});

	it('an actor without them adds nothing', async () => {
		const { h, actor } = await world();
		const context = { actor, item: null, options: [], thrown: null };
		h.addDeadeyeSneakOptions(context);
		expect(context.options).toEqual([]);
	});
});

/* ───────────────────────── Press the Advantage ───────────────────────── */

describe('Press the Advantage', () => {
	it('a hit with the box ticked makes ONE free follow-up at the same creature; it cannot chain', async () => {
		const { env, h, actor, item } = await world({ features: [deadeye('press-the-advantage')] });
		const docs = scene(env, { me: { name: 'Deadeye', at: [0, 0], actor }, goblin: { name: 'Goblin', at: [1, 0] } });
		const dagger = item('Dagger');
		const seen = [];
		dagger.activate = vi.fn(async () => {
			seen.push(Array.from(env.game.user.targets).map((t) => t.id));
			// The follow-up's own resolution: a hit that would press again.
			h.deadeyeDialogState.set(dagger.uuid, { thrown: false, press: true });
			await h.deadeyeWeaponFollowUps(dagger, { system: { isMiss: false } }, [docs.goblin]);
			return { id: 'card2', system: { isMiss: false } };
		});
		target(env, docs.goblin);
		const prep = await h.prepareDeadeyeActivation(dagger, {});
		h.deadeyeDialogState.set(dagger.uuid, { thrown: false, press: true });
		await prep.complete({ id: 'card1', system: { isMiss: false } });
		expect(dagger.activate).toHaveBeenCalledTimes(1);
		expect(seen).toEqual([[docs.goblin.id]]);
		expect(h.deadeyePressFollowUps.size).toBe(0);
	});

	it('a miss, or the box unticked, does nothing', async () => {
		const { env, h, item, actor } = await world({ features: [deadeye('press-the-advantage')] });
		const docs = scene(env, { me: { name: 'Deadeye', at: [0, 0], actor }, goblin: { name: 'Goblin', at: [1, 0] } });
		const dagger = item('Dagger');
		dagger.activate = vi.fn();
		h.deadeyeDialogState.set(dagger.uuid, { press: true });
		await h.deadeyeWeaponFollowUps(dagger, { system: { isMiss: true } }, [docs.goblin]);
		h.deadeyeDialogState.set(dagger.uuid, { press: false });
		await h.deadeyeWeaponFollowUps(dagger, { system: { isMiss: false } }, [docs.goblin]);
		expect(dagger.activate).not.toHaveBeenCalled();
	});
});

/* ───────────────────────── Ricochet Shot ───────────────────────── */

describe('Ricochet Shot', () => {
	async function ricochetWorld(current = 2) {
		const w = await world({ level: 9, features: [withPool(deadeye('ricochet-shot'), 'ricochet-shot-uses', current, 2)] });
		const docs = scene(w.env, {
			me: { name: 'Deadeye', at: [0, 0], actor: w.actor },
			goblin: { name: 'Goblin', at: [4, 0] },
			orc: { name: 'Orc', at: [6, 0] },
			far: { name: 'Far Kobold', at: [12, 0] },
			ally: { name: 'Ally', at: [5, 0], disposition: 1 },
		});
		return { ...w, docs };
	}

	it('after a thrown hit: second target picked (nearest first, out-of-range flagged), one d10 rolled, Undo card', async () => {
		const { env, h, actor, item, docs } = await ricochetWorld();
		const feature = item('Ricochet Shot');
		feature.activate = vi.fn(async () => ({ id: 'ricochetCard', targets: Array.from(env.game.user.targets).map((t) => t.id) }));
		let dialog = null;
		env.dialogs.answerWhen('Ricochet Shot', (config) => {
			dialog = config;
			return config.buttons[0].callback({}, { form: { querySelector: () => ({ value: docs.orc.id }) } }, {});
		});
		const dagger = item('Dagger');
		h.deadeyeDialogState.set(dagger.uuid, { thrown: true, press: false });
		await h.deadeyeWeaponFollowUps(dagger, { system: { isMiss: false } }, [docs.goblin]);

		expect(dialog.content).toContain('<strong>1d10</strong>');
		expect(dialog.content).not.toContain('Ally');
		expect(dialog.content.indexOf('Orc')).toBeLessThan(dialog.content.indexOf('Far Kobold'));
		expect(dialog.content).toMatch(/Far Kobold — 8 spaces[^<]*<em>\(beyond Range 4\)<\/em>/);
		expect(feature.activate).toHaveBeenCalledTimes(1);
		expect(await feature.activate.mock.results[0].value).toMatchObject({ targets: [docs.orc.id] });
		const undo = env.ChatMessage.created.at(-1);
		expect(undo.flags[MODULE_ID].undo).toMatchObject({ type: 'poolDelta', data: { poolKey: 'ricochet-shot-uses', delta: 1 } });
		expect(actor.id).toBe('deadeyeCheat0001');
	});

	it('no uses left, a melee (not thrown) hit, or "Not now": nothing happens', async () => {
		const { env, h, item, docs } = await ricochetWorld(0);
		const feature = item('Ricochet Shot');
		feature.activate = vi.fn();
		const dagger = item('Dagger');
		h.deadeyeDialogState.set(dagger.uuid, { thrown: true });
		await h.deadeyeWeaponFollowUps(dagger, { system: { isMiss: false } }, [docs.goblin]);
		expect(env.dialogs.log).toHaveLength(0);

		const w2 = await ricochetWorld(2);
		const f2 = w2.item('Ricochet Shot');
		f2.activate = vi.fn();
		const d2 = w2.item('Dagger');
		w2.h.deadeyeDialogState.set(d2.uuid, { thrown: false });
		await w2.h.deadeyeWeaponFollowUps(d2, { system: { isMiss: false } }, [w2.docs.goblin]);
		expect(w2.env.dialogs.log).toHaveLength(0);
		w2.h.deadeyeDialogState.set(d2.uuid, { thrown: true });
		w2.env.dialogs.answerWhen('Ricochet Shot', 'cancel');
		await w2.h.deadeyeWeaponFollowUps(d2, { system: { isMiss: false } }, [w2.docs.goblin]);
		expect(f2.activate).not.toHaveBeenCalled();
	});

	it('the Improvised Weapon counts as thrown with no dialog state', async () => {
		const w = await world({ level: 9, features: [withPool(deadeye('ricochet-shot'), 'ricochet-shot-uses', 1, 2)], weapons: [IMPROVISED] });
		const weapon = w.item('Improvised Weapon');
		expect(w.h.deadeyeDefaultThrown(w.actor, weapon, null)).toBe(true);
	});
});

/* ───────────────────────── Impossible Angle ───────────────────────── */

describe('Impossible Angle', () => {
	const angle = () => withPool(deadeye('impossible-angle'), 'impossible-angle-uses', 1, 1);

	it('attacks first — thrown, at advantage, with Nim+ arming the maximised Sneak Attack — then lets the feature spend its use', async () => {
		const api = { armSneakAttack: vi.fn(), disarmSneakAttack: vi.fn(), sneakAttackDice: () => ({ formula: '2d20', count: 2, faces: 20 }) };
		const { env, h, item, actor } = await world({ level: 15, features: [angle()], weapons: [IMPROVISED], nimPlus: api });
		const docs = scene(env, { me: { name: 'Deadeye', at: [0, 0], actor }, goblin: { name: 'Goblin', at: [6, 0] } });
		target(env, docs.goblin);
		const weapon = item('Improvised Weapon');
		let thrownDuring = null;
		weapon.activate = vi.fn(async () => {
			thrownDuring = h.deadeyeForcedThrown.has(weapon.uuid);
			return { id: 'attack', system: { isMiss: false } };
		});
		const prep = await h.prepareDeadeyeActivation(item('Impossible Angle'), {});
		expect(prep).toBeNull(); // proceed: the feature's own activation spends the use
		expect(weapon.activate).toHaveBeenCalledWith({ rollMode: 1 });
		expect(thrownDuring).toBe(true);
		expect(api.armSneakAttack).toHaveBeenCalledWith(weapon, expect.objectContaining({ maximize: true, consumeUse: false }));
		expect(api.disarmSneakAttack).toHaveBeenCalledWith(weapon);
		expect(h.deadeyeForcedThrown.size).toBe(0);
	});

	it('a cancelled attack blocks the feature (nothing spent); an empty counter is left to the system', async () => {
		const { h, item } = await world({ level: 15, features: [angle()], weapons: [IMPROVISED] });
		const weapon = item('Improvised Weapon');
		weapon.activate = vi.fn(async () => null);
		expect(await h.prepareDeadeyeActivation(item('Impossible Angle'), {})).toEqual({ blocked: true });

		const empty = await world({ level: 15, features: [withPool(deadeye('impossible-angle'), 'impossible-angle-uses', 0, 1)], weapons: [IMPROVISED] });
		const w2 = empty.item('Improvised Weapon');
		w2.activate = vi.fn();
		expect(await empty.h.prepareDeadeyeActivation(empty.item('Impossible Angle'), {})).toBeNull();
		expect(w2.activate).not.toHaveBeenCalled();
	});

	it('several thrown weapons: asked; without Nim+ a hit posts the maximum as a reminder', async () => {
		const { env, h, item } = await world({ level: 17, features: [angle()], weapons: [DAGGER, IMPROVISED] });
		const weapon = item('Improvised Weapon');
		weapon.activate = vi.fn(async () => ({ id: 'attack', system: { isMiss: false } }));
		env.dialogs.answerWhen('Impossible Angle', (config) =>
			config.buttons[0].callback({}, { form: { querySelector: () => ({ value: weapon.id }) } }, {}),
		);
		expect(await h.prepareDeadeyeActivation(item('Impossible Angle'), {})).toBeNull();
		expect(weapon.activate).toHaveBeenCalledTimes(1);
		expect(env.ChatMessage.created.at(-1).content).toContain('3d20 = <strong>60</strong>');
	});

	it('no thrown weapon: warned and blocked', async () => {
		const { env, h, item } = await world({ level: 15, features: [angle()], weapons: [] });
		expect(await h.prepareDeadeyeActivation(item('Impossible Angle'), {})).toEqual({ blocked: true });
		expect(env.notifications.warn).toHaveBeenCalled();
	});
});

/* ───────────────────────── Interceptive Shot ───────────────────────── */

describe('Interceptive Shot', () => {
	function npc(env) {
		const actor = new env.classes.Actor({ _id: 'goblinActor00001', name: 'Goblin Archer', type: 'npc', system: {} });
		actor.createdEffects = [];
		actor.createEmbeddedDocuments = async (name, data) => {
			actor.createdEffects.push(...data);
			return data.map((d, i) => ({ ...d, id: `effect${i}` }));
		};
		env.game.actors.set(actor.id, actor);
		return actor;
	}

	it('needs a target (blocked otherwise); marks the attacker with a tagged disadvantage mark', async () => {
		const { env, h, item, actor } = await world({ features: [withPool(deadeye('interceptive-shot'), 'interceptive-shot-uses', 2, 2)] });
		const feature = item('Interceptive Shot');
		env.game.user.targets = new Set();
		expect(await h.prepareDeadeyeActivation(feature, {})).toEqual({ blocked: true });

		const goblin = npc(env);
		await h.handleDeadeyeUseItem(feature, { targets: [{ document: { uuid: goblin.uuid } }] });
		const [mark] = goblin.createdEffects;
		expect(mark.flags[MODULE_ID]).toMatchObject({
			disadvantageNextAttack: true,
			[h.DEADEYE_INTERCEPT_FLAG]: { cheatUuid: actor.uuid },
		});
		expect(env.ChatMessage.created.at(-1).content).toContain("next attack has disadvantage");
	});

	it('when the marked attack misses, a free-attack card for the Cheat is posted; a hit posts nothing', async () => {
		const { env, h, actor } = await world({ features: [deadeye('interceptive-shot')] });
		const goblin = npc(env);
		const marks = [{ flags: { [MODULE_ID]: { [h.DEADEYE_INTERCEPT_FLAG]: { cheatUuid: actor.uuid } } } }];
		const attack = { actor: goblin };
		await h.notifyInterceptiveMiss(attack, marks, { system: { isMiss: false } });
		const before = env.ChatMessage.created.length;
		await h.notifyInterceptiveMiss(attack, marks, { system: { isMiss: true } });
		expect(env.ChatMessage.created.length).toBe(before + 1);
		const card = env.ChatMessage.created.at(-1);
		expect(card.content).toContain('data-bcx-intercept');
		expect(card.flags[MODULE_ID][h.DEADEYE_INTERCEPT_FLAG]).toMatchObject({ cheatUuid: actor.uuid, done: false });
	});

	it('the card button makes the free thrown attack at the attacker and marks the card done', async () => {
		const { env, h, item, actor } = await world({ features: [deadeye('interceptive-shot')], weapons: [DAGGER] });
		const dagger = item('Dagger');
		dagger.activate = vi.fn(async () => ({ id: 'free', system: { isMiss: false } }));
		const updates = [];
		const message = {
			id: 'msgIntercept0001',
			isAuthor: true,
			flags: { [MODULE_ID]: { [h.DEADEYE_INTERCEPT_FLAG]: { cheatUuid: actor.uuid, attackerTokenUuid: null, done: false } } },
			update: async (data) => updates.push(data),
		};
		expect(await h.interceptFreeAttack(message)).toBe(true);
		expect(dagger.activate).toHaveBeenCalledTimes(1);
		expect(updates[0]).toEqual({ [`flags.${MODULE_ID}.${h.DEADEYE_INTERCEPT_FLAG}.done`]: true });
	});
});
