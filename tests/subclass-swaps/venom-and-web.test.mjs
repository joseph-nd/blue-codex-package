/**
 * Nim+'s Circle of Venom & Web (Stormshifter) — Deadly Nature: "Replace your
 * lightning or wind school with necrotic." Under Codex magic necrotic is the Book
 * of Ruin, so the subclass policy asks which of lightning/wind to keep and which
 * Ruin school replaces the other. With Codex magic off the policy stays out of the
 * way (Nim+ swaps in the official necrotic school itself).
 */
import { describe, expect, it } from 'vitest';
import { createCharacter, setupWorld, spellSummary } from '../harness/index.mjs';

const SUBCLASS = 'Circle of Venom & Web';
const SHADOWMANCER_ONLY = ['Shadow Blast', 'Summon Shadow', 'Command Shadows'];

/** Answer the "Spell Schools" dialog: `choices` maps radio name → value. */
const pickSchools = (choices) => (config) => {
	const button = config.buttons.find((b) => b.action === 'confirm');
	const root = {
		querySelector: (sel) => {
			const name = /name="([^"]+)"/.exec(String(sel))?.[1];
			return choices[name] ? { value: choices[name] } : null;
		},
		querySelectorAll: () => [],
	};
	return button.callback({}, { form: root }, { element: root });
};

const schoolsOf = (actor) => new Set(spellSummary(actor).map((s) => s.school));
const spellNames = (actor) => spellSummary(actor).map((s) => s.name);

async function stormshifterAt2(world) {
	const { env, main } = await setupWorld({ nimPlus: true, ...world });
	const { actor } = await createCharacter(env, { classId: 'stormshifter', abilities: { will: 2 } });
	await actor.triggerLevelUp();
	return { env, main, actor };
}

describe('Circle of Venom & Web under Codex magic', () => {
	it('asks at level 3 and swaps wind for the chosen Book of Ruin school', async () => {
		const { env, actor } = await stormshifterAt2();
		expect(schoolsOf(actor)).toEqual(new Set(['lightning', 'wind']));

		env.dialogs.answerWhen(/Spell Schools/, pickSchools({ 'blue-codex-choose-0': 'lightning', 'blue-codex-choose-1': 'death' }));
		await actor.triggerLevelUp({ subclass: SUBCLASS });

		const prompt = env.dialogs.log.find((d) => /Spell Schools/.test(d.title));
		expect(prompt?.content).toContain('Deadly Nature');
		expect(actor.getFlag('blue-codex-package', 'spellSchools')).toMatchObject({
			subclass: 'circle-of-venom-and-web',
			schools: ['lightning', 'death'],
		});
		const schools = schoolsOf(actor);
		expect(schools.has('wind')).toBe(false);
		expect(schools.has('lightning')).toBe(true);
		expect(schools.has('death')).toBe(true);
		expect(spellSummary(actor).filter((s) => s.school === 'death').map((s) => s.tier).sort()).toEqual(
			expect.arrayContaining([0, 1]),
		);
		expect(env.Hooks.errors).toEqual([]);
	});

	it('keeps the swap on later level-ups (tier 2: lightning + the Ruin school, no wind)', async () => {
		const { env, actor } = await stormshifterAt2();
		env.dialogs.answerWhen(/Spell Schools/, pickSchools({ 'blue-codex-choose-0': 'wind', 'blue-codex-choose-1': 'curse' }));
		await actor.triggerLevelUp({ subclass: SUBCLASS });
		await actor.triggerLevelUp();

		const byTier2 = spellSummary(actor).filter((s) => s.tier === 2);
		expect(byTier2.map((s) => s.school)).toEqual(expect.arrayContaining(['wind', 'curse']));
		expect(byTier2.some((s) => s.school === 'lightning')).toBe(false);
		expect(schoolsOf(actor).has('lightning')).toBe(false);
		expect(env.Hooks.errors).toEqual([]);
	});

	it("does not hand a Stormshifter the Shadowmancer's shadow cantrips", async () => {
		const { env, actor } = await stormshifterAt2();
		env.dialogs.answerWhen(/Spell Schools/, pickSchools({ 'blue-codex-choose-0': 'lightning', 'blue-codex-choose-1': 'shadow' }));
		await actor.triggerLevelUp({ subclass: SUBCLASS });

		expect(schoolsOf(actor).has('shadow')).toBe(true);
		for (const name of SHADOWMANCER_ONLY) expect(spellNames(actor)).not.toContain(name);
	});
});

describe('one prompt per level-up, whoever is online', () => {
	it("ignores another user's subclass pick (each GM owns the character too)", async () => {
		const { env, actor } = await stormshifterAt2();
		await actor.triggerLevelUp({ subclass: SUBCLASS }); // unscripted prompt closes → deferred
		const subclass = actor.items.find((i) => i.type === 'subclass');
		const prompts = () => env.dialogs.log.filter((d) => /Spell Schools/.test(d.title)).length;
		const seen = prompts();
		env.Hooks.callAll('createItem', subclass, {}, 'someOtherUser');
		env.Hooks.callAll('updateItem', subclass, {}, {}, 'someOtherUser');
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(prompts()).toBe(seen);
	});

	it('keeps the pick another client stored while this prompt was open', async () => {
		const { env, actor } = await stormshifterAt2();
		const theirs = { subclass: 'circle-of-venom-and-web', schools: ['wind', 'blood'], grantedTier: 1 };
		env.dialogs.answerWhen(/Spell Schools/, async (config) => {
			await actor.setFlag('blue-codex-package', 'spellSchools', theirs);
			return pickSchools({ 'blue-codex-choose-0': 'lightning', 'blue-codex-choose-1': 'death' })(config);
		});
		await actor.triggerLevelUp({ subclass: SUBCLASS });

		expect(actor.getFlag('blue-codex-package', 'spellSchools')).toMatchObject({ schools: ['wind', 'blood'] });
		expect(schoolsOf(actor).has('wind')).toBe(true); // this client's late answer pruned nothing
		expect(schoolsOf(actor).has('death')).toBe(false);
	});
});

describe('Circle of Venom & Web with Codex magic off', () => {
	it('leaves the swap to Nim+ (no Codex prompt, no stored Codex schools)', async () => {
		const { env, main, actor } = await stormshifterAt2({ replaceSpells: false });
		await actor.triggerLevelUp({ subclass: SUBCLASS });

		expect(env.dialogs.log.some((d) => /Spell Schools/.test(d.title))).toBe(false);
		expect(actor.getFlag('blue-codex-package', 'spellSchools')).toBeFalsy();
		expect(main.__test__.SUBCLASS_SPELL_POLICY['circle-of-venom-and-web'].codexMagicOnly).toBe(true);
	});
});
