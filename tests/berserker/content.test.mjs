/**
 * Codex Berserker subclasses — pack content (Skald, Lycan, Cinderheart and their
 * Savage Arsenal options): the natural weapons, the rules the runtime relies on,
 * the counters of every limited feature, the save/damage nodes, the cost types.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../harness/index.mjs';
import { BITE, CLAWS, MODULE_ID, codex, readJson } from './helpers.mjs';

const ITEMS_UUID = `Compendium.${MODULE_ID}.blue-codex-items.Item.`;
const SUBCLASS_DIR = path.join(REPO_ROOT, 'pack-sources/classFeatures/berserker/berserker-subclasses');
const allCodexBerserker = () =>
	fs
		.readdirSync(SUBCLASS_DIR)
		.flatMap((dir) => fs.readdirSync(path.join(SUBCLASS_DIR, dir)).map((file) => readJson(`pack-sources/classFeatures/berserker/berserker-subclasses/${dir}/${file}`)));
const rule = (doc, type) => doc.system.rules.find((r) => r.type === type);

describe('Lycan natural weapons', () => {
	it.each([
		[BITE, 'bite', '1d10 + @strength', 'piercing'],
		[CLAWS, 'claws', '1d8 + @strength', 'slashing'],
	])('%s.name is a proficient reach weapon with a registered id', (doc, slug, formula, type) => {
		expect(doc.type).toBe('object');
		expect(doc.system.objectType).toBe('weapon');
		expect(doc.system.weaponType).toBeUndefined(); // no weapon type = always proficient (can crit)
		expect(doc.system.activation.targets.attackType).toBe('reach');
		expect(doc.system.activation.effects[0]).toMatchObject({ type: 'damage', formula, damageType: type, canCrit: true, canMiss: true });
		expect(doc.system.slotsRequired).toBe(0);
		expect(doc.flags[MODULE_ID].automation.naturalWeapon).toBe('lycan');
		expect(readJson('pack-sources/ids.json').items.berserker[slug]).toBe(doc._id);
	});

	it('Lycan Fury grants both, and adds +DEX speed and 2×STR+DEX That all you got?! in hybrid or Beast Form', () => {
		const doc = codex('lycan', 'lycan-fury');
		const grants = doc.system.rules.filter((r) => r.type === 'grantItem').map((r) => r.uuid);
		expect(grants).toEqual([ITEMS_UUID + BITE._id, ITEMS_UUID + CLAWS._id]);
		const either = { $or: ['self:raging', 'self:beast-form'] };
		expect(rule(doc, 'speedBonus')).toMatchObject({ value: '@dexterity', movementType: 'walk', predicate: either });
		expect(rule(doc, 'modifyConsumer')).toMatchObject({
			poolIdentifier: 'fury',
			poolScope: 'item',
			effectTypeFilter: 'damageReduction',
			appendFormula: '@strength * @n',
			predicate: either,
		});
	});

	it('Beast Form is a toggle (tag self:beast-form) that costs nothing', () => {
		const doc = codex('lycan', 'beast-form');
		expect(rule(doc, 'toggleEffect')).toMatchObject({ identifier: 'beast-form', tags: ['self:beast-form'] });
		expect(doc.system.activation.cost.type).toBe('none');
	});
});

describe('stat fixes (@key → STR)', () => {
	it.each([
		['lycan', 'lunar-regeneration'],
		['skald', 'brothers-in-blood'],
		['skald', 'thunderous-bellow'],
	])('%s/%s uses @strength', (subclass, slug) => {
		const [node] = codex(subclass, slug).system.activation.effects;
		expect(node.formula).toBe('@strength');
	});
});

describe('save and damage nodes', () => {
	it('Howl in the Night: a WIL save, Frightened on a failure', () => {
		const [save] = codex('lycan', 'howl-in-the-night').system.activation.effects;
		expect(save).toMatchObject({ type: 'savingThrow', saveType: 'will', savingThrowType: 'will' });
		expect(save.on.failedSave.find((n) => n.type === 'condition')).toMatchObject({ condition: 'frightened', parentNode: save.id });
	});

	it('Blaze Breaker: Cone 3, DEX save, fire damage in full / half, a burning-area note', () => {
		const doc = codex('cinderheart', 'blaze-breaker');
		const act = doc.system.activation;
		expect(act).toMatchObject({ acquireTargetsFromTemplate: true, template: { shape: 'cone', length: 3 } });
		const [save, note] = act.effects;
		expect(save).toMatchObject({ type: 'savingThrow', saveType: 'dexterity' });
		const [damage] = save.sharedRolls;
		expect(damage).toMatchObject({ type: 'damage', damageType: 'fire', formula: '@key', parentNode: save.id });
		expect(damage.on.failedSave[0].outcome).toBe('fullDamage');
		expect(damage.on.passedSave[0].outcome).toBe('halfDamage');
		expect(note.type).toBe('note');
	});

	it('Heat of the Soul and Last Blaze ignore armor; Flaming Heart deals STR fire', () => {
		expect(codex('cinderheart', 'heat-of-the-soul').system.activation.effects[0]).toMatchObject({ damageType: 'fire', ignoreArmor: true, canMiss: false });
		expect(codex('cinderheart', 'last-blaze').system.activation.effects[0]).toMatchObject({ damageType: 'fire', ignoreArmor: true });
		expect(codex('cinderheart', 'flaming-heart').system.activation.effects[0]).toMatchObject({ damageType: 'fire', formula: '@strength' });
	});
});

describe('Cinderheart rules', () => {
	it('Immolating Fury carries the Ablaze toggle (tag self:ablaze, only while Raging)', () => {
		expect(rule(codex('cinderheart', 'immolating-fury'), 'toggleEffect')).toMatchObject({
			identifier: 'ablaze',
			tags: ['self:ablaze'],
			predicate: { self: 'raging' },
		});
	});

	it('King of Fires: fire resistance, and −STR fire while Ablaze', () => {
		const [resist, ablaze] = codex('cinderheart', 'king-of-fires').system.rules;
		expect(resist).toMatchObject({ type: 'damageReduction', mode: 'half', damageTypes: ['fire'] });
		expect(ablaze).toMatchObject({ type: 'damageReduction', mode: 'flat', value: '@strength', damageTypes: ['fire'], predicate: { self: 'ablaze' } });
	});

	it('Flames of War: +2 max Fury Dice while Ablaze', () => {
		expect(rule(codex('cinderheart', 'flames-of-war'), 'modifyPool')).toMatchObject({ poolIdentifier: 'fury', maxDelta: '2', predicate: { self: 'ablaze' } });
	});
});

describe('counters for every limited feature', () => {
	it.each([
		['cinderheart', 'cleansing-fire', 'cleansing-fire-uses', ['encounterStart']],
		['cinderheart', 'phoenix-rising', 'phoenix-rising-uses', []],
		['skald', 'warrior-poet', 'warrior-poet-uses', ['encounterStart']],
	])('%s/%s: a visible pool %s + consumer', (subclass, slug, identifier, triggers) => {
		const doc = codex(subclass, slug);
		expect(rule(doc, 'chargePool')).toMatchObject({ identifier, max: '1', scope: 'item', hidden: false, initial: 'max' });
		expect(rule(doc, 'chargePool').recoveries.map((r) => r.trigger)).toEqual(triggers);
		expect(rule(doc, 'chargeConsumer')).toMatchObject({ poolIdentifier: identifier, poolScope: 'item', cost: '1' });
	});

	it('every Codex Berserker document with a usage limit in its text has a counter', () => {
		const limited = allCodexBerserker().filter((doc) => /\(1\/|once every|1\/turn/i.test(doc.system.description.split('<hr>')[0]));
		expect(limited.map((doc) => doc.name).sort()).toEqual(['Cleansing Fire', 'Phoenix Rising', 'Warrior Poet']);
		for (const doc of limited) expect(rule(doc, 'chargePool')).toBeTruthy();
	});
});

describe('activation costs', () => {
	it('no Codex Berserker document uses the non-standard "free" or "reaction" cost types', () => {
		for (const doc of allCodexBerserker()) {
			expect(['action', 'none'], doc.name).toContain(doc.system.activation.cost.type);
		}
	});

	it.each([
		['skald', 'boltering-howl'],
		['skald', 'deafening-rebuke'],
	])('%s/%s is a system Reaction (1 action)', (subclass, slug) => {
		expect(codex(subclass, slug).system.activation.cost).toMatchObject({ type: 'action', quantity: 1, isReaction: true });
	});

	it('every automated feature documents what is automated ([A]) in its description', () => {
		for (const doc of allCodexBerserker()) {
			if (doc.name === 'Storyteller') continue;
			expect(doc.system.description, doc.name).toMatch(/\[[AM]\]/);
		}
	});
});
