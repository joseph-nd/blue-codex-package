/**
 * Pilfered Power on the token: a Shadowmancer's mana bar (Nimble trackable
 * `resources.mana`) takes the sheet's shadow-violet gradient ends through
 * `Token#_getBarColors`; every other bar and every other class keep the core colors.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCharacter, setupWorld } from '../harness/index.mjs';

const CORE = { empty: 'core-empty', full: 'core-full' };
const core = () => CORE;

describe('Pilfered Power token bar colors', () => {
	let env;
	let T;
	let realColor;
	beforeAll(async () => {
		({ env, main: { __test__: T } } = await setupWorld());
	});
	// A tagged stand-in for Foundry's Color is enough to see which colors were picked
	// (set per test: the harness rebuilds its globals between tests).
	beforeEach(() => {
		realColor = foundry.utils.Color;
		foundry.utils.Color = { from: (hex) => ({ hex }) };
	});
	afterEach(() => {
		foundry.utils.Color = realColor;
	});

	it('recolors a Shadowmancer mana bar to the sheet gradient ends', async () => {
		const { actor } = await createCharacter(env, { classId: 'shadowmancer', render: false });
		for (const attribute of ['resources.mana', 'system.resources.mana']) {
			const colors = T.pilferedPowerBarColors({ actor }, { attribute }, core);
			expect(colors.empty.hex).toBe(0x2e1943);
			expect(colors.full.hex).toBe(0x7530a6);
		}
	});

	it('leaves a Shadowmancer HP bar alone', async () => {
		const { actor } = await createCharacter(env, { classId: 'shadowmancer', render: false });
		expect(T.pilferedPowerBarColors({ actor }, { attribute: 'attributes.hp' }, core)).toBe(CORE);
	});

	it('leaves other casters, and tokens without an actor, on the core colors', async () => {
		const { actor: mage } = await createCharacter(env, { classId: 'mage', render: false });
		expect(T.pilferedPowerBarColors({ actor: mage }, { attribute: 'resources.mana' }, core)).toBe(CORE);
		expect(T.pilferedPowerBarColors({ actor: null }, { attribute: 'resources.mana' }, core)).toBe(CORE);
		expect(T.pilferedPowerBarColors({}, undefined, core)).toBe(CORE);
	});
});
