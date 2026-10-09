/**
 * Sacred Grace "Empowered Companion" on the Codex Lifebinding Spirit (0.2: Harm / Mend):
 * +STR damage on Harm vs Undead (decided per target at use) and +WIL on Mend's healing
 * (baked at summon). Without the grace the formulas are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { setupWorld } from '../harness/index.mjs';
import { companionSource, MODULE_ID } from './helpers.mjs';

async function loadHandles() {
	const { main } = await setupWorld({});
	return main.__shadowmancerInvocations__;
}

function caster({ empowered }) {
	return {
		name: 'Shepherd',
		system: {
			abilities: { strength: { mod: 3 }, will: { mod: 4 } },
			classData: { levels: Array.from({ length: 10 }, (_, i) => i) },
		},
		items: empowered ? [{ type: 'feature', name: 'Empowered Companion', system: { identifier: 'empowered-companion' } }] : [],
	};
}

function spirit() {
	const items = companionSource('lifebinding-spirit-02').items.map((item, i) => ({ ...structuredClone(item), id: `i${i}`, _id: `i${i}` }));
	const synth = {
		items,
		async updateEmbeddedDocuments(_type, updates) {
			for (const u of updates) {
				const item = items.find((i) => i.id === u._id);
				if (u.system) item.system.activation.effects = u.system.activation.effects;
				if (u.flags) item.flags = { ...item.flags, [MODULE_ID]: { ...item.flags?.[MODULE_ID], ...u.flags[MODULE_ID] } };
			}
		},
	};
	for (const item of items) {
		item.update = async (changes) => {
			item.system.activation.effects = changes.system.activation.effects;
		};
	}
	return { tokenDoc: { actor: synth }, items };
}

const formulaOf = (item) => item.system.activation.effects.find((e) => e.type === 'damage' || e.type === 'healing').formula;

describe('Empowered Companion on the Codex Lifebinding Spirit', () => {
	it('adds +WIL to Mend and keeps Harm at base until an Undead is targeted', async () => {
		const h = await loadHandles();
		const { tokenDoc, items } = spirit();
		await h.patchLifebindingSpiritFormulas(tokenDoc, null, 4, caster({ empowered: true }));
		const harm = items.find((i) => i.name === 'Harm');
		const mend = items.find((i) => i.name === 'Mend');
		expect(formulaOf(mend)).toBe('4d20 + 4');
		expect(formulaOf(harm)).toBe('1d8 + 9'); // STR 3 x3 at L10 (+STR every 5 levels)
		expect(harm.flags[MODULE_ID].empoweredHarm).toEqual({ base: '1d8 + 9', str: 3 });

		globalThis.game.user.targets = [{ actor: { system: { details: { creatureType: 'Undead' } } } }];
		await h.applyEmpoweredHarmFormula(harm);
		expect(formulaOf(harm)).toBe('1d8 + 9 + 3');
		globalThis.game.user.targets = [{ actor: { system: { details: { creatureType: 'Beast' } } } }];
		await h.applyEmpoweredHarmFormula(harm);
		expect(formulaOf(harm)).toBe('1d8 + 9');
	});

	it('changes nothing without the grace', async () => {
		const h = await loadHandles();
		const { tokenDoc, items } = spirit();
		await h.patchLifebindingSpiritFormulas(tokenDoc, null, 4, caster({ empowered: false }));
		expect(formulaOf(items.find((i) => i.name === 'Mend'))).toBe('4d20');
		const harm = items.find((i) => i.name === 'Harm');
		expect(harm.flags?.[MODULE_ID]?.empoweredHarm).toBeUndefined();
		globalThis.game.user.targets = [{ actor: { system: { details: { creatureType: 'Undead' } } } }];
		await h.applyEmpoweredHarmFormula(harm);
		expect(formulaOf(harm)).toBe('1d8 + 9');
	});
});
