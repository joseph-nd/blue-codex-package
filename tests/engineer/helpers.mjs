/**
 * Engineer world stand-ins: an Engineer character built from owned copies of the
 * real pack documents, a scene (tests/summons/helpers.mjs), the turret companions
 * as world base actors, and a started combat whose combatant carries Nimble's
 * `system.actions.base.current`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { adoptActor, expandObject, mergeObject, deepClone, REPO_ROOT, setupWorld } from '../harness/index.mjs';
import { addToken, installCompanion, makeScene, patchUuidResolver, placeCaster, startCombat } from '../summons/helpers.mjs';

export const MODULE_ID = 'blue-codex-package';
export const PLAYER_ID = 'player00000000a1';

export function readSource(rel) {
	return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'pack-sources', rel), 'utf-8'));
}

export const DOCS = {
	turretDeployed: 'classFeatures/engineer/engineer-progression/turret-deployed.json',
	toolbelt: 'classFeatures/engineer/engineer-progression/toolbelt.json',
	autoDeploy: 'classFeatures/engineer/engineer-progression/auto-deploy.json',
	activateTurret: 'classFeatures/engineer/engineer-actions/activate-turret.json',
	reload: 'classFeatures/engineer/engineer-actions/reload.json',
	masterTechnician: 'classFeatures/engineer/engineer-subclasses/mechanist/master-technician.json',
	coordinatedAssault: 'classFeatures/engineer/engineer-subclasses/mechanist/coordinated-assault.json',
	enhancedFormula: 'classFeatures/engineer/engineer-subclasses/alchemist/enhanced-formula.json',
	potentConcoction: 'classFeatures/engineer/engineer-subclasses/alchemist/potent-concoction.json',
	pistol: 'items/engineer/firearms/pistol.json',
	rifle: 'items/engineer/firearms/rifle.json',
	medKit: 'items/engineer/kits/med-kit.json',
	electroBaton: 'items/engineer/kits/electro-baton.json',
	flamethrower: 'items/engineer/kits/flamethrower.json',
	systemShock: 'classFeatures/engineer/engineer-kit-options/system-shock.json',
	discharge: 'classFeatures/engineer/engineer-kit-options/discharge.json',
	arcLeap: 'classFeatures/engineer/engineer-kit-options/arc-leap.json',
	airBlast: 'classFeatures/engineer/engineer-kit-options/air-blast.json',
	fumigate: 'classFeatures/engineer/engineer-kit-options/fumigate.json',
};

let counter = 0;
/** An owned copy of a pack-sources doc, with optional item-scope pool values. */
export function owned(rel, { pools = {}, patch = null } = {}) {
	const data = structuredClone(readSource(rel));
	counter += 1;
	data._id = `engItem${String(counter).padStart(9, '0')}`;
	data._stats = { ...(data._stats ?? {}), compendiumSource: `Compendium.${MODULE_ID}.${rel.startsWith('items/') ? 'blue-codex-items' : 'blue-codex-class-features'}.Item.${readSource(rel)._id}` };
	if (Object.keys(pools).length) {
		data.flags ??= {};
		data.flags.nimble = { chargePools: {} };
		for (const [identifier, [current, max]] of Object.entries(pools)) {
			data.flags.nimble.chargePools[identifier] = { current, max, label: identifier };
		}
	}
	if (patch) patch(data);
	return data;
}

/** A plain combatant stand-in with Nimble's action path and an update(). */
export function addCombatant(combat, actor, actions = 3) {
	const combatant = {
		id: `cmb${actor.id}`.slice(0, 16),
		actorId: actor.id,
		actor,
		parent: combat,
		system: { actions: { base: { current: actions, max: 3 } } },
		async update(changes) {
			mergeObject(this, expandObject(deepClone(changes)));
			return this;
		},
	};
	combat.combatants.set(combatant.id, combatant);
	return combatant;
}

export const actionsOf = (combatant) => combatant.system.actions.base.current;

/**
 * A level-`level` Engineer (INT/STR as given) owning `items` (owned() copies),
 * with actor-scope Toolbelt / Testing In Progress! counters, on a scene with the
 * turret companions installed. `combat: true` starts a combat with the Engineer.
 */
export async function engineerWorld({
	level = 3,
	int = 2,
	str = 1,
	items = [],
	toolbelt = [6, 6],
	tip = null,
	combat = true,
	actions = 3,
	isGM = true,
} = {}) {
	const { env, main } = await setupWorld({ isGM });
	const h = main.__engineer__;
	const chargePools = { 'actor:toolbelt': { current: toolbelt[0], max: toolbelt[1], label: 'Toolbelt Scraps' } };
	if (tip) chargePools['actor:testing-in-progress'] = { current: tip[0], max: tip[1], label: 'Testing In Progress!' };
	const actor = adoptActor(env, {
		_id: 'engineerActor001',
		name: 'Gizmo',
		type: 'character',
		ownership: { default: 0, [PLAYER_ID]: 3 },
		system: {
			abilities: { intelligence: { mod: int }, strength: { mod: str }, dexterity: { mod: 0 }, will: { mod: 0 } },
			classData: { levels: Array.from({ length: level }, () => 'engineer') },
			attributes: { hp: { value: 20, max: 20, temp: 0 } },
		},
		flags: { nimble: { chargePools } },
		items: [{ _id: 'engineerClass001', name: 'Engineer', type: 'class', system: { identifier: 'engineer' } }, ...items],
	});
	actor.statuses = new Set();
	actor.toggleStatusEffect = vi.fn(async (status, { active } = {}) => {
		if (active) actor.statuses.add(status);
		else actor.statuses.delete(status);
		return true;
	});
	const scene = makeScene(env);
	patchUuidResolver(env);
	for (const slug of ['turret-rifle', 'turret-healing', 'turret-flame']) installCompanion(env, slug);
	const casterToken = placeCaster(env, scene, actor, [0, 0]);
	let combatDoc = null;
	let combatant = null;
	if (combat) {
		combatDoc = startCombat(env);
		combatant = addCombatant(combatDoc, actor, actions);
	}
	const item = (name) => actor.items.find((i) => i.name === name);
	return { env, main, h, actor, scene, casterToken, combat: combatDoc, combatant, item };
}

/** Every spawned turret token gets an `activate` spy on its items. */
export function spyTurretActivations(env) {
	const calls = [];
	env.Hooks.on('createToken', (tokenDoc) => {
		for (const it of tokenDoc.actor?.items ?? []) {
			it.activate = vi.fn(async (options = {}) => {
				calls.push({ token: tokenDoc, item: it, options });
				return { id: `card-${calls.length}`, system: {} };
			});
		}
	});
	return calls;
}

export function turretsOf(scene, actor) {
	return scene.tokens.filter((t) => String(t.flags?.[MODULE_ID]?.summon?.template ?? '').startsWith('turret-') && t.flags[MODULE_ID].summon.summonerActorUuid === actor.uuid);
}

export function poolCurrent(doc, key) {
	return doc.flags?.nimble?.chargePools?.[key]?.current;
}

/** A hostile NPC token (with statuses) at grid (gx, gy). */
export function placeHostile(env, scene, name, [gx, gy], statuses = []) {
	const actor = {
		id: `npc${name}`.padEnd(16, '0').slice(0, 16),
		name,
		type: 'npc',
		statuses: new Set(statuses),
		effects: [],
		system: { attributes: { hp: { value: 10, max: 10 } } },
	};
	return addToken(env, scene, { name, x: gx * 100, y: gy * 100, disposition: -1 }, { actor });
}

export { addToken };
