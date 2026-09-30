/**
 * Shadowmancer 0.2 invocations + Pact of the Id on the Codex Shadow tokens
 * (scripts/main.mjs "Shadowmancer invocations & Pact of the Id", plus the
 * Pilfered Power / summon-framework seams they plug into):
 *   Know Your Limits (Shadow Limit +WIL, free Shadow at turn start), Hyperfixation
 *   and Shadow Spear advantage, Codex Shadow Blast (the official 0.2 card),
 *   Hungering Shadows, Greedy Pact / overdraft, Armor of Shadows, My Favored Pet,
 *   Eldritch Usurper's Greater Shadow, Dire Shadows, Defense Mechanism, Unified
 *   Psyche, and the Codex featureNotes (Conduit of Shadow, Shadowmastery).
 *
 * Features are owned as plain feature items (their prepared identifier is the
 * name slug, which is all main.mjs matches on); native pools are the item flags
 * Nimble would sync. Scene/token/combat stand-ins: ../summons/helpers.mjs.
 */
import { describe, expect, it, vi } from 'vitest';
import { findDoc, setupWorld } from '../harness/index.mjs';
import {
	cards,
	giveFeature,
	MODULE_ID,
	placeEnemy,
	placeShadow,
	poolOf,
	shadowmancerWorld,
	startCombat,
	summonsOf,
} from '../summons/helpers.mjs';
import { NP_CONDUIT, SYS_SHADOWMASTERY } from './helpers.mjs';

const summonFlag = (item) => item.flags[MODULE_ID].automation.summon;
const undoCards = (env, from, type) => cards(env, from).filter((c) => c.flags?.[MODULE_ID]?.undo?.type === type);
const target = (env, ...docs) => {
	env.game.user.targets = new Set(docs.map((doc) => ({ id: doc.id, document: doc })));
};
async function tieredSpell(actor, name = 'Leeching Test') {
	const [spell] = await actor.createEmbeddedDocuments('Item', [
		{ name, type: 'spell', system: { tier: 1, school: 'shadow', activation: { effects: [] } } },
	]);
	return spell;
}

describe('Know Your Limits (Pact of the Id, L11)', () => {
	it('raises the Shadow Limit by WIL (D1): the cast is no longer refused at INT Shadows', async () => {
		const { env, h, actor, scene, summonShadow } = await shadowmancerWorld({ level: 11, abilities: { intelligence: 3, will: 2 } });
		startCombat(env);
		expect(h.summonCountCap(actor, summonFlag(summonShadow))).toBe(3);
		for (let i = 0; i < 3; i += 1) placeShadow(env, scene, actor, [1, i]);
		await expect(h.summonActivationBlocked(summonShadow)).resolves.toBe(true);
		await giveFeature(actor, 'Know Your Limits');
		expect(h.summonCountCap(actor, summonFlag(summonShadow))).toBe(5);
		await expect(h.summonActivationBlocked(summonShadow)).resolves.toBe(false);
	});

	it('summons a free Shadow at the start of the owner turn (Undo card dismisses it); once per turn, forward only', async () => {
		const { env, h, actor, scene, casterToken } = await shadowmancerWorld({ level: 11 });
		await giveFeature(actor, 'Know Your Limits');
		const combat = startCombat(env);
		combat.combatant = { id: 'casterCombatant0', actor, token: casterToken };
		const before = env.ChatMessage.created.length;
		await h.onKnowYourLimitsTurnStart(combat, { round: 1, turn: 0 });
		const [shadow] = summonsOf(scene, actor);
		expect(shadow).toBeTruthy();
		expect(shadow.flags[MODULE_ID].summon.combatId).toBe(combat.id);
		expect(Math.abs(shadow.x - casterToken.x) + Math.abs(shadow.y - casterToken.y)).toBeLessThanOrEqual(200);
		const [card] = undoCards(env, before, 'dismissSummonTokens');
		expect(card.content).toMatch(/free <strong>Shadow Minion<\/strong> at the start of their turn \(1\/4 Shadows\)/);
		// Same turn again: nothing. A rewind: nothing.
		await h.onKnowYourLimitsTurnStart(combat, { round: 1, turn: 0 });
		combat.previous = { round: 2, turn: 0 };
		await h.onKnowYourLimitsTurnStart(combat, { round: 1 });
		expect(summonsOf(scene, actor)).toHaveLength(1);
		// Undo removes it.
		await h.UNDO_HANDLERS.get('dismissSummonTokens')(card.flags[MODULE_ID].undo.data, {});
		expect(summonsOf(scene, actor)).toHaveLength(0);
	});

	it('does nothing without the feature, at the limit, or on a player client', async () => {
		const { env, h, actor, scene, casterToken } = await shadowmancerWorld({ level: 11, abilities: { intelligence: 1, will: 0 } });
		const combat = startCombat(env);
		combat.combatant = { id: 'casterCombatant0', actor, token: casterToken };
		await expect(h.knowYourLimitsFreeSummon(combat.combatant, combat)).resolves.toBeNull();
		await giveFeature(actor, 'Know Your Limits');
		placeShadow(env, scene, actor, [3, 3]);
		await expect(h.knowYourLimitsFreeSummon(combat.combatant, combat)).resolves.toBeNull();
		env.setUser({ isGM: false });
		await expect(h.onKnowYourLimitsTurnStart(combat, { round: 2, turn: 0 })).resolves.toBeNull();
		expect(summonsOf(scene, actor)).toHaveLength(1);
	});
});

describe('Hyperfixation / Shadow Spear: advantage at roll time', () => {
	it('+1 advantage per living Shadow adjacent to the target (only with Hyperfixation, only attacks)', async () => {
		const { env, h, actor, scene, shadowBlast } = await shadowmancerWorld({ level: 7 });
		const goblin = placeEnemy(env, scene, 'Goblin', [5, 5]);
		placeShadow(env, scene, actor, [4, 5]);
		placeShadow(env, scene, actor, [6, 6]);
		placeShadow(env, scene, actor, [5, 4], { hp: 0 }); // dead: no stack
		placeShadow(env, scene, actor, [8, 8]); // too far
		expect(h.shadowmancerAttackAdvantage(shadowBlast, goblin).stacks).toBe(0);
		await giveFeature(actor, 'Hyperfixation');
		const bonus = h.shadowmancerAttackAdvantage(shadowBlast, goblin);
		expect(bonus.stacks).toBe(2);
		expect(bonus.notes[0]).toMatch(/Hyperfixation: \+2 advantage \(2 Shadows next to Goblin\)/);
		const summon = actor.items.find((i) => i.name === 'Summon Shadow');
		expect(h.shadowmancerAttackAdvantage(summon, goblin).stacks).toBe(0); // not an attack
	});

	it('the activate wrap pre-sets the roll mode (Hyperfixation + Shadow Spear vs Prone)', async () => {
		const { env, h, actor, scene, shadowBlast } = await shadowmancerWorld({ level: 7 });
		await giveFeature(actor, 'Hyperfixation');
		await giveFeature(actor, 'Shadow Spear');
		const goblin = placeEnemy(env, scene, 'Goblin', [5, 5], { statuses: ['prone'] });
		placeShadow(env, scene, actor, [4, 5]);
		target(env, goblin);
		const seen = [];
		const original = vi.fn(async (opts) => {
			seen.push(opts.rollMode ?? 0);
			return { id: 'card' };
		});
		shadowBlast.activate = (opts) => h.runWrappedActivate.call(shadowBlast, original, opts);
		await shadowBlast.activate({ rollMode: 0 });
		expect(seen).toEqual([2]); // one blast (the official card has no extra blasts)
		expect(env.notifications.messages('info').at(-1)).toMatch(/Hyperfixation: \+1 advantage.*Shadow Spear: advantage vs Prone Goblin/);
	});
});

describe('Codex Shadow Blast: the official 0.2 card', () => {
	async function blastWorld(level) {
		const w = await shadowmancerWorld({ level });
		const calls = [];
		const original = vi.fn(async (opts) => {
			calls.push({ targets: [...w.env.game.user.targets].map((t) => t.document?.name ?? t.name), rollMode: opts.rollMode ?? 0 });
			return { id: `card${calls.length}` };
		});
		w.shadowBlast.activate = (opts) => w.h.runWrappedActivate.call(w.shadowBlast, original, opts);
		return { ...w, calls, original };
	}

	it('the Codex doc is 1d12+DEX, +1d12 every 5 levels, with no extra-blast flag', async () => {
		const { shadowBlast } = await shadowmancerWorld();
		expect(shadowBlast.flags[MODULE_ID]?.automation?.repeatsTimes).toBeUndefined();
		expect(shadowBlast.system.activation.effects[0].formula).toBe('1d12 + @dexterity + (floor(@level / 5))d12');
		expect(shadowBlast.system.description.baseEffect).toMatch(/1d12\+DEX \(1\/round\)/);
		expect(shadowBlast.system.description.higherLevelEffect).toMatch(/\+1d12 every 5 levels/);
	});

	it('level 20 with two targets: still a single attack', async () => {
		const { env, scene, calls, shadowBlast } = await blastWorld(20);
		target(env, placeEnemy(env, scene, 'Goblin A', [5, 0]), placeEnemy(env, scene, 'Goblin B', [6, 0]));
		await shadowBlast.activate({});
		expect(calls).toHaveLength(1);
	});

	it('Repelling Blast / Shadow Spear reminders on a single blast', async () => {
		const { env, actor, scene, shadowBlast } = await blastWorld(1);
		await giveFeature(actor, 'Repelling Blast');
		target(env, placeEnemy(env, scene, 'Goblin', [5, 0]));
		const before = env.ChatMessage.created.length;
		await shadowBlast.activate({});
		expect(cards(env, before).at(-1).content).toMatch(/Repelling Blast:<\/strong> each hit knocks the target back 2/);
	});
});

/*
 * Pilfered Power since Nimble system 0.9: the class declares it
 * (spellcasting.cost = 1 charge of the `pilfered-power` pool, half-max-HP
 * overdraft up to class level 11, cast at the highest tier), and the system
 * charges the pool and deals the backlash itself. Blue Codex's mana model
 * stands down; only Hungering Shadows and Greedy Pact are layered on top. The
 * system's own payment is simulated in these tests (a pool write / HP loss
 * between the pre-cast plan and the useItem settle).
 */
const PILFERED = 'pilfered-power';
async function pilferedPool(actor, current, max = 2) {
	return giveFeature(actor, 'Pilfered Power', { pool: PILFERED, current, max });
}
async function masterOfDarkness(actor) {
	const { doc } = findDoc({ pack: 'nimble.nimble-class-features', name: 'Master of Darkness', type: 'feature', class: 'shadowmancer' });
	const source = structuredClone(doc);
	delete source._id;
	await actor.createEmbeddedDocuments('Item', [source]);
}
async function setPool(item, current) {
	await item.update({ [`flags.nimble.chargePools.${PILFERED}.current`]: current });
}

describe('Hungering Shadows', () => {
	const maxRoll = { terms: [{ faces: 12, results: [{ result: 12, active: true }] }] };
	const lowRoll = { terms: [{ faces: 12, results: [{ result: 4, active: true }] }] };

	it("a Shadow's max roll banks the free cast (Undo card); the next tiered cast gets its Pilfered Power charge back", async () => {
		const { env, h, actor, scene } = await shadowmancerWorld({ level: 14 });
		const hungering = await giveFeature(actor, 'Hungering Shadows', { pool: 'hungering-shadows', current: 0, max: 1 });
		const pilfered = await pilferedPool(actor, 2);
		const shadow = placeShadow(env, scene, actor, [1, 0]);
		const goblin = placeEnemy(env, scene, 'Goblin', [2, 0]);
		await h.maybeSwarmFromMinionAttack(shadow, [lowRoll], goblin, scene);
		expect(poolOf(hungering, 'hungering-shadows')).toBe(0);
		const before = env.ChatMessage.created.length;
		await h.maybeSwarmFromMinionAttack(shadow, [maxRoll], goblin, scene);
		expect(poolOf(hungering, 'hungering-shadows')).toBe(1);
		expect(undoCards(env, before, 'poolDelta')[0].content).toMatch(/regained <strong>1 Hungering Shadows free cast<\/strong> \(Shadow Minion rolled the max\)/);

		const spell = await tieredSpell(actor);
		const plan = await h.preparePilferedPowerCast(spell);
		expect(plan).toMatchObject({ free: true, overdraft: false });
		expect(plan.bumpedPool).toBeUndefined();
		expect(h.onSpellPreUse(spell, {})).toBe(true);
		await setPool(pilfered, 1); // the system's own charge
		await h.applyShadowmancerFlatCost(spell, {});
		expect(poolOf(pilfered, PILFERED)).toBe(2);
		expect(poolOf(hungering, 'hungering-shadows')).toBe(0);
		// Next cast pays: nothing given back.
		await h.preparePilferedPowerCast(spell);
		await setPool(pilfered, 1);
		await h.applyShadowmancerFlatCost(spell, {});
		expect(poolOf(pilfered, PILFERED)).toBe(1);
	});

	it('a free cast at 0 Pilfered Power tops the pool up first, so the system does not overdraw', async () => {
		const { h, actor } = await shadowmancerWorld({ level: 5 });
		const hungering = await giveFeature(actor, 'Hungering Shadows', { pool: 'hungering-shadows', current: 1, max: 1 });
		const pilfered = await pilferedPool(actor, 0);
		const spell = await tieredSpell(actor);
		const plan = await h.preparePilferedPowerCast(spell);
		expect(plan).toMatchObject({ free: true, overdraft: false, bumpedPool: { before: 0 } });
		expect(poolOf(pilfered, PILFERED)).toBe(1);
		await setPool(pilfered, 0); // the system's charge
		await h.applyShadowmancerFlatCost(spell, {});
		expect(poolOf(pilfered, PILFERED)).toBe(0);
		expect(poolOf(hungering, 'hungering-shadows')).toBe(0);
		expect(actor.system.attributes.hp.value).toBe(10);
	});

	it('a cancelled free cast gives the top-up back and keeps the free cast', async () => {
		const { h, actor } = await shadowmancerWorld({ level: 5 });
		const hungering = await giveFeature(actor, 'Hungering Shadows', { pool: 'hungering-shadows', current: 1, max: 1 });
		const pilfered = await pilferedPool(actor, 0);
		const spell = await tieredSpell(actor);
		await h.runWrappedActivate.call(spell, async () => null, {});
		expect(poolOf(pilfered, PILFERED)).toBe(0);
		expect(poolOf(hungering, 'hungering-shadows')).toBe(1);
		expect(h.shadowmancerCastPlans.has(actor.uuid)).toBe(false);
	});
});

describe('Pilfered Power overdraft + Greedy Pact (D2)', () => {
	it('the legacy mana model stands down: no mana snapshot, no mana writes, no backlash of its own', async () => {
		const { env, h, actor } = await shadowmancerWorld({ level: 5 });
		await pilferedPool(actor, 0);
		const spell = await tieredSpell(actor);
		const plan = await h.preparePilferedPowerCast(spell);
		expect(plan).toMatchObject({ overdraft: true, damage: 5, save: null });
		expect(env.notifications.messages('warn').at(-1)).toMatch(/no Pilfered Power left.*5 damage \(half max HP\)/);
		const context = { upcast: { manaSpent: 3 } };
		h.onSpellPreUse(spell, context);
		expect(context.upcast.manaSpent).toBe(3);
		expect(h.shadowmancerPreCastMana.has(actor.uuid)).toBe(false);
		const before = env.ChatMessage.created.length;
		await actor.update({ 'system.attributes.hp.value': 5 }); // the system's backlash
		await h.applyShadowmancerFlatCost(spell, {});
		expect(actor.system.attributes.hp.value).toBe(5);
		expect(actor.system.resources.mana.current).toBe(0);
		expect(undoCards(env, before, 'patronBacklash')).toEqual([]);
	});

	it('past class level 11 the system settles the backlash at the table: no overdraft plan, no Greedy save', async () => {
		const { h, actor } = await shadowmancerWorld({ level: 12 });
		await giveFeature(actor, 'Greedy Pact');
		await pilferedPool(actor, 0);
		actor.rollSavingThrowToChat = vi.fn(async () => ({ rolls: [{ total: 15 }] }));
		const plan = await h.preparePilferedPowerCast(await tieredSpell(actor));
		expect(plan.overdraft).toBe(false);
		expect(actor.rollSavingThrowToChat).not.toHaveBeenCalled();
	});

	it.each([
		[5, 20, false, 20],
		[14, 10, false, 30],
		[21, 0, true, 40],
	])('Greedy Pact: STR save %i → %i damage (tier bump %s): the rest of the system backlash comes back', async (total, damage, bump, hpAfter) => {
		const { env, h, actor } = await shadowmancerWorld({ level: 10 });
		await actor.update({ 'system.attributes.hp.max': 40, 'system.attributes.hp.value': 40 });
		await giveFeature(actor, 'Greedy pact');
		await pilferedPool(actor, 0);
		actor.rollSavingThrowToChat = vi.fn(async () => ({ rolls: [{ total }] }));
		const spell = await tieredSpell(actor);
		const plan = await h.preparePilferedPowerCast(spell);
		expect(actor.rollSavingThrowToChat).toHaveBeenCalledWith('strength', {});
		expect(plan).toMatchObject({ overdraft: true, damage, tierBump: bump, save: { total }, fullDamage: 20 });
		const before = env.ChatMessage.created.length;
		await actor.update({ 'system.attributes.hp.value': 20 }); // the system's half-max-HP backlash
		await h.applyShadowmancerFlatCost(spell, {});
		expect(actor.system.attributes.hp.value).toBe(hpAfter);
		expect(cards(env, before).at(-1).content).toMatch(new RegExp(`Greedy Pact — STR save <strong>${total}</strong>`));
		expect(h.greedyPactSaves.has(actor.uuid)).toBe(false);
	});

	it('Greedy Pact: dismissing the save cancels the cast; a cancelled spell keeps the save banked (no reroll)', async () => {
		const { h, actor } = await shadowmancerWorld({ level: 10 });
		await giveFeature(actor, 'Greedy Pact');
		await pilferedPool(actor, 0);
		const spell = await tieredSpell(actor);
		actor.rollSavingThrowToChat = vi.fn(async () => null);
		await expect(h.preparePilferedPowerCast(spell)).resolves.toEqual({ blocked: true });
		actor.rollSavingThrowToChat = vi.fn(async () => ({ rolls: [{ total: 3 }] }));
		await h.preparePilferedPowerCast(spell);
		await h.preparePilferedPowerCast(spell); // the spell dialog was cancelled; cast again
		expect(actor.rollSavingThrowToChat).toHaveBeenCalledTimes(1);
	});

	it('Greedy Pact 20+: the wrap raises the system-pinned tier by one for the cast, then restores it', async () => {
		const { h, actor } = await shadowmancerWorld({ level: 5 });
		await masterOfDarkness(actor);
		await giveFeature(actor, 'Greedy Pact');
		await pilferedPool(actor, 0);
		actor.rollSavingThrowToChat = vi.fn(async () => ({ rolls: [{ total: 22 }] }));
		const spell = await tieredSpell(actor);
		actor.prepareData();
		expect(actor.system.resources.highestUnlockedSpellTier).toBe(2);
		let during = null;
		await h.runWrappedActivate.call(spell, async () => {
			during = { tier: actor.system.resources.highestUnlockedSpellTier, mana: actor.system.resources.mana.current };
			return null; // dialog cancelled
		}, {});
		expect(during).toEqual({ tier: 3, mana: 0 });
		expect(actor.system.resources.highestUnlockedSpellTier).toBe(2);
		expect(h.shadowmancerCastPlans.has(actor.uuid)).toBe(false);
	});
});

describe('Armor of Shadows', () => {
	it('damage reduction = living summoned minions, kept current as Shadows come and go', async () => {
		const { env, actor, scene } = await shadowmancerWorld({ level: 18 });
		const reduction = () => (actor.system.damageReductions ?? []).filter((r) => r.label?.startsWith('Armor of Shadows'));
		const a = placeShadow(env, scene, actor, [1, 0]);
		actor.prepareData();
		expect(reduction()).toEqual([]);
		await giveFeature(actor, 'Armor of Shadows');
		expect(reduction()).toEqual([expect.objectContaining({ value: 1, mode: 'flat', damageTypes: [] })]);
		placeShadow(env, scene, actor, [1, 1]);
		const dying = placeShadow(env, scene, actor, [1, 2]);
		expect(reduction()).toEqual([expect.objectContaining({ value: 3, label: 'Armor of Shadows (3 minions)' })]);
		await dying.actor.update({ 'system.attributes.hp.value': 0 }); // dead: no longer counted
		expect(reduction()).toEqual([expect.objectContaining({ value: 2, label: 'Armor of Shadows (2 minions)' })]);
		actor.prepareData();
		actor.prepareData();
		expect(reduction()).toHaveLength(1);
		await a.delete();
		expect(reduction()).toEqual([expect.objectContaining({ value: 1 })]);
	});
});

describe('My Favored Pet (D9)', () => {
	it('outside combat: one pet Shadow may be summoned (no combat tag), a second is refused', async () => {
		const { env, h, actor, scene, summonShadow } = await shadowmancerWorld({ level: 10 });
		await expect(h.summonActivationBlocked(summonShadow)).resolves.toBe(true);
		expect(env.notifications.messages('warn').at(-1)).toMatch(/can only be cast during combat/);
		await giveFeature(actor, 'My Favored Pet');
		await expect(h.summonActivationBlocked(summonShadow)).resolves.toBe(false);
		await h.handleSummonSpawn(summonShadow, {});
		const pets = summonsOf(scene, actor);
		expect(pets).toHaveLength(1); // not the 3 a level-10 cast brings in combat
		expect(pets[0].flags[MODULE_ID].summon).toMatchObject({ favoredPet: true, combatId: null });
		await expect(h.summonActivationBlocked(summonShadow)).resolves.toBe(true);
		expect(env.notifications.messages('warn').at(-1)).toMatch(/already has a favored pet Shadow/);
	});

	it('combat end keeps one living Shadow as the pet; the rest vanish', async () => {
		const { env, h, actor, scene } = await shadowmancerWorld({ level: 10 });
		const combat = startCombat(env);
		const dead = placeShadow(env, scene, actor, [1, 0], { combatId: combat.id, hp: 0 });
		const alive = placeShadow(env, scene, actor, [1, 1], { combatId: combat.id });
		placeShadow(env, scene, actor, [1, 2], { combatId: combat.id });
		await giveFeature(actor, 'My Favored Pet');
		await h.cleanupCombatSummons(combat);
		const left = summonsOf(scene, actor);
		expect(left.map((t) => t.id)).toEqual([alive.id]);
		expect(left[0].flags[MODULE_ID].summon).toMatchObject({ favoredPet: true, combatId: null });
		expect(scene.tokens.get(dead.id)).toBeUndefined();
		// Next fight: the pet already exists, so every combat Shadow vanishes.
		const next = startCombat(env, { id: 'combatArena00002' });
		placeShadow(env, scene, actor, [2, 2], { combatId: next.id });
		await h.cleanupCombatSummons(next);
		expect(summonsOf(scene, actor).map((t) => t.id)).toEqual([alive.id]);
	});

	it('without the feature every combat Shadow vanishes', async () => {
		const { env, h, actor, scene } = await shadowmancerWorld();
		const combat = startCombat(env);
		placeShadow(env, scene, actor, [1, 1], { combatId: combat.id });
		await h.cleanupCombatSummons(combat);
		expect(summonsOf(scene, actor)).toEqual([]);
	});
});

describe('Eldritch Usurper: the Greater Shadow (0.2, L20)', () => {
	async function usurperWorld() {
		const w = await shadowmancerWorld({ level: 20, abilities: { intelligence: 5 } });
		startCombat(w.env);
		w.usurper = await giveFeature(w.actor, 'Eldritch Usurper', { pool: 'eldritch-usurper', current: 1, max: 1 });
		return w;
	}

	it('Summon Shadow offers it; choosing it spawns the 5d12 Greater Shadow and spends the charge (Undo card)', async () => {
		const { env, h, actor, scene, summonShadow, usurper } = await usurperWorld();
		env.dialogs.answerWhen(/Eldritch Usurper/, 'greater');
		await expect(h.summonActivationBlocked(summonShadow)).resolves.toBe(false);
		const before = env.ChatMessage.created.length;
		await h.handleSummonSpawn(summonShadow, {});
		const [greater] = summonsOf(scene, actor, 'greater-shadow');
		expect(greater.name).toBe('Greater Shadow');
		expect(greater.actor.items[0].system.activation.effects[0].formula).toBe('5d12');
		expect(summonsOf(scene, actor)).toHaveLength(0);
		expect(poolOf(usurper, 'eldritch-usurper')).toBe(0);
		expect(undoCards(env, before, 'poolDelta')[0].content).toMatch(/spent <strong>1 Eldritch Usurper: Greater Shadow<\/strong>/);
		// No charge left: no offer.
		const asked = env.dialogs.log.length;
		await h.summonActivationBlocked(summonShadow);
		expect(env.dialogs.log.length).toBe(asked);
	});

	it('choosing Shadows keeps the charge; closing the offer cancels the cast', async () => {
		const { env, h, actor, scene, summonShadow, usurper } = await usurperWorld();
		env.dialogs.answerWhen(/Eldritch Usurper/, 'shadows');
		await expect(h.summonActivationBlocked(summonShadow)).resolves.toBe(false);
		await h.handleSummonSpawn(summonShadow, {});
		expect(summonsOf(scene, actor)).toHaveLength(5);
		expect(poolOf(usurper, 'eldritch-usurper')).toBe(1);
		env.dialogs.answerWhen(/Eldritch Usurper/, null);
		for (const t of summonsOf(scene, actor)) await t.delete();
		await expect(h.summonActivationBlocked(summonShadow)).resolves.toBe(true);
	});

	it('Shadow Magus d10 stays five dice on the Greater Shadow', async () => {
		const { h, summonShadow } = await usurperWorld();
		const config = h.greaterShadowSummonConfig(summonFlag(summonShadow));
		expect(config.template).toBe('greater-shadow');
		expect(config.featureBoosts.find((b) => b.name === 'Shadow Magus').formulaOverride).toBe('5d10');
	});

	it('using the feature itself (its chargeConsumer pays) summons one in combat; refused outside combat', async () => {
		const { env, h, actor, scene, usurper } = await usurperWorld();
		await expect(h.shadowmancerFeatureActivationBlocked(usurper)).resolves.toBe(false);
		await h.handleShadowmancerFeatureUsed(usurper);
		expect(summonsOf(scene, actor, 'greater-shadow')).toHaveLength(1);
		expect(poolOf(usurper, 'eldritch-usurper')).toBe(1); // the system consumer spends it, not the module
		env.game.combat = null;
		await expect(h.shadowmancerFeatureActivationBlocked(usurper)).resolves.toBe(true);
	});
});

describe('Shadow Rush (Command Shadows)', () => {
	it('a rushing Shadow deals its max (flat, no roll) and dies; the others roll as usual', async () => {
		const { env, main, actor, scene } = await shadowmancerWorld({ level: 9 });
		await giveFeature(actor, 'Shadow Rush');
		const cs = main.__commandShadows__;
		const command = actor.items.find((i) => i.name === 'Command Shadows');
		const rusher = placeShadow(env, scene, actor, [1, 0]);
		const roller = placeShadow(env, scene, actor, [1, 1]);
		const formulas = {};
		for (const shadow of [rusher, roller]) {
			shadow.actor.items[0].activate = vi.fn(async function activate() {
				formulas[shadow.id] = this.system.activation.effects[0].formula;
				return { id: 'card' };
			});
		}
		target(env, placeEnemy(env, scene, 'Goblin', [2, 0]));
		let offered = null;
		env.dialogs.answerWhen(/Command Shadows/, (config) => {
			offered = config.content;
			return { picks: [0, 0], rush: [true, false] };
		});
		expect(await cs.commandShadowsActivationBlocked(command)).toBe(false);
		expect(offered).toMatch(/bcx-rush-0/); // offered even with a single target
		const before = env.ChatMessage.created.length;
		const summary = await cs.handleCommandShadowsUsed(command, {});
		expect(formulas).toEqual({ [rusher.id]: '12', [roller.id]: '1d12' });
		expect(scene.tokens.get(rusher.id)).toBeUndefined();
		expect(scene.tokens.get(roller.id)).toBeTruthy();
		expect(summary.rushed).toEqual(['Shadow Minion']);
		expect(cards(env, before).at(-1).content).toMatch(/Shadow Rush:<\/strong> 1 Shadow dealt max damage, then died/);
	});

	it('without the invocation a single-target command asks nothing', async () => {
		const { env, main, actor, scene } = await shadowmancerWorld();
		const command = actor.items.find((i) => i.name === 'Command Shadows');
		placeShadow(env, scene, actor, [1, 0]);
		target(env, placeEnemy(env, scene, 'Goblin', [2, 0]));
		expect(await main.__commandShadows__.commandShadowsActivationBlocked(command)).toBe(false);
		expect(env.dialogs.log).toEqual([]);
	});
});

describe('Dire Shadows', () => {
	it('spawned Shadows carry a modifyIncomingAttack(disadvantage) feature', async () => {
		const { env, h, actor, scene, summonShadow } = await shadowmancerWorld({ level: 17 });
		startCombat(env);
		await giveFeature(actor, 'Dire Shadows');
		await h.handleSummonSpawn(summonShadow, {});
		const shadows = summonsOf(scene, actor);
		expect(shadows.length).toBeGreaterThan(0);
		for (const shadow of shadows) {
			const dire = shadow.actor.items.find((i) => i.name === 'Dire Shadows');
			expect(dire.type).toBe('monsterFeature');
			expect(dire.system.rules).toEqual([expect.objectContaining({ type: 'modifyIncomingAttack', modifier: 'disadvantage' })]);
		}
	});
});

describe('Defense Mechanism (Pact of the Id, L3)', () => {
	it('swaps places with the only Shadow (no prompt) and tells the GM where the attack lands', async () => {
		const { env, h, actor, scene, casterToken } = await shadowmancerWorld({ level: 3 });
		const dm = await giveFeature(actor, 'Defense Mechanism', { pool: 'defense-mechanism' });
		const shadow = placeShadow(env, scene, actor, [3, 2]);
		await expect(h.shadowmancerFeatureActivationBlocked(dm)).resolves.toBe(false);
		expect(env.dialogs.log).toEqual([]);
		const before = env.ChatMessage.created.length;
		await h.handleShadowmancerFeatureUsed(dm);
		expect([casterToken.x, casterToken.y, shadow.x, shadow.y]).toEqual([300, 200, 0, 0]);
		expect(cards(env, before).at(-1).content).toMatch(/Reaction.*hits Shadow Minion instead/);
	});

	it('several Shadows: a pick (nearest pre-selected); none: refused; empty pool: left to the system', async () => {
		const { env, h, actor, scene } = await shadowmancerWorld({ level: 3 });
		const dm = await giveFeature(actor, 'Defense Mechanism', { pool: 'defense-mechanism' });
		await expect(h.shadowmancerFeatureActivationBlocked(dm)).resolves.toBe(true);
		expect(env.notifications.messages('warn').at(-1)).toMatch(/has no Shadow on this scene/);
		placeShadow(env, scene, actor, [5, 5]);
		const near = placeShadow(env, scene, actor, [1, 0]);
		env.dialogs.answerWhen(/Defense Mechanism/, 'confirm');
		await expect(h.shadowmancerFeatureActivationBlocked(dm)).resolves.toBe(false);
		expect(h.pendingShadowmancerFeatures.get(dm.uuid).shadowId).toBe(near.id);
		await dm.update({ 'flags.nimble.chargePools.defense-mechanism.current': 0 });
		await expect(h.shadowmancerFeatureActivationBlocked(dm)).resolves.toBe(false);
		expect(h.pendingShadowmancerFeatures.has(dm.uuid)).toBe(false);
	});
});

describe('Unified Psyche (Pact of the Id, L15)', () => {
	it('per Shadow: dispel it, teleport onto its space, free attack at the nearest enemy; one summary card', async () => {
		const { env, h, actor, scene, casterToken } = await shadowmancerWorld({ level: 15 });
		const up = await giveFeature(actor, 'Unified Psyche', { pool: 'unified-psyche' });
		const [dagger] = await actor.createEmbeddedDocuments('Item', [
			{ name: 'Dagger', type: 'object', system: { equipped: true, activation: { effects: [{ type: 'damage', formula: '1d4', canMiss: true }] } } },
		]);
		const hits = [];
		dagger.activate = vi.fn(async () => {
			hits.push([...env.game.user.targets].map((t) => t.document?.name ?? t.name));
			return { id: 'card' };
		});
		const s1 = placeShadow(env, scene, actor, [4, 0]);
		const s2 = placeShadow(env, scene, actor, [0, 4]);
		placeEnemy(env, scene, 'East Goblin', [5, 0]);
		placeEnemy(env, scene, 'South Goblin', [0, 5]);
		env.dialogs.answerWhen(/Unified Psyche/, 'confirm');
		await expect(h.shadowmancerFeatureActivationBlocked(up)).resolves.toBe(false);
		const before = env.ChatMessage.created.length;
		await h.handleShadowmancerFeatureUsed(up);
		expect(hits).toEqual([['East Goblin'], ['South Goblin']]);
		expect(scene.tokens.get(s1.id)).toBeUndefined();
		expect(scene.tokens.get(s2.id)).toBeUndefined();
		expect([casterToken.x, casterToken.y]).toEqual([0, 400]);
		expect(cards(env, before).at(-1).content).toMatch(/Dagger at <strong>East Goblin<\/strong>.*Dagger at <strong>South Goblin<\/strong>/);
	});

	it('refused (nothing spent) without Shadows, attacks or enemies; cancelling the plan cancels the use', async () => {
		const { env, h, actor, scene } = await shadowmancerWorld({ level: 15 });
		const up = await giveFeature(actor, 'Unified Psyche', { pool: 'unified-psyche' });
		await expect(h.shadowmancerFeatureActivationBlocked(up)).resolves.toBe(true);
		expect(env.notifications.messages('warn').at(-1)).toMatch(/has no Shadow on this scene/);
		placeShadow(env, scene, actor, [4, 0]);
		// Shadow Blast is an attack cantrip, but there is no enemy to strike.
		await expect(h.shadowmancerFeatureActivationBlocked(up)).resolves.toBe(true);
		expect(env.notifications.messages('warn').at(-1)).toMatch(/Target the enemies/);
		placeEnemy(env, scene, 'Goblin', [5, 0]);
		env.dialogs.answerWhen(/Unified Psyche/, 'cancel');
		await expect(h.shadowmancerFeatureActivationBlocked(up)).resolves.toBe(true);
		expect(h.pendingShadowmancerFeatures.has(up.uuid)).toBe(false);
	});
});

describe('Codex featureNotes (D10)', () => {
	it('Shadowmastery (system doc) explains why nothing is offered under Codex magic', async () => {
		await setupWorld();
		const doc = await fromUuid(SYS_SHADOWMASTERY);
		expect(doc.system.description).toMatch(/data-blue-codex-note="shadowmastery".*no utility spells/);
	});

	it('Nim+ 0.2 Conduit of Shadow says the Codex cantrips are used (Shadow Blast rules)', async () => {
		await setupWorld({ nimPlus: true });
		const doc = await fromUuid(NP_CONDUIT);
		expect(doc.system.description).toMatch(/data-blue-codex-note="conduit-of-shadow".*same as the 0.2 card.*1d12\+DEX.*\+1d12 every 5 levels/);
	});
});
