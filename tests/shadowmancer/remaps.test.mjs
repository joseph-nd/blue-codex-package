/**
 * The Shadowmancer's class-feature rewrites (installFromUuidRewrite +
 * CLASS_FEATURE_SPELL_REWRITES.shadowmancer) and the preCreateItem vetoes /
 * substitutes behind them:
 *   - Conduit of Shadow's patron cantrips: system Shadow Blast / Summon Shadow and
 *     their Nim+ 0.2 copies → the Codex spells, Codex Command Shadows granted with
 *     Summon Shadow (grantAlongside); Nim+ 0.2 Command Shadows → Codex Command Shadows;
 *   - Master of Darkness / Shadowmastery necrotic school grants → shadow;
 *   - official necrotic never lands on a Shadowmancer; a Nim+ 0.2 copy that maps
 *     1:1 is replaced by its Codex spell.
 */
import { describe, expect, it } from 'vitest';
import { rawDoc, setupWorld, createCharacter, spellSummary, findDocs } from '../harness/index.mjs';
import {
	CODEX_COMMAND_SHADOWS,
	CODEX_SHADOW_BLAST,
	CODEX_SUMMON_SHADOW,
	NP_COMMAND_SHADOWS,
	NP_CONDUIT,
	NP_SHADOW_BLAST,
	NP_SUMMON_SHADOW,
	SYS_CONDUIT,
	SYS_MASTER_OF_DARKNESS,
	SYS_SHADOW_BLAST,
	SYS_SHADOWMASTERY,
	SYS_SUMMON_SHADOW,
} from './helpers.mjs';

const grantRules = (doc) => doc.system.rules.filter((r) => r.type === 'grantSpells');

describe('Conduit of Shadow patron cantrips', () => {
	it('system feature: Shadow Blast / Summon Shadow → Codex, + Codex Command Shadows', async () => {
		await setupWorld();
		const doc = await fromUuid(SYS_CONDUIT);
		expect(grantRules(doc).map((r) => r.uuids)).toEqual([[CODEX_SHADOW_BLAST, CODEX_SUMMON_SHADOW, CODEX_COMMAND_SHADOWS]]);
		// The pack source itself is untouched (only the cached document is rewritten).
		expect(grantRules(rawDoc(SYS_CONDUIT))[0].uuids).toEqual([SYS_SHADOW_BLAST, SYS_SUMMON_SHADOW]);
	});

	it('is idempotent across repeated resolutions', async () => {
		await setupWorld();
		const a = await fromUuid(SYS_CONDUIT);
		const b = await fromUuid(SYS_CONDUIT);
		expect(b).toBe(a);
		expect(grantRules(b).map((r) => r.uuids)).toEqual([[CODEX_SHADOW_BLAST, CODEX_SUMMON_SHADOW, CODEX_COMMAND_SHADOWS]]);
	});

	it('Codex magic off: the system grant is left alone', async () => {
		await setupWorld({ replaceSpells: false });
		const doc = await fromUuid(SYS_CONDUIT);
		expect(grantRules(doc)[0].uuids).toEqual([SYS_SHADOW_BLAST, SYS_SUMMON_SHADOW]);
	});

	it.each([
		['with the Nim+ api', {}],
		['via the flag-index fallback', { nimPlusApi: false }],
	])('Nim+ 0.2 feature (%s): Summon Shadow / Command Shadows / Shadow Blast → Codex', async (_l, extra) => {
		await setupWorld({ nimPlus: true, ...extra });
		const doc = await fromUuid(NP_CONDUIT);
		expect(grantRules(rawDoc(NP_CONDUIT))[0].uuids).toEqual([NP_SUMMON_SHADOW, NP_COMMAND_SHADOWS, NP_SHADOW_BLAST]);
		expect(grantRules(doc).map((r) => r.uuids)).toEqual([[CODEX_SUMMON_SHADOW, CODEX_COMMAND_SHADOWS, CODEX_SHADOW_BLAST]]);
	});

	it('a 0.2 Shadowmancer (Nim+ playtest on) is created with the Codex cantrips only (Command Shadows included)', async () => {
		const { env } = await setupWorld({ nimPlus: true });
		const { actor, features } = await createCharacter(env, { classId: 'shadowmancer' });
		expect(features.map((f) => f.uuid)).toContain(NP_CONDUIT);
		expect(features.map((f) => f.uuid)).not.toContain(SYS_CONDUIT);
		expect(spellSummary(actor).map((s) => s.source).sort()).toEqual(
			[CODEX_SHADOW_BLAST, CODEX_SUMMON_SHADOW, CODEX_COMMAND_SHADOWS].sort(),
		);
	});

	it('Nim+ installed with the playtest off: the system feature grants the Codex cantrips + Command Shadows', async () => {
		const { env } = await setupWorld({ nimPlus: true, playtest: false });
		const { actor, features } = await createCharacter(env, { classId: 'shadowmancer' });
		expect(features.map((f) => f.uuid)).toContain(SYS_CONDUIT);
		expect(spellSummary(actor).map((s) => s.source).sort()).toEqual(
			[CODEX_SHADOW_BLAST, CODEX_SUMMON_SHADOW, CODEX_COMMAND_SHADOWS].sort(),
		);
	});

	it('Codex magic off: no Codex Command Shadows is added to the system grant', async () => {
		const { env } = await setupWorld({ replaceSpells: false });
		const { actor } = await createCharacter(env, { classId: 'shadowmancer' });
		expect(spellSummary(actor).map((s) => s.source)).not.toContain(CODEX_COMMAND_SHADOWS);
	});
});

describe('school grants → shadow', () => {
	it.each([
		['Master of Darkness', SYS_MASTER_OF_DARKNESS],
		['Shadowmastery', SYS_SHADOWMASTERY],
	])('%s: every necrotic grantSpells rule now names shadow (predicates/tiers kept)', async (_n, uuid) => {
		await setupWorld();
		const doc = await fromUuid(uuid);
		const before = grantRules(rawDoc(uuid));
		const after = grantRules(doc);
		expect(before.every((r) => r.schools.includes('necrotic'))).toBe(true);
		expect(after.map((r) => r.schools)).toEqual(before.map(() => ['shadow']));
		expect(after.map((r) => [r.tiers, r.mode, r.predicate])).toEqual(before.map((r) => [r.tiers, r.mode, r.predicate]));
	});
});

describe('official necrotic vs a Shadowmancer (preCreateItem)', () => {
	const officialNecrotic = () =>
		findDocs({ pack: 'nimble.nimble-spells', type: 'spell', school: 'necrotic' }).map((h) => ({ ...h.doc, _stats: { compendiumSource: h.uuid } }));

	it('every official necrotic spell is vetoed on a Shadowmancer', async () => {
		const { env } = await setupWorld();
		const { actor } = await createCharacter(env, { classId: 'shadowmancer' });
		const before = actor.items.size;
		const created = await actor.createEmbeddedDocuments('Item', officialNecrotic().map((d) => structuredClone(d)));
		expect(officialNecrotic().length).toBeGreaterThan(3);
		expect(created).toEqual([]);
		expect(actor.items.size).toBe(before);
	});

	it('…but not on a Mage (necrotic is a choice there), nor with Codex magic off', async () => {
		const { env } = await setupWorld();
		const { actor: mage } = await createCharacter(env, { classId: 'mage' });
		expect((await mage.createEmbeddedDocuments('Item', officialNecrotic().map((d) => structuredClone(d)))).length).toBe(officialNecrotic().length);

		const off = await setupWorld({ replaceSpells: false });
		const { actor: sm } = await createCharacter(off.env, { classId: 'shadowmancer' });
		expect((await sm.createEmbeddedDocuments('Item', officialNecrotic().map((d) => structuredClone(d)))).length).toBe(officialNecrotic().length);
	});

	it.each([
		['Summon Shadow', NP_SUMMON_SHADOW, CODEX_SUMMON_SHADOW],
		['Shadow Blast', NP_SHADOW_BLAST, CODEX_SHADOW_BLAST],
		['Command Shadows', NP_COMMAND_SHADOWS, CODEX_COMMAND_SHADOWS],
	])('a directly added Nim+ 0.2 %s is blocked and replaced by the Codex spell', async (_n, npUuid, codexUuid) => {
		const { env } = await setupWorld({ nimPlus: true });
		const { actor } = await createCharacter(env, { classId: 'shadowmancer' });
		// Start without the Codex copy so the substitute has something to do.
		await actor.deleteEmbeddedDocuments('Item', actor.items.filter((i) => i._stats?.compendiumSource === codexUuid).map((i) => i.id));
		const doc = await fromUuid(npUuid);
		const created = await actor.createEmbeddedDocuments('Item', [{ ...doc.toObject(), _stats: { compendiumSource: npUuid } }]);
		expect(created).toEqual([]);
		await env.flush();
		const sources = spellSummary(actor).map((s) => s.source);
		expect(sources).toContain(codexUuid);
		expect(sources).not.toContain(npUuid);
		expect(sources.filter((s) => s === codexUuid)).toHaveLength(1);
	});

	it('a directly added SYSTEM Summon Shadow is blocked; no substitute (only Nim+ copies are substituted)', async () => {
		const { env } = await setupWorld();
		const { actor } = await createCharacter(env, { classId: 'shadowmancer' });
		await actor.deleteEmbeddedDocuments('Item', actor.items.filter((i) => i._stats?.compendiumSource === CODEX_SUMMON_SHADOW).map((i) => i.id));
		const doc = await fromUuid(SYS_SUMMON_SHADOW);
		expect(await actor.createEmbeddedDocuments('Item', [{ ...doc.toObject(), _stats: { compendiumSource: SYS_SUMMON_SHADOW } }])).toEqual([]);
		await env.flush();
		expect(spellSummary(actor).map((s) => s.source)).not.toContain(CODEX_SUMMON_SHADOW);
	});
});
