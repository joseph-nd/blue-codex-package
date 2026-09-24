import { describe, expect, it } from 'vitest';
import { loadPackData, setupWorld, createCharacter, spellSummary } from '../harness/index.mjs';

describe('harness smoke', () => {
	it('loads pack data without id warnings for the Codex packs', () => {
		const data = loadPackData();
		expect(data.packs.get('blue-codex-package.blue-codex-spells').docs.length).toBeGreaterThan(100);
		expect(data.warnings.filter((w) => w.startsWith('pack-sources/'))).toEqual([]);
	});

	it('boots main.mjs to ready with no hook errors and exposes the api', async () => {
		const { env } = await setupWorld();
		expect(env.Hooks.errors).toEqual([]);
		expect(env.game.modules.get('blue-codex-package').api).toBeTruthy();
		expect(globalThis.blueCodex).toBe(env.game.modules.get('blue-codex-package').api);
	});

	it('creates a level-1 character through the ported creator', async () => {
		const { env } = await setupWorld();
		const { actor } = await createCharacter(env, { classId: 'shadowmancer' });
		expect(env.Hooks.errors).toEqual([]);
		expect(spellSummary(actor).length).toBeGreaterThan(0);
	});
});
