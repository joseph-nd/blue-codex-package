/**
 * Engineer riders on the Engineer's own items (scripts/main.mjs "Engineer
 * automation"): Reload (and "Reload & fire" on an empty firearm), Enhanced
 * Formula +3, the Electro Baton's Charged loop, the Flamethrower's Smoldering
 * riders, Mechanist Coordinated Assault, Fumigate's ally exclusion + cleanse,
 * Healing Turret Overflow (temp HP = the healing), Potent Concoction's +INT Armor
 * and Kinetic Stabilizers' equipped-mail test.
 */
import { describe, expect, it, vi } from 'vitest';
import { adoptActor } from '../harness/index.mjs';
import {
	actionsOf,
	addToken,
	DOCS,
	engineerWorld,
	MODULE_ID,
	owned,
	placeHostile,
	poolCurrent,
	spyTurretActivations,
} from './helpers.mjs';

const undoOf = (card) => card?.flags?.[MODULE_ID]?.undo;
const target = (env, ...docs) => {
	env.game.user.targets = new Set(docs.map((doc) => ({ id: doc.id, document: doc })));
};

function firearm(rel, current, max, { equipped = true } = {}) {
	const identifier = rel.split('/').pop().replace('.json', '-ammo');
	return owned(rel, { pools: { [identifier]: [current, max] }, patch: (data) => (data.system.equipped = equipped) });
}

/** A second character (an ally) with a token next to the Engineer. */
function placeAlly(env, scene, name, [gx, gy], statuses = []) {
	const ally = adoptActor(env, {
		name,
		type: 'character',
		system: { attributes: { hp: { value: 10, max: 10, temp: 0 } } },
		items: [],
	});
	ally.statuses = new Set(statuses);
	ally.toggleStatusEffect = vi.fn(async (status, { active } = {}) => {
		if (active) ally.statuses.add(status);
		else ally.statuses.delete(status);
	});
	const token = addToken(env, scene, { name, x: gx * 100, y: gy * 100, disposition: 1, actorId: ally.id, actorLink: true }, { actor: ally });
	return { ally, token };
}

describe('Reload', () => {
	it('the Reload action refills the firearm that needs it and spends 1 Action — one card, Undo', async () => {
		const { env, h, actor, combatant, item } = await engineerWorld({ items: [owned(DOCS.reload), firearm(DOCS.pistol, 1, 6)] });
		const before = env.ChatMessage.created.length;
		await expect(h.prepareEngineerActivation(item('Reload'), {})).resolves.toEqual({ blocked: true });
		expect(poolCurrent(item('Pistol'), 'pistol-ammo')).toBe(6);
		expect(actionsOf(combatant)).toBe(2);
		const [card] = env.ChatMessage.created.slice(before);
		expect(card.content).toMatch(/reloads the <strong>Pistol<\/strong>/);
		expect(card.content).toMatch(/1 Action \(3 → 2\) · pistol-ammo \(1 → 6\)/);
		await h.UNDO_HANDLERS.get('engineerCosts')(undoOf(card).data, {});
		expect(poolCurrent(item('Pistol'), 'pistol-ammo')).toBe(1);
		expect(actionsOf(combatant)).toBe(3);
		expect(actor.items.size).toBe(3);
	});

	it('asks which firearm when several need it', async () => {
		const { env, h, item } = await engineerWorld({
			items: [owned(DOCS.reload), firearm(DOCS.pistol, 2, 6), firearm(DOCS.rifle, 0, 2)],
		});
		env.dialogs.answerWhen('Reload which firearm', { action: 'reload', checked: [item('Rifle').id] });
		await h.prepareEngineerActivation(item('Reload'), {});
		expect(poolCurrent(item('Rifle'), 'rifle-ammo')).toBe(2);
		expect(poolCurrent(item('Pistol'), 'pistol-ammo')).toBe(2);
	});

	it('nothing to reload (full, or only unequipped firearms): nothing spent', async () => {
		const { env, h, combatant, item } = await engineerWorld({
			items: [owned(DOCS.reload), firearm(DOCS.pistol, 6, 6), firearm(DOCS.rifle, 0, 2, { equipped: false })],
		});
		const before = env.ChatMessage.created.length;
		await h.prepareEngineerActivation(item('Reload'), {});
		expect(env.notifications.messages('info').at(-1)).toMatch(/fully loaded — nothing was spent/);
		expect(env.ChatMessage.created.length).toBe(before);
		expect(actionsOf(combatant)).toBe(3);
		expect(poolCurrent(item('Rifle'), 'rifle-ammo')).toBe(0);
	});

	it('firing an empty firearm offers "Reload & fire" (the attack goes on), "Reload only" or Cancel', async () => {
		const { env, h, combatant, item } = await engineerWorld({ items: [firearm(DOCS.pistol, 0, 6)] });
		const pistol = item('Pistol');
		env.dialogs.answerWhen('out of Ammo', 'cancel');
		await expect(h.prepareEngineerActivation(pistol, {})).resolves.toEqual({ blocked: true });
		expect(poolCurrent(pistol, 'pistol-ammo')).toBe(0);
		expect(actionsOf(combatant)).toBe(3);

		env.dialogs.answerWhen('out of Ammo', 'fire');
		await expect(h.prepareEngineerActivation(pistol, {})).resolves.toBeNull();
		expect(poolCurrent(item('Pistol'), 'pistol-ammo')).toBe(6);
		expect(actionsOf(combatant)).toBe(2);

		await item('Pistol').update({ 'flags.nimble.chargePools.pistol-ammo.current': 0 });
		env.dialogs.answerWhen('out of Ammo', 'reload');
		await expect(h.prepareEngineerActivation(item('Pistol'), {})).resolves.toEqual({ blocked: true });
		expect(poolCurrent(item('Pistol'), 'pistol-ammo')).toBe(6);
		expect(actionsOf(combatant)).toBe(1);
	});
});

describe('Enhanced Formula (Alchemist L7)', () => {
	it('+3 on the Med Kit for this activation only', async () => {
		const { h, item } = await engineerWorld({ items: [owned(DOCS.enhancedFormula), owned(DOCS.medKit)] });
		const medKit = item('Med Kit');
		const base = medKit.system.activation.effects[0].formula;
		const plan = await h.prepareEngineerActivation(medKit, {});
		expect(medKit.system.activation.effects[0].formula).toBe(`${base} + 3`);
		plan.restore();
		expect(medKit.system.activation.effects[0].formula).toBe(base);
	});

	it('+3 on every roll of a flagged option (nested save damage too)', async () => {
		const { h, item } = await engineerWorld({
			items: [owned(DOCS.enhancedFormula), owned('items/engineer/gadgets/hidden-mine.json')],
		});
		const mine = item('Hidden Mine');
		await h.prepareEngineerActivation(mine, {});
		expect(mine.system.activation.effects[0].sharedRolls[0].formula).toBe('(@strength)d8 + 3');
	});

	it('nothing without the feature', async () => {
		const { h, item } = await engineerWorld({ items: [owned(DOCS.medKit)] });
		await expect(h.prepareEngineerActivation(item('Med Kit'), {})).resolves.toBeNull();
	});
});

describe('Electro Baton: Charged', () => {
	it('Charged: the Strike opens at advantage; a crit gives Charged', async () => {
		const { h, actor, item } = await engineerWorld({ items: [owned(DOCS.electroBaton)] });
		const baton = item('Electro Baton');
		actor.statuses.add('charged');
		const charged = await h.prepareEngineerActivation(baton, { rollMode: 0 });
		expect(charged.options.rollMode).toBe(1);
		actor.statuses.clear();
		const plan = await h.prepareEngineerActivation(baton, {});
		expect(plan.options).toBeUndefined();
		await plan.complete({ system: { isCritical: false } });
		expect(actor.statuses.has('charged')).toBe(false);
		await plan.complete({ system: { isCritical: true } });
		expect(actor.toggleStatusEffect).toHaveBeenCalledWith('charged', { active: true });
		expect(actor.statuses.has('charged')).toBe(true);
	});

	it('System Shock: no Charged → no save on the card; Charged → spent', async () => {
		const { h, actor, item } = await engineerWorld({ items: [owned(DOCS.systemShock)] });
		const shock = item('Electro Baton: System Shock');
		const plain = await h.prepareEngineerActivation(shock, {});
		expect(shock.system.activation.effects.map((n) => n.type)).toEqual(['damage']);
		plain.restore();
		expect(shock.system.activation.effects.map((n) => n.type)).toEqual(['damage', 'savingThrow']);
		actor.statuses.add('charged');
		const plan = await h.prepareEngineerActivation(shock, {});
		expect(shock.system.activation.effects.map((n) => n.type)).toEqual(['damage', 'savingThrow']);
		await plan.complete({});
		expect(actor.statuses.has('charged')).toBe(false);
	});

	it('Discharge with Charged: every non-ally in Burst 2 is targeted, Charged is spent', async () => {
		const { env, h, actor, scene, item } = await engineerWorld({ items: [owned(DOCS.discharge)] });
		const near = placeHostile(env, scene, 'Near', [2, 0]);
		placeHostile(env, scene, 'Far', [5, 0]);
		placeAlly(env, scene, 'Buddy', [1, 1]);
		actor.statuses.add('charged');
		const plan = await h.prepareEngineerActivation(item('Electro Baton: Discharge'), {});
		expect(plan.targets.map((doc) => doc.name)).toEqual(['Near']);
		expect(plan.targets[0]).toBe(near);
		await plan.complete({});
		expect(actor.statuses.has('charged')).toBe(false);
		actor.statuses.clear();
		await expect(h.prepareEngineerActivation(item('Electro Baton: Discharge'), {})).resolves.toBeNull();
	});

	it('Arc Leap, AED and Amp Armor (and their Toolbelt versions) give Charged', async () => {
		const { h, actor, item } = await engineerWorld({
			items: [owned(DOCS.arcLeap), owned('items/engineer/gadgets/aed.json'), owned('classFeatures/engineer/engineer-gadget-toolbelt/amp-armor.json')],
		});
		for (const name of ['Electro Baton: Arc Leap', 'AED', 'Amp Armor (Toolbelt)']) {
			actor.statuses.clear();
			const plan = await h.prepareEngineerActivation(item(name), {});
			await plan.complete({});
			expect(actor.statuses.has('charged'), name).toBe(true);
		}
	});
});

describe('Flamethrower: Smoldering', () => {
	it('doubles a single-die roll, primary die intact', async () => {
		const { h } = await engineerWorld({ combat: false });
		expect(h.doubleSingleDieFormula('1d8 + floor(@level / 5) * 5')).toBe('1d8 * 2 + (0 + floor(@level / 5) * 5) * 2');
		expect(h.doubleSingleDieFormula('d6')).toBe('1d6 * 2');
		expect(h.doubleSingleDieFormula('1d8 - 1 + 3')).toBe('1d8 * 2 + (0 - 1 + 3) * 2');
		expect(h.doubleSingleDieFormula('2d6 + 3')).toBeNull();
	});

	it('Flame Jet vs a Smoldering target: double damage for this roll only', async () => {
		const { env, h, scene, item } = await engineerWorld({ items: [owned(DOCS.flamethrower)] });
		const jet = item('Flamethrower');
		const base = jet.system.activation.effects[0].formula;
		target(env, placeHostile(env, scene, 'Plain', [2, 0]));
		await expect(h.prepareEngineerActivation(jet, {})).resolves.toBeNull();
		target(env, placeHostile(env, scene, 'Burning', [2, 1], ['smoldering']));
		const plan = await h.prepareEngineerActivation(jet, {});
		expect(jet.system.activation.effects[0].formula).toBe(h.doubleSingleDieFormula(base));
		expect(env.notifications.messages('info').at(-1)).toMatch(/Burning is Smoldering/);
		plan.restore();
		expect(jet.system.activation.effects[0].formula).toBe(base);
	});

	it('another module\'s "Flamethrower" object is left alone', async () => {
		const { env, h, scene, item } = await engineerWorld({
			items: [owned(DOCS.flamethrower, { patch: (data) => (data._stats.compendiumSource = 'Compendium.other-module.items.Item.abcdefghijklmnop') })],
		});
		target(env, placeHostile(env, scene, 'Burning', [2, 1], ['smoldering']));
		await expect(h.prepareEngineerActivation(item('Flamethrower'), {})).resolves.toBeNull();
	});

	it('Air Blast vs a Smoldering target: cannot miss, auto-fails the save (note)', async () => {
		const { env, h, scene, item } = await engineerWorld({ items: [owned(DOCS.airBlast)] });
		const blast = item('Flamethrower: Air Blast');
		target(env, placeHostile(env, scene, 'Burning', [2, 0], ['smoldering']));
		const plan = await h.prepareEngineerActivation(blast, {});
		expect(blast.system.activation.effects[0].canMiss).toBe(false);
		const before = env.ChatMessage.created.length;
		await plan.complete({});
		expect(env.ChatMessage.created.slice(before)[0].content).toMatch(/automatically fails<\/strong> the STR save \(Large or smaller: pushed back 2 spaces\)/);
	});
});

describe('Coordinated Assault (Mechanist L11)', () => {
	async function mechanist(pool = 1) {
		const world = await engineerWorld({
			level: 11,
			items: [owned(DOCS.coordinatedAssault, { pools: { 'coordinated-assault-turn': [pool, 1] } }), firearm(DOCS.pistol, 6, 6)],
		});
		const activations = spyTurretActivations(world.env);
		const near = await world.h.spawnTurret(world.actor, 'turret-rifle', {}, { position: { x: 100, y: 0 } });
		const far = await world.h.spawnTurret(world.actor, 'turret-rifle', {}, { position: { x: 3000, y: 0 } });
		const enemy = placeHostile(world.env, world.scene, 'Goblin', [4, 0]);
		return { ...world, activations, near, far, enemy, pistol: world.item('Pistol'), feature: world.item('Coordinated Assault') };
	}

	it('crit: every Rifle Turret in range fires free with its maximum die; the 1/turn use is spent', async () => {
		const { env, h, pistol, enemy, near, activations, feature, combatant } = await mechanist();
		const before = env.ChatMessage.created.length;
		await h.coordinatedAssault(pistol, { targets: [{ document: enemy }], isCritical: true, isMiss: false });
		expect(activations).toHaveLength(1);
		expect(activations[0].token).toBe(near);
		expect(activations[0].options).toEqual({ fastForward: true, bcxTurretFree: true, primaryDieValue: 10 });
		expect(poolCurrent(feature, 'coordinated-assault-turn')).toBe(0);
		expect(actionsOf(combatant)).toBe(3);
		const card = env.ChatMessage.created.slice(before).find((c) => /Coordinated/.test(c.flavor ?? ''));
		expect(card.content).toMatch(/crits Goblin — <strong>Rifle Turret<\/strong> fire and crit too/);
		expect(card.content).toMatch(/Out of range \(12\): Rifle Turret \(\d+ spaces\)/);
		// 1/turn: the next firearm attack this turn triggers nothing.
		await h.coordinatedAssault(pistol, { targets: [{ document: enemy }], isCritical: true });
		expect(activations).toHaveLength(1);
	});

	it('hit: the preset primary die is never a miss or a crit', async () => {
		const { h, pistol, enemy, activations } = await mechanist();
		await h.coordinatedAssault(pistol, { targets: [{ document: enemy }], isMiss: false, isCritical: false });
		const value = activations[0].options.primaryDieValue;
		expect(value).toBeGreaterThanOrEqual(2);
		expect(value).toBeLessThanOrEqual(9);
	});

	it('miss: the turrets miss with you (no rolls), the use is spent', async () => {
		const { env, h, pistol, enemy, activations, feature } = await mechanist();
		await h.coordinatedAssault(pistol, { targets: [{ document: enemy }], isMiss: true });
		expect(activations).toHaveLength(0);
		expect(poolCurrent(feature, 'coordinated-assault-turn')).toBe(0);
		expect(env.ChatMessage.created.at(-1).content).toMatch(/misses Goblin — <strong>Rifle Turret<\/strong> miss as well/);
	});

	it('spent counter, no target or a non-firearm: nothing happens', async () => {
		const { h, pistol, enemy, activations, item } = await mechanist(0);
		await h.coordinatedAssault(pistol, { targets: [{ document: enemy }], isCritical: true });
		await h.coordinatedAssault(pistol, { targets: [] });
		await h.coordinatedAssault(item('Coordinated Assault'), { targets: [{ document: enemy }] });
		expect(activations).toHaveLength(0);
	});
});

describe('Fumigate: allies take no damage', () => {
	async function fumigateWorld() {
		const world = await engineerWorld({ items: [owned(DOCS.fumigate)] });
		const fumigate = world.item('Elixir Gun: Fumigate');
		const { token: allyToken, ally } = placeAlly(world.env, world.scene, 'Buddy', [1, 1], ['poisoned']);
		const { token: busyToken, ally: busy } = placeAlly(world.env, world.scene, 'Busy', [1, -1], ['dazed', 'slowed']);
		const enemy = placeHostile(world.env, world.scene, 'Goblin', [2, 0]);
		const message = {
			id: 'fumigateMsg00001',
			flags: { nimble: { actorId: world.actor.id, itemUuid: fumigate.uuid } },
			system: { activation: fumigate.system.activation, targets: [] },
			updateSource: vi.fn(),
		};
		return { ...world, fumigate, ally, allyToken, busy, busyToken, enemy, message };
	}

	it('on creation: allies leave the targets; a lone negative condition is cleansed (Undo), several are listed', async () => {
		const { env, h, message, ally, allyToken, busy, busyToken, enemy } = await fumigateWorld();
		const data = { flags: message.flags, system: { activation: message.system.activation, targets: [allyToken.uuid, enemy.uuid, busyToken.uuid] } };
		const before = env.ChatMessage.created.length;
		h.onAllyTargetsPreCreate(message, data, {}, env.game.user.id);
		expect(message.updateSource).toHaveBeenCalledWith({ 'system.targets': [enemy.uuid] });
		await env.flush();
		expect(ally.statuses.has('poisoned')).toBe(false);
		expect(busy.statuses.size).toBe(2);
		const card = env.ChatMessage.created.slice(before).at(-1);
		expect(card.content).toMatch(/take no damage: <strong>Buddy<\/strong>, <strong>Busy<\/strong>/);
		expect(card.content).toMatch(/Cleansed: Buddy/);
		expect(card.content).toMatch(/Busy: .*Dazed.*Slowed/i);
		await h.UNDO_HANDLERS.get('fumigateCleanse')(undoOf(card).data, {});
		expect(ally.statuses.has('poisoned')).toBe(true);
	});

	it('on the template update: allies are stripped from the new target list', async () => {
		const { env, h, message, allyToken, enemy } = await fumigateWorld();
		const changes = { system: { targets: [enemy.uuid, allyToken.uuid] } };
		h.onAllyTargetsPreUpdate(message, changes, {}, env.game.user.id);
		expect(changes.system.targets).toEqual([enemy.uuid]);
	});

	it('an activation without ignoreAllies is left alone', async () => {
		const { env, h, message, allyToken, enemy } = await fumigateWorld();
		const changes = { system: { targets: [enemy.uuid, allyToken.uuid] } };
		h.onAllyTargetsPreUpdate({ ...message, system: { activation: { effects: [{ type: 'damage', formula: '1d4' }] } } }, changes, {}, env.game.user.id);
		expect(changes.system.targets).toEqual([enemy.uuid, allyToken.uuid]);
	});
});

describe('Healing Turret Overflow: temp HP = the healing total', () => {
	it('the temp line takes the healing roll (flagged Toolbelt special only)', async () => {
		const { env, h, actor } = await engineerWorld({ level: 7 });
		const turret = await h.spawnTurret(actor, 'turret-healing', {});
		const [pulse, overflow] = turret.actor.items;
		const original = globalThis.fromUuidSync;
		globalThis.fromUuidSync = (uuid) => ({ 'overflow-uuid': overflow, 'pulse-uuid': pulse })[uuid] ?? original(uuid);
		const effects = [
			{ id: 'healSpecEff1', type: 'healing', healingType: 'healing', formula: '2d4', roll: { total: 7, formula: '2d4' } },
			{ id: 'healSpecTemp1', type: 'healing', healingType: 'tempHealing', formula: '2d4', roll: { total: 3, formula: '2d4' } },
		];
		const message = { updateSource: vi.fn() };
		h.onOverflowPreCreate(message, { flags: { nimble: { itemUuid: 'overflow-uuid' } }, system: { activation: { effects } } }, {}, env.game.user.id);
		const [[update]] = message.updateSource.mock.calls;
		expect(update['system.activation.effects'][1].roll.total).toBe(7);
		const other = { updateSource: vi.fn() };
		h.onOverflowPreCreate(other, { flags: { nimble: { itemUuid: 'pulse-uuid' } }, system: { activation: { effects } } }, {}, env.game.user.id);
		expect(other.updateSource).not.toHaveBeenCalled();
		// A world turret actor imported before the flag existed: still linked.
		delete overflow.flags[MODULE_ID].automation.tempEqualsHealing;
		overflow.actor = turret.actor;
		const stale = { updateSource: vi.fn() };
		h.onOverflowPreCreate(stale, { flags: { nimble: { itemUuid: 'overflow-uuid' } }, system: { activation: { effects } } }, {}, env.game.user.id);
		expect(stale.updateSource).toHaveBeenCalledTimes(1);
		globalThis.fromUuidSync = original;
	});
});

describe('Potent Concoction (Alchemist L11)', () => {
	it('an ally given temp HP by the Alchemist gets +INT Armor until the temp HP is gone', async () => {
		const { env, h, actor, scene } = await engineerWorld({ level: 11, int: 3, items: [owned(DOCS.potentConcoction)] });
		const { ally, token } = placeAlly(env, scene, 'Buddy', [1, 0]);
		const message = { id: 'healMsg000000001', flags: { nimble: { actorId: actor.id } } };
		const changes = {
			system: { appliedHealing: { heal1: { healingType: 'tempHealing', appliedAt: 5, targets: [{ uuid: token.uuid, previousTempHp: 0, newTempHp: 4 }] } } },
		};
		const before = env.ChatMessage.created.length;
		await h.onPotentConcoctionMessageUpdate(message, changes, {}, env.game.user.id);
		const carriers = ally.items.filter((i) => i.flags?.[MODULE_ID]?.potentConcoction);
		expect(carriers).toHaveLength(1);
		expect(carriers[0].system.rules[0]).toMatchObject({ type: 'armorClass', formula: '3', mode: 'add' });
		expect(env.ChatMessage.created.slice(before)[0].content).toMatch(/Buddy<\/strong> gains <strong>\+3 Armor/);
		// The same record again (a later heal re-sends the whole map): no duplicate.
		await h.onPotentConcoctionMessageUpdate(message, changes, {}, env.game.user.id);
		expect(ally.items.filter((i) => i.flags?.[MODULE_ID]?.potentConcoction)).toHaveLength(1);

		await ally.update({ 'system.attributes.hp.temp': 0 });
		await env.flush();
		expect(ally.items.filter((i) => i.flags?.[MODULE_ID]?.potentConcoction)).toHaveLength(0);
	});

	it('healing (not temp HP), or no Potent Concoction: nothing', async () => {
		const { env, h, actor, scene } = await engineerWorld({ level: 11, items: [owned(DOCS.potentConcoction)] });
		const { ally, token } = placeAlly(env, scene, 'Buddy', [1, 0]);
		const record = (healingType) => ({ system: { appliedHealing: { h: { healingType, appliedAt: 1, targets: [{ uuid: token.uuid, previousTempHp: 0, newTempHp: 4 }] } } } });
		await h.onPotentConcoctionMessageUpdate({ id: 'm1', flags: { nimble: { actorId: actor.id } } }, record('healing'), {}, env.game.user.id);
		const other = await engineerWorld({ level: 11 });
		const placed = placeAlly(other.env, other.scene, 'Pal', [1, 0]);
		await other.h.onPotentConcoctionMessageUpdate(
			{ id: 'm2', flags: { nimble: { actorId: other.actor.id } } },
			{ system: { appliedHealing: { h: { healingType: 'tempHealing', appliedAt: 1, targets: [{ uuid: placed.token.uuid, previousTempHp: 0, newTempHp: 4 }] } } } },
			{},
			other.env.game.user.id,
		);
		expect(ally.items.size).toBe(0);
		expect(placed.ally.items.size).toBe(0);
	});
});

describe('Kinetic Stabilizers: equipped mail armor only', () => {
	it('recognises equipped mail (by name or by the DEX-2 formula), not leather or unequipped mail', async () => {
		const { h } = await engineerWorld({ combat: false });
		const armor = (name, formula, equipped = true) => ({
			type: 'object',
			name,
			system: { objectType: 'armor', equipped, rules: [{ type: 'armorClass', formula }] },
		});
		expect(h.isEquippedMailArmor(armor('Chain Shirt', '9 + min(@dexterity,2)-@dexterity'))).toBe(true);
		expect(h.isEquippedMailArmor(armor('Dragonscale', '15 + min(@dexterity,2)-@dexterity'))).toBe(true);
		expect(h.isEquippedMailArmor(armor('Homebrew Brigandine', '11 + min(@dexterity, 2) - @dexterity'))).toBe(true);
		expect(h.isEquippedMailArmor(armor('Cheap Hides', '3'))).toBe(false);
		expect(h.isEquippedMailArmor(armor('Full Plate', '18-@dexterity'))).toBe(false);
		expect(h.isEquippedMailArmor(armor('Scale Mail', '12 + min(@dexterity,2)-@dexterity', false))).toBe(false);
		expect(h.MAIL_ARMOR_TAG).toBe('self:mailArmorEquipped');
	});
});
