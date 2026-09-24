/**
 * Shared fixtures for the Shadowmancer battery.
 */
import {
	buildCharacterByLevelUps,
	codexSpells,
	createCharacter,
	findDoc,
	isCodexSpellUuid,
	setupWorld,
	spellSummary,
} from '../harness/index.mjs';

export const LADDER = [2, 5, 7, 10, 13, 16, 19];
export const shadowmancerTier = (level) => LADDER.filter((l) => level >= l).length;
export const LEVELS = Array.from({ length: 20 }, (_, i) => i + 1);

export const CODEX = 'Compendium.blue-codex-package.blue-codex-spells.Item.';
export const CODEX_SHADOW_BLAST = `${CODEX}enkqIepuxNVpUsCh`;
export const CODEX_SUMMON_SHADOW = `${CODEX}nrDkGygSyNE6JR7n`;
export const CODEX_COMMAND_SHADOWS = `${CODEX}cmucaHB11GKzwrAr`;
/** The L1 Codex cantrips: Conduit of Shadow's patron cantrips (remapped) + Command Shadows (the 0.2 split). */
export const CODEX_L1_CANTRIPS = [CODEX_SHADOW_BLAST, CODEX_SUMMON_SHADOW, CODEX_COMMAND_SHADOWS];
export const SYS_SHADOW_BLAST = 'Compendium.nimble.nimble-spells.Item.9TNPdOXlCcGgxw6r';
export const SYS_SUMMON_SHADOW = 'Compendium.nimble.nimble-spells.Item.ho2KADcmQWWTeYR0';
export const NP_SHADOW_BLAST = 'Compendium.nim-plus-package.nim-plus-spells.Item.GLJKE5D5LdARXT29';
export const NP_SUMMON_SHADOW = 'Compendium.nim-plus-package.nim-plus-spells.Item.9nxiMH8Ow6mZPiKk';
export const NP_COMMAND_SHADOWS = 'Compendium.nim-plus-package.nim-plus-spells.Item.uHirzuVSdqt7jVPU';
export const SYS_CONDUIT = 'Compendium.nimble.nimble-class-features.Item.WXoGNl27TocLhXcK';
export const NP_CONDUIT = 'Compendium.nim-plus-package.nim-plus-class-features.Item.q3mY4JuKKmJDprY1';
export const SYS_MASTER_OF_DARKNESS = 'Compendium.nimble.nimble-class-features.Item.wGYBR7ZmNd0V6Ka4';
export const SYS_SHADOWMASTERY = 'Compendium.nimble.nimble-class-features.Item.6nAimxYeKDOthVnI';

/** The non-secret Codex shadow spells a Shadowmancer should own at `level`. */
export function expectedShadowSpells(level) {
	const all = codexSpells('shadow');
	// L1: only the Conduit of Shadow patron cantrips (remapped to their Codex versions)
	// plus Codex Command Shadows (granted with Summon Shadow); the rest of the school
	// arrives with Master of Darkness at L2.
	if (level < 2) return all.filter((s) => CODEX_L1_CANTRIPS.includes(s.uuid));
	return all.filter((s) => s.tier <= shadowmancerTier(level));
}

/** One owned-state snapshot after creation / each level-up. */
export function snapshot(env, actor, step) {
	return {
		level: actor.items.find((i) => i.type === 'class')?.system?.classLevel,
		spells: spellSummary(actor),
		created: (step?.createdSpells ?? []).map((i) => ({ name: i.name, tier: i.system?.tier, school: i.system?.school })),
		preview: step?.preview ?? null,
		highestUnlockedSpellTier: actor.system?.resources?.highestUnlockedSpellTier,
		flags: structuredClone(actor.flags?.['blue-codex-package'] ?? {}),
		notifications: [...env.notifications.all],
		hookErrors: env.Hooks.errors.length,
	};
}

/**
 * Create a Shadowmancer (DEX 2) and level it 1 → `maxLevel` with the native flow,
 * snapshotting after every step. `world` = setupWorld options.
 * @returns {Promise<{env, main, actor, snaps: Record<number, object>}>}
 */
export async function shadowmancerProgression(world = {}, { maxLevel = 20, subclass = null } = {}) {
	const { env, main } = await setupWorld(world);
	const snaps = {};
	const creation = await createCharacter(env, { classId: 'shadowmancer', abilities: { dexterity: 2 } });
	const { actor } = creation;
	snaps[1] = snapshot(env, actor, creation);
	for (let level = 2; level <= maxLevel; level += 1) {
		// eslint-disable-next-line no-await-in-loop
		const step = await actor.triggerLevelUp({ subclass: level === 3 ? subclass : null });
		snaps[level] = snapshot(env, actor, step);
	}
	return { env, main, actor, snaps };
}

export { buildCharacterByLevelUps, findDoc, isCodexSpellUuid };
