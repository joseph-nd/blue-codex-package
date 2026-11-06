/**
 * Under Codex magic a spell dragged onto a character sheet is the player's choice:
 * scripts/main.mjs only keeps official and Nim+ copies out of automatic grants.
 * `dropOnSheet` follows the system's `_onDropItem`: the `dropActorSheetData` hook,
 * then the creation.
 */
import { describe, expect, it } from 'vitest';
import { createCharacter, findDoc, findDocs, renderSheet, setupWorld } from '../harness/index.mjs';

const SYSTEM_SPELLS = 'nimble.nimble-spells';
const NIM_SPELLS = 'nim-plus-package.nim-plus-spells';
const CODEX_SPELLS = 'blue-codex-package.blue-codex-spells';

function spellSource(pack, name) {
	const hit = findDoc({ pack, type: 'spell', name });
	return { uuid: hit.uuid, data: { ...structuredClone(hit.doc), _stats: { compendiumSource: hit.uuid } } };
}

async function dropOnSheet(actor, { uuid, data }) {
	Hooks.call('dropActorSheetData', actor, {}, { type: 'Item', uuid });
	return actor.createEmbeddedDocuments('Item', [structuredClone(data)]);
}

const spellSources = (actor) => actor.items.filter((i) => i.type === 'spell').map((i) => i._stats?.compendiumSource);

describe('adding a spell by hand under Codex magic', () => {
	it('lets a system spell onto a character when the Codex covers its school and tier', async () => {
		const { env } = await setupWorld();
		const { actor } = await createCharacter(env, { classId: 'mage' });
		const rebuke = spellSource(SYSTEM_SPELLS, 'Rebuke');
		const created = await dropOnSheet(actor, rebuke);
		expect(created).toHaveLength(1);
		expect(spellSources(actor)).toContain(rebuke.uuid);
	});

	it('lets a Nim+ copy on as well, with no Codex spell swapped in', async () => {
		const { env } = await setupWorld({ nimPlus: true });
		const { actor } = await createCharacter(env, { classId: 'shadowmancer' });
		const blast = spellSource(NIM_SPELLS, 'Shadow Blast');
		const before = actor.items.size;
		expect(await dropOnSheet(actor, blast)).toHaveLength(1);
		await env.flush();
		expect(spellSources(actor)).toContain(blast.uuid);
		expect(actor.items.size).toBe(before + 1);
	});

	it('lets official necrotic onto a re-homed caster, with no Codex spell swapped in', async () => {
		const { env } = await setupWorld();
		const { actor } = await createCharacter(env, { classId: 'shadowmancer' });
		const [hit] = findDocs({ pack: SYSTEM_SPELLS, type: 'spell', school: 'necrotic', name: 'Dread Visage' });
		const before = actor.items.size;
		await dropOnSheet(actor, { uuid: hit.uuid, data: { ...structuredClone(hit.doc), _stats: { compendiumSource: hit.uuid } } });
		await env.flush();
		expect(spellSources(actor)).toContain(hit.uuid);
		expect(actor.items.size).toBe(before + 1);
	});

	it('still blocks the same spell when a grant adds it', async () => {
		const { env } = await setupWorld();
		const { actor } = await createCharacter(env, { classId: 'mage' });
		const rebuke = spellSource(SYSTEM_SPELLS, 'Rebuke');
		expect(await actor.createEmbeddedDocuments('Item', [structuredClone(rebuke.data)])).toEqual([]);
		expect(spellSources(actor)).not.toContain(rebuke.uuid);
	});

	it('allows one spell per drop, so a grant right after the drop is still blocked', async () => {
		const { env } = await setupWorld();
		const { actor } = await createCharacter(env, { classId: 'mage' });
		const rebuke = spellSource(SYSTEM_SPELLS, 'Rebuke');
		await dropOnSheet(actor, rebuke);
		expect(await actor.createEmbeddedDocuments('Item', [structuredClone(rebuke.data)])).toEqual([]);
	});

	it('a drop of something else does not open the way for a granted spell', async () => {
		const { env } = await setupWorld();
		const { actor } = await createCharacter(env, { classId: 'mage' });
		const rebuke = spellSource(SYSTEM_SPELLS, 'Rebuke');
		Hooks.call('dropActorSheetData', actor, {}, { type: 'Item', uuid: 'Compendium.nimble.nimble-class-features.Item.someFeature00000' });
		expect(await actor.createEmbeddedDocuments('Item', [structuredClone(rebuke.data)])).toEqual([]);
	});

	it('a drop on one character does not open the way on another', async () => {
		const { env } = await setupWorld();
		const { actor: first } = await createCharacter(env, { classId: 'mage' });
		const { actor: second } = await createCharacter(env, { classId: 'mage' });
		const rebuke = spellSource(SYSTEM_SPELLS, 'Rebuke');
		Hooks.call('dropActorSheetData', first, {}, { type: 'Item', uuid: rebuke.uuid });
		expect(await second.createEmbeddedDocuments('Item', [structuredClone(rebuke.data)])).toEqual([]);
	});

	it('keeps a core copy next to its Codex namesake when the sheet renders again', async () => {
		const { env } = await setupWorld();
		const { actor } = await createCharacter(env, { classId: 'shepherd' });
		const core = spellSource(SYSTEM_SPELLS, 'Rebuke');
		const codex = spellSource(CODEX_SPELLS, 'Rebuke');
		await dropOnSheet(actor, codex);
		await dropOnSheet(actor, core);
		await renderSheet(env, actor);
		await env.flush();
		expect(spellSources(actor)).toEqual(expect.arrayContaining([core.uuid, codex.uuid]));
	});

	it('a swap holds through later level-ups: the Codex spell stays gone, the core one stays', async () => {
		const { env } = await setupWorld();
		const { actor } = await createCharacter(env, { classId: 'shepherd' });
		const core = spellSource(SYSTEM_SPELLS, 'Rebuke');
		const codex = spellSource(CODEX_SPELLS, 'Rebuke');
		const owned = actor.items.find((i) => i._stats?.compendiumSource === codex.uuid);
		if (owned) await actor.deleteEmbeddedDocuments('Item', [owned.id]);
		await dropOnSheet(actor, core);
		for (let level = 2; level <= 6; level += 1) await actor.triggerLevelUp();
		await env.flush();
		expect(spellSources(actor)).toContain(core.uuid);
		expect(spellSources(actor)).not.toContain(codex.uuid);
		expect(env.Hooks.errors).toEqual([]);
	});

	it('a character who keeps the Codex spell, or only deleted it, is treated as before', async () => {
		const { env } = await setupWorld();
		const { actor: swapped } = await createCharacter(env, { classId: 'shepherd' });
		const { actor: deleted } = await createCharacter(env, { classId: 'shepherd' });
		const core = spellSource(SYSTEM_SPELLS, 'Rebuke');
		const codex = spellSource(CODEX_SPELLS, 'Rebuke');
		for (const actor of [swapped, deleted]) {
			await actor.deleteEmbeddedDocuments('Item', [actor.items.find((i) => i._stats?.compendiumSource === codex.uuid).id]);
		}
		await dropOnSheet(swapped, core);
		await swapped.triggerLevelUp();
		await deleted.triggerLevelUp();
		await env.flush();
		expect(spellSources(swapped)).not.toContain(codex.uuid);
		// No core copy to stand in for it, so the class grant applies as it always has.
		expect(spellSources(deleted)).toContain(codex.uuid);
	});

	it('still collapses two copies of the same Codex spell', async () => {
		const { env } = await setupWorld();
		const { actor } = await createCharacter(env, { classId: 'shepherd' });
		const codex = spellSource(CODEX_SPELLS, 'Rebuke');
		await actor.createEmbeddedDocuments('Item', [structuredClone(codex.data), structuredClone(codex.data)]);
		await renderSheet(env, actor);
		await env.flush();
		expect(spellSources(actor).filter((uuid) => uuid === codex.uuid)).toHaveLength(1);
	});
});
