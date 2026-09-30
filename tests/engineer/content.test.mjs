/**
 * Engineer pack content behind the automation: the new Activate Turret / Reload
 * actions (granted by Turret Deployed! / Toolbelt, ids registered), the 1/turn
 * counters, once-per-encounter Jumpstart / Testing In Progress!, the equipped
 * starting Pistol, Kinetic Stabilizers' mail predicate, Overflow's flag and the
 * Enhanced Formula flags.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../harness/index.mjs';
import { DOCS, readSource } from './helpers.mjs';

const MODULE_ID = 'blue-codex-package';
const CF = `Compendium.${MODULE_ID}.blue-codex-class-features.Item.`;
const IDS = readSource('ids.json');
const rulesOf = (rel) => readSource(rel).system.rules;
const automationOf = (doc) => doc.flags?.[MODULE_ID]?.automation ?? {};
const text = (doc) => {
	const desc = doc.system.description;
	return typeof desc === 'string' ? desc : desc.public;
};

describe('Engineer actions: Activate Turret and Reload', () => {
	it.each([
		['activate-turret', DOCS.activateTurret, 'turretActivate', DOCS.turretDeployed],
		['reload', DOCS.reload, 'reload', DOCS.toolbelt],
	])('%s: 1-Action feature, flagged, id registered, granted by its feature', (slug, rel, flag, granter) => {
		const doc = readSource(rel);
		expect(IDS.classFeatures.engineer['engineer-actions'][slug]).toBe(doc._id);
		expect(doc.system).toMatchObject({ class: 'engineer', group: 'engineer-actions', gainedAtLevels: [], subclass: false });
		expect(doc.system.activation.cost).toMatchObject({ type: 'action', quantity: 1 });
		expect(automationOf(doc)[flag]).toBe(true);
		const grant = rulesOf(granter).find((rule) => rule.type === 'grantItem' && rule.uuid === `${CF}${doc._id}`);
		expect(grant).toMatchObject({ allowDuplicate: false, disabled: false });
	});

	it('the engineer-actions group is not a level-up group (granted only)', () => {
		expect(readSource('classes/engineer.json').system.groupIdentifiers).not.toContain('engineer-actions');
	});
});

describe('counters', () => {
	it('Turret Deployed! costs 1 Action and has a visible 1/turn counter', () => {
		const doc = readSource(DOCS.turretDeployed);
		expect(doc.system.activation.cost).toMatchObject({ type: 'action', quantity: 1 });
		const pool = doc.system.rules.find((rule) => rule.type === 'chargePool');
		expect(pool).toMatchObject({ identifier: 'turret-deployed-turn', scope: 'item', max: '1', hidden: false });
		expect(pool.recoveries.map((r) => r.trigger)).toEqual(['onTurnStart', 'encounterStart', 'encounterEnd']);
	});

	it('Coordinated Assault has a visible 1/turn counter', () => {
		const pool = rulesOf(DOCS.coordinatedAssault).find((rule) => rule.type === 'chargePool');
		expect(pool).toMatchObject({ identifier: 'coordinated-assault-turn', scope: 'item', max: '1' });
		expect(pool.recoveries[0].trigger).toBe('onTurnStart');
	});

	it('Jumpstart and Testing In Progress! refill once per encounter (not per initiative roll)', () => {
		const raw = JSON.stringify([
			rulesOf('classFeatures/engineer/engineer-progression/jumpstart.json'),
			rulesOf('classFeatures/engineer/engineer-progression/testing-in-progress.json'),
		]);
		expect(raw).not.toContain('onInitiativeRolled');
		const jump = rulesOf('classFeatures/engineer/engineer-progression/jumpstart.json');
		expect(jump.map((rule) => rule.addRefills[0])).toEqual([
			{ trigger: 'encounterStart', mode: 'add', value: '2', predicate: {} },
			{ trigger: 'encounterStart', mode: 'add', value: '4', predicate: {} },
		]);
	});

	it('every limited Engineer feature has a counter', () => {
		const limited = {
			'classFeatures/engineer/engineer-progression/tinkering.json': 'tinkering-uses',
			'classFeatures/engineer/engineer-progression/testing-in-progress.json': 'testing-in-progress',
			'classFeatures/engineer/engineer-progression/turret-deployed.json': 'turret-deployed-turn',
			'classFeatures/engineer/engineer-subclasses/mechanist/coordinated-assault.json': 'coordinated-assault-turn',
			'classFeatures/engineer/engineer-subclasses/mechanist/optimized-activation.json': 'uses',
			'classFeatures/engineer/engineer-subclasses/scrapper/bulwark-gyro.json': 'bulwark-gyro-uses',
			'classFeatures/engineer/engineer-subclasses/alchemist/medical-dispersion-field.json': 'medical-dispersion-field-uses',
			'classFeatures/engineer/engineer-gadget-picks/aed.json': 'aed-uses',
			'classFeatures/engineer/engineer-gadget-picks/elixir-r.json': 'elixir-r-uses',
		};
		for (const [rel, identifier] of Object.entries(limited)) {
			expect(rulesOf(rel).some((rule) => rule.type === 'chargePool' && rule.identifier === identifier), rel).toBe(true);
		}
	});
});

describe('firearms', () => {
	it('the starting Pistol arrives equipped (its Ammo counter exists from the start)', () => {
		expect(readSource(DOCS.pistol).system.equipped).toBe(true);
	});

	it.each([DOCS.pistol, DOCS.rifle, 'items/engineer/firearms/blunderbuss.json'])('%s: Reload is [A], no manual reload line', (rel) => {
		const html = text(readSource(rel));
		expect(html).toContain('[A] Reload: use the <strong>Reload</strong> action');
		expect(html).not.toContain('Reloading costs 1 Action: spend it');
	});
});

describe('subclass and kit data', () => {
	it('Kinetic Stabilizers predicates on the equipped-mail tag', () => {
		for (const rule of rulesOf('classFeatures/engineer/engineer-subclasses/scrapper/kinetic-stabilizers.json')) {
			expect(rule.predicate).toEqual({ self: 'mailArmorEquipped' });
		}
	});

	it('Healing Turret Overflow is flagged (temp HP = the healing total), no [M] left', () => {
		const turret = readSource('companions/turret-healing.json');
		const overflow = turret.items.find((it) => it.name === 'Toolbelt: Overflow');
		expect(automationOf(overflow).tempEqualsHealing).toBe(true);
		expect(overflow.system.description).not.toContain('[M]');
	});

	it('Enhanced Formula flags the Med Kit, Elixir Gun, their rolled options and rolled gadgets only', () => {
		const flagged = [];
		const dirs = [
			'items/engineer/kits',
			'items/engineer/gadgets',
			'classFeatures/engineer/engineer-kit-options',
			'classFeatures/engineer/engineer-gadget-toolbelt',
		];
		for (const dir of dirs) {
			for (const file of fs.readdirSync(path.join(REPO_ROOT, 'pack-sources', dir))) {
				const doc = readSource(`${dir}/${file}`);
				if (automationOf(doc).enhancedFormula) flagged.push(doc.name);
			}
		}
		for (const name of ['Med Kit', 'Elixir Gun', 'Med Kit: Vital Burst', 'Elixir Gun: Fumigate', 'Elixir H', 'Elixir H (Toolbelt)', 'AED']) {
			expect(flagged).toContain(name);
		}
		for (const name of ['Flamethrower', 'Electro Baton', 'Grenade Kit', 'Flamethrower: Napalm', 'Med Kit: Stim Pack', 'Smoke Screen']) {
			expect(flagged).not.toContain(name);
		}
	});

	it('the [M] lines the automation replaced are gone', () => {
		const gone = {
			[DOCS.electroBaton]: 'Take advantage while you are Charged',
			[DOCS.flamethrower]: 'Double the damage if the target is Smoldering',
			[DOCS.coordinatedAssault]: '[M] 1/turn, on a firearm attack',
			[DOCS.enhancedFormula]: '[M] Add +3',
			[DOCS.systemShock]: '[M] Remove your Charged',
			[DOCS.discharge]: '[M] Remove your Charged',
		};
		for (const [rel, line] of Object.entries(gone)) expect(text(readSource(rel)), rel).not.toContain(line);
	});
});
