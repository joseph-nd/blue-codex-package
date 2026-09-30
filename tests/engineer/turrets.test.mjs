/**
 * Engineer turrets (scripts/main.mjs "Engineer turret deployment" + "Engineer
 * automation"): the deploy flow charges the Engineer's Action with its scrap and
 * 1/turn use on ONE card (Undo refunds all and removes the turret), the turret
 * activates on deploy for free, later activations cost the Engineer's Actions
 * (Toolbelt special 2), players get the spawn through the GM relay and own their
 * turret, Activate Turret runs a turret action from the Engineer, Auto Deploy!
 * turrets activate on deploy too, and Enhanced Formula reaches the Healing Turret.
 */
import { describe, expect, it } from 'vitest';
import {
	actionsOf,
	DOCS,
	engineerWorld,
	MODULE_ID,
	owned,
	PLAYER_ID,
	poolCurrent,
	spyTurretActivations,
	turretsOf,
} from './helpers.mjs';

const undoOf = (card) => card?.flags?.[MODULE_ID]?.undo;
const summonFlag = (token) => token.flags[MODULE_ID].summon;

async function deployWorld({ items = [], ...opts } = {}) {
	const world = await engineerWorld({
		...opts,
		items: [owned(DOCS.turretDeployed, { pools: { 'turret-deployed-turn': [1, 1] } }), owned(DOCS.activateTurret), ...items],
	});
	world.deployed = world.item('Turret Deployed!');
	world.activations = spyTurretActivations(world.env);
	return world;
}

describe('Turret Deployed!: costs, card, activation on deploy', () => {
	it('spawns an owned turret and pays 1 Action, 1 scrap and the 1/turn use on one card', async () => {
		const { env, h, actor, scene, combatant, deployed } = await deployWorld();
		const created = [];
		const original = scene.createEmbeddedDocuments.bind(scene);
		scene.createEmbeddedDocuments = async (type, datas, options) => {
			created.push(...datas);
			return original(type, datas, options);
		};
		const before = env.ChatMessage.created.length;
		await expect(h.summonActivationBlocked(deployed)).resolves.toBe(true);

		const [turret] = turretsOf(scene, actor);
		expect(turret).toBeTruthy();
		expect(created[0].delta).toEqual({ ownership: { [PLAYER_ID]: 3 } });
		expect(summonFlag(turret)).toMatchObject({ template: 'turret-rifle', freeActivation: true, setupDone: true, threshold: 3 });
		expect(actionsOf(combatant)).toBe(2);
		expect(poolCurrent(actor, 'actor:toolbelt')).toBe(5);
		expect(poolCurrent(deployed, 'turret-deployed-turn')).toBe(0);

		const cards = env.ChatMessage.created.slice(before);
		expect(cards).toHaveLength(1);
		const [card] = cards;
		expect(card.content).toMatch(/deploys a <strong>Rifle Turret<\/strong>/);
		expect(card.content).toMatch(/1 Action \(3 → 2\)/);
		expect(card.content).toMatch(/Toolbelt scrap \(6 → 5\)/);
		expect(card.content).toMatch(/data-bcx-turret-fire/);
		expect(card.flags[MODULE_ID][h.TURRET_FIRE_FLAG]).toEqual({ tokenUuid: turret.uuid, actorUuid: actor.uuid });
		expect(undoOf(card).type).toBe('engineerCosts');
		// No target selected: the single-target Fire waits for the card button.
		expect(env.notifications.messages('info').at(-1)).toMatch(/target a creature, then press "Fire \(Rifle\)"/);
	});

	it('fires on deploy when a target is selected — for free, clearing the free activation', async () => {
		const { env, h, scene, actor, combatant, deployed, activations } = await deployWorld();
		env.game.user.targets = new Set([{ id: 'x', document: { id: 'x' } }]);
		await h.summonActivationBlocked(deployed);
		expect(activations).toHaveLength(1);
		expect(activations[0].item.name).toBe('Fire (Rifle)');
		const [turret] = turretsOf(scene, actor);
		// The wrapped activation of that shot: free, and it spends the free activation.
		const plan = await h.prepareTurretActivation(Object.assign(turret.actor.items[0], { actor: turret.actor }), {});
		await plan.complete();
		expect(actionsOf(combatant)).toBe(2); // only the deploy's Action
		expect(summonFlag(turret).freeActivation).toBe(false);
		delete env.game.user.targets;
	});

	it('refuses a second deploy in the same turn (counter) and nothing is spent', async () => {
		const { env, h, actor, combatant, deployed } = await deployWorld();
		await h.summonActivationBlocked(deployed);
		const before = env.ChatMessage.created.length;
		await h.summonActivationBlocked(deployed);
		expect(env.notifications.messages('warn').at(-1)).toMatch(/already deployed a turret this turn.*Turret Deployed! \(1\/turn\) counter/);
		expect(env.ChatMessage.created.length).toBe(before);
		expect(actionsOf(combatant)).toBe(2);
		expect(poolCurrent(actor, 'actor:toolbelt')).toBe(5);
	});

	it('Undo refunds everything, removes the new turret and restores the one it replaced', async () => {
		const { env, h, actor, scene, combatant, deployed } = await deployWorld();
		await h.summonActivationBlocked(deployed);
		const [first] = turretsOf(scene, actor);
		// Next turn: the counter refilled (onTurnStart) — deploy again at the cap of 1.
		await deployed.update({ 'flags.nimble.chargePools.turret-deployed-turn.current': 1 });
		combatant.system.actions.base.current = 3;
		const before = env.ChatMessage.created.length;
		await h.summonActivationBlocked(deployed);
		const second = turretsOf(scene, actor);
		expect(second).toHaveLength(1);
		expect(second[0].id).not.toBe(first.id);
		const card = env.ChatMessage.created.slice(before).find((c) => undoOf(c)?.type === 'engineerCosts');
		expect(card.content).toMatch(/It replaces <strong>Rifle Turret<\/strong>/);

		const note = await h.UNDO_HANDLERS.get('engineerCosts')(undoOf(card).data, {});
		expect(note).toMatch(/Actions 2 → 3/);
		expect(actionsOf(combatant)).toBe(3);
		expect(poolCurrent(actor, 'actor:toolbelt')).toBe(5);
		expect(poolCurrent(deployed, 'turret-deployed-turn')).toBe(1);
		const now = turretsOf(scene, actor);
		expect(now.map((t) => t.id)).toEqual([first.id]);
	});

	it('Master Technician: no 1/turn limit, two turrets, the counter is left alone', async () => {
		const { h, actor, scene, deployed } = await deployWorld({ items: [owned(DOCS.masterTechnician)] });
		await h.summonActivationBlocked(deployed);
		await h.summonActivationBlocked(deployed);
		expect(turretsOf(scene, actor)).toHaveLength(2);
		expect(poolCurrent(deployed, 'turret-deployed-turn')).toBe(1);
		expect(poolCurrent(actor, 'actor:toolbelt')).toBe(4);
	});

	it('Testing In Progress! pays instead of the scrap (picker), on the same card', async () => {
		const { env, h, actor, deployed } = await deployWorld({ tip: [1, 1] });
		// (The harness form returns one checked input for every selector: answer directly.)
		env.dialogs.answerWhen('Deploy Turret', (config) => {
			expect(config.content).toMatch(/Testing In Progress! — free \(1\/encounter\)/);
			return { template: 'turret-rifle', useFree: true };
		});
		await h.summonActivationBlocked(deployed);
		expect(poolCurrent(actor, 'actor:testing-in-progress')).toBe(0);
		expect(poolCurrent(actor, 'actor:toolbelt')).toBe(6);
	});
});

describe('turret activations charge the Engineer', () => {
	async function deployedTurret(opts) {
		const world = await deployWorld(opts);
		await world.h.summonActivationBlocked(world.deployed);
		const [turret] = turretsOf(world.scene, world.actor);
		for (const it of turret.actor.items) it.actor = turret.actor;
		// The free activation on deploy was used.
		turret.flags[MODULE_ID].summon.freeActivation = false;
		world.combatant.system.actions.base.current = 3;
		return { ...world, turret, basic: turret.actor.items[0], special: turret.actor.items[1] };
	}

	it('a basic action costs 1 Action after it resolved (one card, Undo)', async () => {
		const { env, h, combatant, basic } = await deployedTurret();
		const plan = await h.prepareTurretActivation(basic, {});
		expect(actionsOf(combatant)).toBe(3); // nothing before the roll
		const before = env.ChatMessage.created.length;
		await plan.complete();
		expect(actionsOf(combatant)).toBe(2);
		const [card] = env.ChatMessage.created.slice(before);
		expect(card.content).toMatch(/Rifle Turret<\/strong> activates \(Fire \(Rifle\)\)/);
		await h.UNDO_HANDLERS.get('engineerCosts')(undoOf(card).data, {});
		expect(actionsOf(combatant)).toBe(3);
	});

	it('short on Actions: asks first (cancel = no activation)', async () => {
		const { env, h, combatant, basic } = await deployedTurret();
		combatant.system.actions.base.current = 0;
		env.dialogs.answerWhen('not enough actions', false);
		await expect(h.prepareTurretActivation(basic, {})).resolves.toEqual({ blocked: true });
		env.dialogs.answerWhen('not enough actions', true);
		const plan = await h.prepareTurretActivation(basic, {});
		await plan.complete();
		expect(actionsOf(combatant)).toBe(0);
	});

	it('the Toolbelt special costs 2 Actions + 1 scrap and destroys the turret; Undo restores it', async () => {
		const { env, h, actor, scene, combatant, special, turret } = await deployedTurret();
		env.dialogs.answerWhen('Toolbelt: Rapid Fire', 'destroy');
		const plan = await h.prepareTurretActivation(special, {});
		expect(env.dialogs.log.at(-1).content).toMatch(/2 Actions<\/strong> \(3 left\)/);
		expect(plan.shots).toBe(2); // INT 2
		const before = env.ChatMessage.created.length;
		await plan.complete();
		expect(actionsOf(combatant)).toBe(1);
		expect(poolCurrent(actor, 'actor:toolbelt')).toBe(4);
		expect(turretsOf(scene, actor)).toHaveLength(0);
		const card = env.ChatMessage.created.slice(before).find((c) => undoOf(c)?.type === 'engineerCosts');
		expect(card.content).toMatch(/2 Actions \(3 → 1\)/);
		await h.UNDO_HANDLERS.get('engineerCosts')(undoOf(card).data, {});
		expect(turretsOf(scene, actor).map((t) => t.id)).toEqual([turret.id]);
		expect(actionsOf(combatant)).toBe(3);
		expect(poolCurrent(actor, 'actor:toolbelt')).toBe(5);
	});

	it('outside combat nothing is charged', async () => {
		const { env, h, combatant, basic } = await deployedTurret();
		env.game.combat = null;
		const plan = await h.prepareTurretActivation(basic, {});
		const before = env.ChatMessage.created.length;
		await plan.complete();
		expect(env.ChatMessage.created.length).toBe(before);
		expect(actionsOf(combatant)).toBe(3);
	});

	it('Activate Turret lists the turret actions and runs the chosen one (basic by default)', async () => {
		const { env, h, item, activations } = await deployedTurret();
		const feature = item('Activate Turret');
		env.dialogs.answerWhen('Activate Turret', 'activate');
		await expect(h.prepareEngineerActivation(feature, {})).resolves.toEqual({ blocked: true });
		const dialog = env.dialogs.log.at(-1);
		expect(dialog.content).toMatch(/Rifle Turret: Fire \(Rifle\) <em>\(1 Action\)<\/em>/);
		expect(dialog.content).toMatch(/Toolbelt: Rapid Fire \(×2\) <em>\(2 Actions \+ 1 Toolbelt scrap, destroys the turret\)/);
		expect(activations.at(-1).item.name).toBe('Fire (Rifle)');
		expect(activations.at(-1).options).toEqual({ bcxActionsConfirmed: true });
	});

	it('Activate Turret with no turret out: a warning, nothing spent', async () => {
		const { env, h, item } = await engineerWorld({ items: [owned(DOCS.activateTurret)] });
		await expect(h.prepareEngineerActivation(item('Activate Turret'), {})).resolves.toEqual({ blocked: true });
		expect(env.notifications.messages('warn').at(-1)).toMatch(/no deployed turret/);
	});
});

describe('multiplayer: the player deploys through the GM relay and owns the turret', () => {
	it('relays the spawn, waits for the finished turret, then pays and posts the card locally', async () => {
		const world = await deployWorld();
		const { env, h, actor, scene, combatant, deployed } = world;
		env.game.users.activeGM = env.users.gm;
		env.setUser({ isGM: false });
		const deploying = h.summonActivationBlocked(deployed);
		// Let the player's client reach the relay message.
		for (let i = 0; i < 20 && !env.ChatMessage.created.some((c) => c.flags?.[MODULE_ID]?.gmRelay); i += 1) await env.flush();
		const relay = env.ChatMessage.created.find((c) => c.flags?.[MODULE_ID]?.gmRelay?.op === 'spawnTurret');
		expect(relay).toBeTruthy();
		expect(turretsOf(scene, actor)).toHaveLength(0);
		// The active GM's client runs it (permission checked against the requester).
		env.setUser({ isGM: true });
		await h.GM_RELAY_OPS.get('spawnTurret')(relay.flags[MODULE_ID].gmRelay.payload, { user: env.users.player });
		env.setUser({ isGM: false });
		await expect(deploying).resolves.toBe(true);
		const [turret] = turretsOf(scene, actor);
		expect(summonFlag(turret).setupDone).toBe(true);
		expect(actionsOf(combatant)).toBe(2);
		expect(poolCurrent(actor, 'actor:toolbelt')).toBe(5);
	});

	it('a stranger cannot spawn a turret for someone else', async () => {
		const { env, h, actor, scene } = await deployWorld();
		const stranger = { id: 'stranger00000001', name: 'Stranger', isGM: false };
		await h.GM_RELAY_OPS.get('spawnTurret')({ casterUuid: actor.uuid, template: 'turret-rifle', summon: {} }, { user: stranger });
		expect(turretsOf(scene, actor)).toHaveLength(0);
		expect(env.notifications.messages('warn')).toEqual([]);
	});

	it('gives the ownership to every non-GM owner of the Engineer', async () => {
		const { h, actor } = await deployWorld();
		expect(h.turretOwnershipOverrides(actor)).toEqual({ delta: { ownership: { [PLAYER_ID]: 3 } } });
	});
});

describe('Auto Deploy!', () => {
	it('combat start: a free, owned Rifle Turret that activates on deploy (Fire card, no costs)', async () => {
		const { env, h, actor, scene, combat, combatant } = await engineerWorld({ level: 7, items: [owned(DOCS.autoDeploy)] });
		combatant.token = scene.tokens.find((t) => t.actorId === actor.id);
		const before = env.ChatMessage.created.length;
		await h.autoDeployForCombatant(combatant, combat);
		const [turret] = turretsOf(scene, actor);
		expect(summonFlag(turret)).toMatchObject({ excludeFromCap: true, combatId: combat.id, freeActivation: true, setupDone: true });
		const [card] = env.ChatMessage.created.slice(before);
		expect(card.content).toMatch(/automatically deploys a <strong>Rifle Turret<\/strong>/);
		expect(card.content).toMatch(/data-bcx-turret-fire/);
		expect(undoOf(card)).toBeUndefined();
		expect(actionsOf(combatant)).toBe(3);
	});
});

describe('Enhanced Formula reaches the Healing Turret', () => {
	it('+3 on Healing Pulse (on top of INT) and on Overflow', async () => {
		const { h, actor, scene } = await engineerWorld({ level: 7, items: [owned(DOCS.enhancedFormula)] });
		const turret = await h.spawnTurret(actor, 'turret-healing', {});
		const [pulse, overflow] = turret.actor.items;
		expect(pulse.system.activation.effects[0].formula).toBe('1d4 + 5'); // INT 2 + 3
		expect(overflow.system.activation.effects[0].formula).toBe('2d4 + 3');
		expect(pulse.system.description).toMatch(/Enhanced Formula \+3/);
		expect(turretsOf(scene, actor)).toHaveLength(1);
	});

	it('without the feature the Healing Turret is unchanged', async () => {
		const { h, actor } = await engineerWorld({ level: 7 });
		const turret = await h.spawnTurret(actor, 'turret-healing', {});
		expect(turret.actor.items[0].system.activation.effects[0].formula).toBe('1d4 + 2');
	});
});

describe('Turret Deployed!: out of scrap, and the 1/turn counter on the card', () => {
	it('0 scrap: a warning says why, then "use it anyway?" — No deploys nothing and spends nothing', async () => {
		const { env, h, actor, scene, combatant, deployed } = await deployWorld({ toolbelt: [0, 4] });
		env.dialogs.answerWhen('not enough Toolbelt scrap', false);
		const before = env.ChatMessage.created.length;
		await expect(h.summonActivationBlocked(deployed)).resolves.toBe(true);
		expect(env.notifications.messages('warn').at(-1)).toMatch(/Gizmo has no Toolbelt scrap left \(0\/4\) — Turret Deployed! costs 1/);
		expect(env.dialogs.log.at(-1).content).toMatch(/Use it anyway\? \(No scrap is spent\.\)/);
		expect(turretsOf(scene, actor)).toHaveLength(0);
		expect(env.ChatMessage.created.length).toBe(before);
		expect(actionsOf(combatant)).toBe(3);
		expect(poolCurrent(deployed, 'turret-deployed-turn')).toBe(1);
	});

	it('0 scrap, "use it anyway": the turret deploys, the card says no scrap was spent, the 1/turn use is spent', async () => {
		const { env, h, actor, scene, combatant, deployed } = await deployWorld({ toolbelt: [0, 4] });
		env.dialogs.answerWhen('not enough Toolbelt scrap', true);
		const before = env.ChatMessage.created.length;
		await h.summonActivationBlocked(deployed);
		expect(turretsOf(scene, actor)).toHaveLength(1);
		const [card] = env.ChatMessage.created.slice(before);
		expect(card.content).toMatch(/Toolbelt scrap: none left — deployed anyway, nothing spent\./);
		expect(card.content).toMatch(/Turret Deployed! \(1\/turn\) \(1 → 0\)/);
		expect(poolCurrent(actor, 'actor:toolbelt')).toBe(0);
		expect(poolCurrent(deployed, 'turret-deployed-turn')).toBe(0);
		expect(actionsOf(combatant)).toBe(2);
	});

	it('the card shows the 1/turn use spent; Undo restores it', async () => {
		const { env, h, deployed } = await deployWorld();
		const before = env.ChatMessage.created.length;
		await h.summonActivationBlocked(deployed);
		const card = env.ChatMessage.created.slice(before).find((c) => undoOf(c)?.type === 'engineerCosts');
		expect(card.content).toMatch(/Turret Deployed! \(1\/turn\) \(1 → 0\)/);
		await h.UNDO_HANDLERS.get('engineerCosts')(undoOf(card).data, {});
		expect(poolCurrent(deployed, 'turret-deployed-turn')).toBe(1);
	});

	it('Master Technician: the card says there is no 1/turn limit (the counter is not spent)', async () => {
		const { env, h, deployed } = await deployWorld({ items: [owned(DOCS.masterTechnician)] });
		const before = env.ChatMessage.created.length;
		await h.summonActivationBlocked(deployed);
		const [card] = env.ChatMessage.created.slice(before);
		expect(card.content).toMatch(/Turret Deployed!: no 1\/turn limit \(Master Technician\)\./);
		expect(poolCurrent(deployed, 'turret-deployed-turn')).toBe(1);
	});
});
