/**
 * Blue Codex Package — runtime entry point.
 *
 * Exposes a module API that feature macros (the `system.macro` field on
 * Nimble items) can call, mirroring the pattern established by
 * nim-plus-package:
 *
 *   game.modules.get('blue-codex-package').api.someHelper(actor, item, opts)
 *   blueCodex.someHelper(actor, item, opts)   // shortcut alias
 *
 * Content automation (class features, turret/companion handling, etc.) is
 * added here as the compendium content is authored.
 */

const MODULE_ID = 'blue-codex-package';

// ── Default magic system ─────────────────────────────────────────────────────
// Blue's Codex re-authors (and rebalances) the whole spell list. When a
// spellcasting class levels up, Nimble's `grantSpells` rules grant *every*
// spell of the granted school/tier found in the spell index — and that index
// (`buildSpellIndex`, an un-patchable bundle-local) scans EVERY Item compendium.
// With this module installed, that means the character receives both the
// official `nimble.nimble-spells` version and our Codex version of each spell.
//
// To make the Codex the default magic system we suppress the official spells at
// the point they would enter a character — but ONLY where the Codex actually
// provides a replacement for that (school, tier). Official schools the Codex
// does not re-author (notably `necrotic`, which the Codex splits into
// shadow/death/blood/curse) are left untouched so casters of those schools are
// never left with zero spells until the Codex classes are authored.
//
// Two coordinated layers, both gated by the `replaceOfficialSpells` setting:
//   1. `CompendiumCollection#getIndex` — filter the official spell packs out of
//      the *grant* index (character creation + level-up) so official spells
//      never appear in the level-up preview or selection lists. The grant path
//      is told apart from the compendium browser by its index-field signature
//      (grant requests `system.classes` and omits `name`; the browser is the
//      reverse), so the official spell *browser* is left fully intact.
//   2. `preCreateItem` — a safety net: block any official-pack spell from being
//      created on a character when the Codex covers its school/tier, in case a
//      future system update changes the grant path's field signature.
const SETTING_REPLACE_SPELLS = 'replaceOfficialSpells';
const OFFICIAL_SPELL_PACKS = new Set(['nimble.nimble-spells', 'nimble.nimble-secret-spells']);
const CODEX_SPELLS_PACK = `${MODULE_ID}.blue-codex-spells`;

/** Set of `${school}:${tier}` the Codex spell pack can grant (non-secret). */
let codexCoverageSet = null;
let codexCoveragePromise = null;

function isReplaceSpellsEnabled() {
	try {
		return game.settings?.get?.(MODULE_ID, SETTING_REPLACE_SPELLS) === true;
	} catch {
		return false;
	}
}

/**
 * Build (once, cached) the set of `${school}:${tier}` keys the Codex spell pack
 * covers, excluding secret spells (which are never granted at level-up). Also
 * caches the resolved Set synchronously on `codexCoverageSet` for the
 * synchronous `preCreateItem` hook.
 */
function ensureCodexCoverage() {
	if (!codexCoveragePromise) {
		codexCoveragePromise = (async () => {
			const set = new Set();
			try {
				const pack = game.packs?.get?.(CODEX_SPELLS_PACK);
				if (pack) {
					const index = await pack.getIndex({
						fields: ['system.school', 'system.tier', 'system.properties.selected'],
					});
					for (const entry of index) {
						const school = entry?.system?.school;
						if (!school) continue;
						const selected = entry?.system?.properties?.selected ?? [];
						if (selected.includes('secretSpell')) continue;
						set.add(`${school}:${entry?.system?.tier ?? 0}`);
					}
				}
			} catch (error) {
				console.error(`[${MODULE_ID}] Failed to build Codex spell coverage`, error);
			}
			codexCoverageSet = set;
			return set;
		})();
	}
	return codexCoveragePromise;
}

/**
 * Patch CompendiumCollection#getIndex so the official Nimble spell packs
 * contribute no Codex-covered spells to the character-grant index, while the
 * compendium browser (a different field signature) is left untouched.
 */
function patchSpellGrantIndex() {
	const CompendiumCollectionClass =
		foundry?.documents?.collections?.CompendiumCollection ?? globalThis.CompendiumCollection;
	const proto = CompendiumCollectionClass?.prototype;
	if (!proto?.getIndex || proto.__blueCodexSpellFilterPatched) return;

	const originalGetIndex = proto.getIndex;
	proto.getIndex = async function blueCodexPatchedGetIndex(options = {}) {
		const result = await originalGetIndex.call(this, options);
		try {
			if (!isReplaceSpellsEnabled()) return result;
			if (!OFFICIAL_SPELL_PACKS.has(this.collection)) return result;

			// Only the character-grant path (buildSpellIndex) requests `system.classes`
			// and omits `name`; the spell-compendium browser does the reverse.
			const fields = options?.fields;
			const isGrantPath =
				Array.isArray(fields) && fields.includes('system.classes') && !fields.includes('name');
			if (!isGrantPath) return result;

			const coverage = await ensureCodexCoverage();
			if (!coverage || coverage.size === 0) return result;

			const filtered = new foundry.utils.Collection();
			for (const [key, entry] of result.entries()) {
				if (entry?.type === 'spell') {
					const school = entry?.system?.school;
					const tier = entry?.system?.tier ?? 0;
					// Drop the official spell only where the Codex replaces it.
					if (school && coverage.has(`${school}:${tier}`)) continue;
				}
				filtered.set(key, entry);
			}
			return filtered;
		} catch (error) {
			console.error(`[${MODULE_ID}] Spell-grant index filter failed`, error);
			return result;
		}
	};
	proto.__blueCodexSpellFilterPatched = true;
}

/**
 * Safety net: block an official-pack spell from being created on a character
 * when the Codex covers its school/tier. The `getIndex` filter normally keeps
 * official spells out of grants entirely; this catches any path that slips
 * through (e.g. a future change to the grant index-field signature).
 */
Hooks.on('preCreateItem', (item, data) => {
	try {
		if (!isReplaceSpellsEnabled()) return true;
		if (item?.type !== 'spell') return true;

		const actor = item?.parent;
		if (!(actor instanceof Actor) || actor.type !== 'character') return true;

		const source = item?._stats?.compendiumSource ?? data?._stats?.compendiumSource ?? '';
		if (typeof source !== 'string') return true;
		const isOfficial =
			source.startsWith('Compendium.nimble.nimble-spells.') ||
			source.startsWith('Compendium.nimble.nimble-secret-spells.');
		if (!isOfficial) return true;

		const school = item?.system?.school;
		const tier = item?.system?.tier ?? 0;
		if (codexCoverageSet && school && codexCoverageSet.has(`${school}:${tier}`)) {
			console.log(
				`[${MODULE_ID}] Blocked official spell "${item.name}" (${school} T${tier}) — Blue's Codex is the default magic system.`,
			);
			return false;
		}
	} catch (error) {
		console.error(`[${MODULE_ID}] preCreateItem spell filter failed`, error);
	}
	return true;
});

// ── Compendium tier badges ───────────────────────────────────────────────────
// The core Nimble spell compendium shows each spell's tier as a small badge in
// the list, so you can see at a glance which tier (and thus level) a spell is
// without opening it. That behaviour is hard-coded to the system's own spell
// packs, so we reproduce it for the Blue Codex spells pack — mirroring the
// sibling nim-plus-package. We reuse the system's own compendium level-badge
// CSS classes so the badge looks identical to the core one (a cantrip shows
// "C"; tiered spells show their tier number).
const SPELL_ENTRY_WITH_LEVEL_CLASS = 'nimble-compendium-entry-with-level';
const SPELL_LEVEL_BADGE_CLASS = 'nimble-compendium-entry-level';
const SPELL_LEVEL_NAME_FLEX_CLASS = 'nimble-class-feature-name-flex';

/**
 * Sort the compendium's spell entries by tier (cantrips first), tie-broken by
 * name, within each folder. Foundry's default sorting is alphabetical and its
 * `sort`/folder-sorting fields don't express tier order, so — like the sibling
 * nim-plus-package does for class-feature levels — we reorder the rendered DOM
 * on each render. Entries are grouped by their parent list element, so each
 * Book/school folder is sorted independently and the folder structure is kept.
 */
function sortSpellEntriesByTier(pack, container) {
	const entries = [];
	for (const entryElement of container.querySelectorAll('[data-entry-id]')) {
		const entryId = entryElement.dataset.entryId;
		if (!entryId || !entryElement.parentElement) continue;
		const indexEntry = pack.index.get(entryId);
		const tier = Number(foundry.utils.getProperty(indexEntry ?? {}, 'system.tier'));
		entries.push({
			entryElement,
			parentElement: entryElement.parentElement,
			tier: Number.isFinite(tier) ? tier : Number.MAX_SAFE_INTEGER,
			name: (indexEntry?.name ?? entryElement.textContent ?? '').trim(),
		});
	}

	const grouped = new Map();
	for (const entry of entries) {
		const list = grouped.get(entry.parentElement) ?? [];
		list.push(entry);
		grouped.set(entry.parentElement, list);
	}

	for (const [parent, list] of grouped) {
		list.sort((a, b) =>
			a.tier !== b.tier
				? a.tier - b.tier
				: a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
		);
		for (const entry of list) parent.append(entry.entryElement);
	}
}

function applySpellTierBadges(pack, container) {
	for (const entryElement of container.querySelectorAll('[data-entry-id]')) {
		const entryId = entryElement.dataset.entryId;
		if (!entryId) continue;
		const indexEntry = pack.index.get(entryId);
		const tier = Number(foundry.utils.getProperty(indexEntry ?? {}, 'system.tier'));
		if (!Number.isFinite(tier)) continue;

		const nameElement =
			entryElement.querySelector('.entry-name') ?? entryElement.querySelector('a') ?? entryElement;
		nameElement.classList.add(SPELL_LEVEL_NAME_FLEX_CLASS);
		nameElement.style.setProperty('display', 'flex', 'important');
		nameElement.style.setProperty('align-items', 'center', 'important');
		nameElement.style.setProperty('width', '100%', 'important');
		nameElement.style.setProperty('min-width', '0', 'important');

		let badge = nameElement.querySelector(`.${SPELL_LEVEL_BADGE_CLASS}`);
		if (!badge) {
			badge = document.createElement('span');
			badge.classList.add(SPELL_LEVEL_BADGE_CLASS);
			nameElement.append(badge);
		}
		badge.style.setProperty('margin-left', 'auto', 'important');
		badge.style.setProperty('margin-right', '6px', 'important');
		badge.style.setProperty('display', 'inline-block', 'important');
		badge.style.setProperty('white-space', 'nowrap', 'important');
		badge.textContent = tier === 0 ? 'C' : String(tier);
		entryElement.classList.add(SPELL_ENTRY_WITH_LEVEL_CLASS);
	}
}

Hooks.on('renderCompendium', (application, element) => {
	const pack = application?.collection;
	if (!pack || pack.collection !== CODEX_SPELLS_PACK) return;

	const container = element instanceof HTMLElement ? element : element?.[0];
	if (!(container instanceof HTMLElement)) return;

	pack
		.getIndex({ fields: ['system.tier'] })
		.then(() => {
			sortSpellEntriesByTier(pack, container);
			applySpellTierBadges(pack, container);
		})
		.catch((error) => {
			console.error(`[${MODULE_ID}] Failed to sort/badge spell entries`, error);
		});
});

const api = {};

Hooks.once('init', () => {
	console.log(`[${MODULE_ID}] Initializing.`);

	game.settings.register(MODULE_ID, SETTING_REPLACE_SPELLS, {
		name: "Blue's Codex is the default magic system",
		hint: "When enabled, leveling a spellcaster grants Blue's Codex spells instead of the official Nimble ones. Official spells for schools the Codex does not re-author (e.g. necrotic) are still granted. Disable to use the official Nimble spells.",
		scope: 'world',
		config: true,
		type: Boolean,
		default: true,
	});
});

Hooks.once('ready', () => {
	const module = game.modules.get(MODULE_ID);
	if (module) module.api = api;
	globalThis.blueCodex = api;

	patchSpellGrantIndex();
	// Warm the Codex coverage cache so the synchronous preCreateItem net has it.
	ensureCodexCoverage();
});
