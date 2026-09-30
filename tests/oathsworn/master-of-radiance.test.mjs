/**
 * Oathsworn — Master of Radiance (L7 / L11: "Choose 1 Radiant Utility Spell").
 *
 * The system document ships with no rules; Nim+'s 0.2 copy carries the two
 * `grantSpells selectSpell utilityOnly radiant` picks. Under Codex magic the
 * official radiant tier-0 spells (Light, Beautify, Bond of Peace are the radiant
 * utility spells) are covered by the Codex, and the Codex Radiant school has no
 * utility spells — so the pick offers nothing, by design (the BUG-bc-3
 * convention Shadowmastery follows). The fromUuid rewrite leaves the rules alone
 * and appends a featureNote saying so, only while that coverage holds.
 */
import { describe, expect, it } from 'vitest';
import { buildSpellIndex, getSpellsFromIndex, setupWorld } from '../harness/index.mjs';

const NP_MASTER_OF_RADIANCE = 'Compendium.nim-plus-package.nim-plus-class-features.Item.wjmYywK5RjfQSrhv';
const NOTE = /data-blue-codex-note="master-of-radiance".*no utility spells/;

const picks = (doc) =>
	doc.system.rules
		.filter((rule) => rule.type === 'grantSpells')
		.map((rule) => ({ schools: rule.schools, mode: rule.mode, utilityOnly: rule.utilityOnly, level: rule.predicate?.level?.min }));

const radiantUtility = async () =>
	getSpellsFromIndex(await buildSpellIndex(), ['radiant'], [0], { utilityOnly: true, forClass: 'oathsworn' }).map((s) => s.name);

describe('Master of Radiance (Nim+ 0.2 copy)', () => {
	it('Codex magic on: the radiant utility picks stay as they are and a note explains the empty choice', async () => {
		await setupWorld({ nimPlus: true });
		const doc = await fromUuid(NP_MASTER_OF_RADIANCE);
		expect(picks(doc)).toEqual([
			{ schools: ['radiant'], mode: 'selectSpell', utilityOnly: true, level: 7 },
			{ schools: ['radiant'], mode: 'selectSpell', utilityOnly: true, level: 11 },
		]);
		expect(doc.system.description).toMatch(NOTE);
		// The note is appended once, however often the document is resolved.
		const again = await fromUuid(NP_MASTER_OF_RADIANCE);
		expect(again.system.description.match(/data-blue-codex-note/g)).toHaveLength(1);
	});

	it('Codex magic on: nothing to pick (official radiant utility spells are covered, the Codex has none)', async () => {
		await setupWorld({ nimPlus: true });
		expect(await radiantUtility()).toEqual([]);
	});

	it('Codex magic off: the official radiant utility spells are offered and there is no note', async () => {
		await setupWorld({ nimPlus: true, replaceSpells: false });
		const doc = await fromUuid(NP_MASTER_OF_RADIANCE);
		expect(doc.system.description).not.toMatch(/data-blue-codex-note/);
		expect(await radiantUtility()).not.toEqual([]);
	});

	it('empty Codex spell pack (official fallback): no note', async () => {
		await setupWorld({ nimPlus: true, emptyCodexSpells: true });
		const doc = await fromUuid(NP_MASTER_OF_RADIANCE);
		expect(doc.system.description).not.toMatch(/data-blue-codex-note/);
	});
});
