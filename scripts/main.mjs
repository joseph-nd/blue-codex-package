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

// Set (to `{ actorId, subclassId }`) only while a character's native level-up
// dialog is open — see wrapTriggerLevelUp. Lets the class-feature index patch
// scope its subclass-pool injection to the character actually leveling up.
let levelUpContext = null;

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

// The level-up / character-creator feature pipeline (buildClassFeatureIndex)
// requests `system.selectionCountByLevel` and omits `name`; the subclass-feature
// index and the pool-option loader do not request selectionCountByLevel, and the
// compendium browser requests `name`. So this signature uniquely identifies the
// class-feature-selection index build.
function isClassFeatureIndexRequest(options) {
	const fields = options?.fields;
	return (
		Array.isArray(fields) &&
		fields.includes('system.selectionCountByLevel') &&
		fields.includes('system.group') &&
		!fields.includes('name')
	);
}

/**
 * During a native level-up for a character with a Blue's Codex subclass, add THIS
 * subclass's pool options (Chimeric Boons, Savage Arsenal, Sacred Decrees, …) to
 * the base class's native selection pool, so the level-up GUI's "Choose N" lists
 * the subclass options ALONGSIDE the base class's — one combined pick, not two.
 *
 * Nimble's `buildClassFeatureIndex` skips `subclass:true` features and cannot
 * scope a selection group to a subclass, so these options were hidden from the
 * native dialog and offered only through this module's own popup — on top of the
 * base pool the dialog already showed, making the player choose twice (e.g. 4
 * Chimeric Boons instead of 2). Here we un-hide the leveling subclass's options
 * in the module pack (carrying the pool's choose-count) so they merge into the
 * base group. The popup then degrades to a back-fill: `maybePromptPools` counts
 * every owned feature in the pool's group — base or subclass — so once the player
 * picks in the GUI it sees the pool satisfied and does not re-offer.
 *
 * Only the module pack is transformed; the core pack (the base options) passes
 * through untouched. Returns a transformed index Collection, or null to leave the
 * result unchanged. Gated on `levelUpContext` so nothing changes outside a
 * level-up.
 */
async function maybeInjectSubclassPoolOptions(pack, options, result) {
	const subclassId = levelUpContext?.subclassId;
	if (!subclassId) return null;
	if (pack.collection !== CLASS_FEATURES_PACK) return null;
	if (!isClassFeatureIndexRequest(options)) return null;

	const bySubclass = await loadPoolOptions();
	const poolOptions = bySubclass.get(subclassId);
	if (!poolOptions || poolOptions.length === 0) return null;

	const countByUuid = new Map(poolOptions.map((option) => [option.uuid, option.count]));

	const transformed = new foundry.utils.Collection();
	for (const [key, entry] of result.entries()) {
		if (entry?.type === 'feature' && countByUuid.has(entry.uuid)) {
			// Un-hide THIS subclass's pool options and give them the pool's choose-count
			// so they merge into the base group with the right native "Choose N" (the
			// options themselves store {}).
			transformed.set(key, {
				...entry,
				system: {
					...entry.system,
					subclass: false,
					selectionCountByLevel: countByUuid.get(entry.uuid),
				},
			});
		} else {
			transformed.set(key, entry);
		}
	}
	return transformed;
}

/**
 * Patch CompendiumCollection#getIndex so the official Nimble spell packs
 * contribute no Codex-covered spells to the character-grant index (while the
 * compendium browser, a different field signature, is left untouched), and so a
 * leveling character's subclass pool options replace the base class's generic
 * pool in the native level-up dialog (see maybeInjectSubclassPoolOptions).
 */
function patchSpellGrantIndex() {
	const CompendiumCollectionClass =
		foundry?.documents?.collections?.CompendiumCollection ?? globalThis.CompendiumCollection;
	const proto = CompendiumCollectionClass?.prototype;
	if (!proto?.getIndex || proto.__blueCodexSpellFilterPatched) return;

	const originalGetIndex = proto.getIndex;
	proto.getIndex = async function blueCodexPatchedGetIndex(options = {}) {
		const result = await originalGetIndex.call(this, options);
		// Subclass-scoped pool-option injection into the native level-up dialog
		// (independent of the official-spell setting handled below).
		try {
			const injected = await maybeInjectSubclassPoolOptions(this, options, result);
			if (injected) return injected;
		} catch (error) {
			console.error(`[${MODULE_ID}] Class-feature selection injection failed`, error);
		}
		try {
			if (!isReplaceSpellsEnabled()) return result;

			// Only the character-grant path (buildSpellIndex) requests `system.classes`
			// and omits `name`; the spell-compendium browser does the reverse.
			const fields = options?.fields;
			const isGrantPath =
				Array.isArray(fields) && fields.includes('system.classes') && !fields.includes('name');

			// During a school-swapping subclass's level-up, drop the base-school Codex
			// spells the character will not keep from the grant index, so the native
			// level-up preview stops listing spells the runtime swap immediately
			// replaces (e.g. an Invoker of Ether no longer sees Fire/Ice/Lightning in
			// "GRANTED SPELLS"). The base class's grantSpells rules hardcode the base
			// schools, so removing those spells here makes the rules resolve to nothing.
			// The chosen swapped schools are added back into the preview by the
			// transient carrier feature (createSwapGrantCarrier), which the native
			// grant then applies. Only affects the leveling character (gated on
			// levelUpContext) and only the Codex pack.
			if (this.collection === CODEX_SPELLS_PACK) {
				if (!isGrantPath) return result;
				const dropped = getLevelUpSwapDroppedSchools();
				if (!dropped || dropped.size === 0) return result;
				const filtered = new foundry.utils.Collection();
				for (const [key, entry] of result.entries()) {
					if (entry?.type === 'spell' && dropped.has(entry?.system?.school)) continue;
					filtered.set(key, entry);
				}
				return filtered;
			}

			if (!OFFICIAL_SPELL_PACKS.has(this.collection)) return result;
			if (!isGrantPath) return result;

			const coverage = (await ensureCodexCoverage()) ?? new Set();

			// During a necrotic-remapped class's own level-up, also hide official
			// necrotic from the grant preview / selection lists — Shadowmancer and
			// Shepherd learn a Codex school (shadow / death) in its place. Scoped to
			// that class via levelUpContext so Mage (Invoker of Control) and Songweaver,
			// which offer necrotic as a *choice*, are left untouched. The authoritative,
			// all-paths suppression is the preCreateItem block below.
			const dropNecrotic = !!CLASS_SPELL_REMAP[levelUpContext?.classId];

			const filtered = new foundry.utils.Collection();
			for (const [key, entry] of result.entries()) {
				if (entry?.type === 'spell') {
					const school = entry?.system?.school;
					const tier = entry?.system?.tier ?? 0;
					if (dropNecrotic && school === 'necrotic') continue;
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

		// Authoritative, all-paths suppression of official necrotic on the two base
		// necrotic casters that Blue's Codex re-homes (Shadowmancer → shadow,
		// Shepherd → death). Catches the school-, uuid- and selectSpell-mode grants
		// alike (they all funnel through here). Scoped to those classes so Mage /
		// Songweaver necrotic choices are untouched. classSpellRemapSync grants the
		// Codex replacement school.
		if (school === 'necrotic' && CLASS_SPELL_REMAP[getPrimaryClass(actor)?.classId]) {
			console.log(
				`[${MODULE_ID}] Blocked official necrotic spell "${item.name}" — re-homed to a Blue's Codex school for this class.`,
			);
			return false;
		}

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

// ── Spell-school filter icons ────────────────────────────────────────────────
// The character sheet's Spells tab renders a per-school filter row (and a
// per-card school marker) driven entirely by two plain objects on
// `CONFIG.NIMBLE`: `spellSchools` (label) and `spellSchoolIcons` (a Font Awesome
// class string rendered as `<i class="…">`). Core only defines six schools
// (fire, ice, lightning, necrotic, radiant, wind), so Blue's Codex's extra
// schools get no filter tab and a blank marker. We inject the missing schools
// here. Values are plain display strings (the system's `localize(label ?? key)`
// passes unknown strings through unchanged) and stock Font Awesome 6 Free solid
// glyphs, matching the system's monochrome, single-theme-color icon style — no
// per-school tint, exactly like the six built-in schools.
const CODEX_SPELL_SCHOOLS = {
	earth: { label: 'Earth', icon: 'fa-solid fa-mountain' },
	water: { label: 'Water', icon: 'fa-solid fa-water' },
	illusion: { label: 'Illusion', icon: 'fa-solid fa-mask' },
	domination: { label: 'Domination', icon: 'fa-solid fa-brain' },
	inspiration: { label: 'Inspiration', icon: 'fa-solid fa-lightbulb' },
	protection: { label: 'Protection', icon: 'fa-solid fa-shield-halved' },
	divination: { label: 'Divination', icon: 'fa-solid fa-eye' },
	nature: { label: 'Nature', icon: 'fa-solid fa-leaf' },
	shadow: { label: 'Shadow', icon: 'fa-solid fa-moon' },
	death: { label: 'Death', icon: 'fa-solid fa-skull-crossbones' },
	blood: { label: 'Blood', icon: 'fa-solid fa-droplet' },
	curse: { label: 'Curse', icon: 'fa-solid fa-spider' },
};

function registerSpellSchoolIcons() {
	const config = CONFIG?.NIMBLE;
	if (!config?.spellSchools || !config?.spellSchoolIcons) {
		console.warn(`[${MODULE_ID}] CONFIG.NIMBLE spell-school config missing; cannot register school filter icons.`);
		return;
	}
	for (const [key, { label, icon }] of Object.entries(CODEX_SPELL_SCHOOLS)) {
		// Don't clobber a school the core system (or another module) already defines.
		config.spellSchools[key] ??= label;
		config.spellSchoolIcons[key] ??= icon;
	}
}

Hooks.once('init', () => {
	console.log(`[${MODULE_ID}] Initializing.`);

	registerSpellSchoolIcons();

	game.settings.register(MODULE_ID, SETTING_REPLACE_SPELLS, {
		name: "Blue's Codex is the default magic system",
		hint: "When enabled, leveling a spellcaster grants Blue's Codex spells instead of the official Nimble ones. Official spells for schools the Codex does not re-author (e.g. necrotic) are still granted. Disable to use the official Nimble spells.",
		scope: 'world',
		config: true,
		type: Boolean,
		default: true,
	});
});

// Safety net: if the system's `CONFIG.NIMBLE` wasn't ready at our `init` (hook
// order), `setup` runs after every module's `init`. `??=` keeps it idempotent.
Hooks.once('setup', () => {
	registerSpellSchoolIcons();
});

Hooks.once('ready', () => {
	const module = game.modules.get(MODULE_ID);
	if (module) module.api = api;
	globalThis.blueCodex = api;

	patchSpellGrantIndex();
	// Rewrite the necrotic-caster / Songweaver class-feature spell rules so the
	// creation & level-up dialogs preview and grant the Codex schools.
	installFromUuidRewrite();
	// Reusable on-hit automation: wrap item activation so a marked actor's next
	// attack rolls at disadvantage, and listen for hits that apply the mark.
	installOnHitAutomation();
	// Summon automation: combat-end + Safe Rest cleanup for spawned companions
	// (the spawn/gate/charge hooks piggyback on the on-hit install above).
	installSummonAutomation();
	// Shadowmancer casting rules: custom spell-tier cap table + Pilfered Power
	// flat 1-mana cost.
	installShadowmancerCasting();
	// Warm the Codex coverage cache so the synchronous preCreateItem net has it.
	ensureCodexCoverage();
	// Warm the subclass-pool option + auto-grant indexes.
	loadPoolOptions();
	loadAutoGrantFeatures();
	// Warm the Codex spell-by-school index for subclass spell-school swaps.
	loadCodexSpellsBySchool();

	// Install the level-up wrap eagerly if a character actor already exists (else
	// it installs on the first character sheet render).
	for (const actor of game.actors ?? []) {
		if (actor?.type === 'character') {
			wrapTriggerLevelUp(actor);
			break;
		}
	}
});

// ── Subclass-scoped ability pools (choose one) ───────────────────────────────
// Blue's Codex subclasses expand their class's choose-pools (Savage Arsenal,
// Sacred Decrees, Underhanded Abilities, Thrill of the Hunt, Spellshaper,
// Invocations, Sacred Graces, Lyrical Weaponry / A "People" Person, Direbeast
// Forms / Chimeric Boons, Commander's Orders / Tactics / Weapon Mastery). Nimble
// has NO native subclass-scoped selection — a class selection group leaks to
// every subclass of the class. So these options are authored as decoupled
// subclass features (invisible to both native grant paths: subclass:true keeps
// them out of the class-feature index, and gainedAtLevels:[] keeps them out of
// the subclass index) carrying `flags.<module>.pool = { subclass, name, group,
// levels, count }`. This runtime presents the subclass-scoped choice at the
// pool's milestone levels and grants the picks. It is an idempotent back-fill:
// it offers only (picks owed by the character's level) − (picks already made).
const CLASS_FEATURES_PACK = `${MODULE_ID}.blue-codex-class-features`;

function escapeHtml(value) {
	return String(value ?? '').replace(
		/[&<>"']/g,
		(ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
	);
}

// Escape a literal string for safe embedding in a RegExp source.
function escapeRegExp(value) {
	return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let poolOptionsPromise = null;
/** Index every subclass-pool option out of the class-features pack, by subclass slug. */
function loadPoolOptions() {
	if (!poolOptionsPromise) {
		poolOptionsPromise = (async () => {
			const pack = game.packs.get(CLASS_FEATURES_PACK);
			if (!pack) return new Map();
			const index = await pack.getIndex({
				fields: ['type', 'name', 'img', 'system.identifier', `flags.${MODULE_ID}.pool`],
			});
			const bySubclass = new Map();
			for (const entry of index) {
				if (entry.type !== 'feature') continue;
				const pool = foundry.utils.getProperty(entry, `flags.${MODULE_ID}.pool`);
				if (!pool || !pool.subclass) continue;
				if (!bySubclass.has(pool.subclass)) bySubclass.set(pool.subclass, []);
				bySubclass.get(pool.subclass).push({
					uuid: entry.uuid,
					name: entry.name,
					img: entry.img,
					identifier: entry.system?.identifier,
					poolGroup: pool.group,
					poolName: pool.name,
					levels: Array.isArray(pool.levels) ? pool.levels : [],
					count: pool.count && typeof pool.count === 'object' ? pool.count : {},
				});
			}
			return bySubclass;
		})().catch((error) => {
			console.error(`[${MODULE_ID}] Failed to index subclass-pool options`, error);
			return new Map();
		});
	}
	return poolOptionsPromise;
}

function getPrimaryClass(actor) {
	for (const item of actor.items ?? []) {
		if (item.type !== 'class') continue;
		return {
			classId: item.system?.identifier || item.name?.slugify?.({ strict: true }) || '',
			classLevel: Number(item.system?.classLevel ?? 0) || 0,
		};
	}
	return null;
}

function getActorSubclassId(actor, classId) {
	for (const item of actor.items ?? []) {
		if (item.type !== 'subclass') continue;
		if (classId && item.system?.parentClass && item.system.parentClass !== classId) continue;
		return item.system?.identifier || item.name?.slugify?.({ strict: true }) || '';
	}
	return '';
}

/** Total picks a pool owes by `level` = Σ countAt(milestone) for milestones ≤ level. */
function picksOwed(levels, count, level) {
	let owed = 0;
	for (const milestone of levels) {
		if (milestone <= level) owed += Number(count?.[String(milestone)] ?? 1) || 0;
	}
	return owed;
}

/**
 * For a subclass's options at a level, list the pools that still owe picks.
 *
 * A pool's picks can now be satisfied natively (the level-up GUI merges the
 * subclass options into the base class's pool group), so "owned" is counted by
 * GROUP membership — every owned feature whose `system.group` is the pool group,
 * base OR subclass — not just this module's subclass options. That way a base
 * pick made in the GUI counts, and this popup only fires as a back-fill (when the
 * group has fewer picks than the level owes). `available` stays the subclass
 * options not yet owned, so a back-fill offers the themed choices.
 */
function owedPools(options, ownedIdentifiers, ownedGroupCounts, level) {
	const pools = new Map();
	for (const option of options) {
		if (!pools.has(option.poolGroup)) {
			pools.set(option.poolGroup, {
				group: option.poolGroup,
				name: option.poolName,
				levels: option.levels,
				count: option.count,
				options: [],
			});
		}
		pools.get(option.poolGroup).options.push(option);
	}
	const result = [];
	for (const pool of pools.values()) {
		const ownedInGroup = ownedGroupCounts.get(pool.group) ?? 0;
		const available = pool.options.filter((o) => !ownedIdentifiers.has(o.identifier));
		const need = Math.min(picksOwed(pool.levels, pool.count, level) - ownedInGroup, available.length);
		if (need > 0) result.push({ ...pool, need, available });
	}
	return result;
}

async function grantPoolOption(actor, option) {
	const doc = await fromUuid(option.uuid);
	if (!doc) return null;
	const obj = doc.toObject();
	delete obj._id;
	obj._stats = obj._stats ?? {};
	obj._stats.compendiumSource = doc.uuid;
	const [created] = await actor.createEmbeddedDocuments('Item', [obj]);
	return created ?? null;
}

/** Present one pool's "choose N" as a checkbox dialog; returns the chosen options. */
async function promptPoolChoice(actor, pool) {
	const rows = pool.available
		.map(
			(option) => `
			<label class="blue-codex-pool-pick">
				<input type="checkbox" name="blue-codex-pool-pick" value="${escapeHtml(option.identifier)}">
				<img src="${escapeHtml(option.img)}" width="32" height="32">
				<span>${escapeHtml(option.name)}</span>
			</label>`,
		)
		.join('');

	while (true) {
		// eslint-disable-next-line no-await-in-loop
		const picked = await foundry.applications.api.DialogV2.wait({
			window: { title: `${actor.name} — ${pool.name}` },
			content: `<form class="blue-codex-pool-form">
					<p>Choose <strong>${pool.need}</strong> ${escapeHtml(pool.name)} option${
						pool.need > 1 ? 's' : ''
					} for your subclass:</p>
					<div class="blue-codex-pool-list">${rows}</div>
				</form>
				<style>
					.blue-codex-pool-pick{display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer}
					.blue-codex-pool-pick img{border:none;border-radius:4px;flex:0 0 auto}
					.blue-codex-pool-list{max-height:340px;overflow:auto}
				</style>`,
			buttons: [
				{
					action: 'confirm',
					label: 'Confirm',
					default: true,
					callback: (_event, button, dialog) => {
						const root =
							dialog?.element ?? button?.closest?.('.application') ?? button?.form ?? document;
						return [...root.querySelectorAll('input[name="blue-codex-pool-pick"]:checked')].map(
							(input) => input.value,
						);
					},
				},
			],
			rejectClose: false,
			modal: true,
		}).catch(() => null);

		if (!Array.isArray(picked)) return []; // dismissed / cancelled
		if (picked.length !== pool.need) {
			ui.notifications?.warn(`Choose exactly ${pool.need} ${pool.name} option(s).`);
			continue;
		}
		const chosenSet = new Set(picked);
		return pool.available.filter((option) => chosenSet.has(option.identifier));
	}
}

// Guard against the render-storm: track in-flight prompts and per-actor
// declines so a cancelled prompt doesn't immediately reopen every re-render.
const poolPromptActive = new Set();
const poolDeclinedAtLevel = new Map();

async function maybePromptPools(actor) {
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	if (poolPromptActive.has(actor.id)) return;

	const classInfo = getPrimaryClass(actor);
	if (!classInfo?.classId || classInfo.classLevel < 1) return;
	const subclassId = getActorSubclassId(actor, classInfo.classId);
	if (!subclassId) return;

	const bySubclass = await loadPoolOptions();
	const options = bySubclass.get(subclassId);
	if (!options || options.length === 0) return;

	const ownedIdentifiers = new Set(
		(actor.items ?? [])
			.filter(
				(item) =>
					item.type === 'feature' &&
					foundry.utils.getProperty(item, `flags.${MODULE_ID}.pool`),
			)
			.map((item) => item.system?.identifier),
	);

	// Picks already made in the native level-up GUI count toward a pool even when
	// they are base-class options (no pool flag), so tally by group membership.
	const ownedGroupCounts = new Map();
	for (const item of actor.items ?? []) {
		if (item.type !== 'feature') continue;
		const group = item.system?.group;
		if (group) ownedGroupCounts.set(group, (ownedGroupCounts.get(group) ?? 0) + 1);
	}

	const owed = owedPools(options, ownedIdentifiers, ownedGroupCounts, classInfo.classLevel);
	if (owed.length === 0) {
		poolDeclinedAtLevel.delete(actor.id);
		return;
	}
	if (poolDeclinedAtLevel.get(actor.id) === classInfo.classLevel) return;

	poolPromptActive.add(actor.id);
	try {
		for (const pool of owed) {
			// eslint-disable-next-line no-await-in-loop
			const chosen = await promptPoolChoice(actor, pool);
			if (chosen.length === 0) {
				// User cancelled — remember the level so we don't nag until they level again.
				poolDeclinedAtLevel.set(actor.id, classInfo.classLevel);
				break;
			}
			for (const option of chosen) {
				// eslint-disable-next-line no-await-in-loop
				await grantPoolOption(actor, option);
			}
			ui.notifications?.info(
				`${actor.name} gained ${chosen.map((o) => o.name).join(', ')}.`,
			);
		}
	} finally {
		poolPromptActive.delete(actor.id);
	}
}

// ── Auto-granted subclass features (back-fill) ───────────────────────────────
// Auto-grant subclass features (the Zephyr Air/Water forms, and the fixed
// level-3/7/11/15 features) are granted natively only DURING the level-up that
// reaches their level. A character that reached a level before this content
// existed — or before a rank's forms were authored — never receives them, since
// Nimble does not back-fill. This grants any missing auto-grant feature for the
// character's subclass up to its current level. Auto-grant subclass features are
// distinguished from choose-pool options by their `group` (== the subclass slug)
// and a NON-empty `gainedAtLevels` (pool options carry `group` == native pool
// and `gainedAtLevels: []`).
let autoGrantPromise = null;
function loadAutoGrantFeatures() {
	if (!autoGrantPromise) {
		autoGrantPromise = (async () => {
			const pack = game.packs.get(CLASS_FEATURES_PACK);
			if (!pack) return new Map();
			const index = await pack.getIndex({
				fields: [
					'type',
					'name',
					'system.subclass',
					'system.group',
					'system.gainedAtLevels',
					'system.identifier',
				],
			});
			const bySubclass = new Map();
			for (const entry of index) {
				if (entry.type !== 'feature') continue;
				const system = entry.system ?? {};
				if (!system.subclass || !system.group) continue;
				const levels = Array.isArray(system.gainedAtLevels) ? system.gainedAtLevels : [];
				if (levels.length === 0) continue; // pool options carry []
				if (!bySubclass.has(system.group)) bySubclass.set(system.group, []);
				bySubclass.get(system.group).push({
					uuid: entry.uuid,
					name: entry.name,
					identifier: system.identifier,
					levels,
				});
			}
			return bySubclass;
		})().catch((error) => {
			console.error(`[${MODULE_ID}] Failed to index auto-grant features`, error);
			return new Map();
		});
	}
	return autoGrantPromise;
}

const autoGrantActive = new Set();

async function backfillAutoGrants(actor) {
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	if (autoGrantActive.has(actor.id)) return;

	const classInfo = getPrimaryClass(actor);
	if (!classInfo?.classId || classInfo.classLevel < 1) return;
	const subclassId = getActorSubclassId(actor, classInfo.classId);
	if (!subclassId) return;

	const bySubclass = await loadAutoGrantFeatures();
	const features = bySubclass.get(subclassId);
	if (!features || features.length === 0) return;

	const ownedSources = new Set(
		(actor.items ?? []).map((item) => item._stats?.compendiumSource).filter(Boolean),
	);
	const ownedIdentifiers = new Set(
		(actor.items ?? [])
			.filter((item) => item.type === 'feature')
			.map((item) => item.system?.identifier),
	);

	const missing = features.filter(
		(feature) =>
			feature.levels.some((level) => level <= classInfo.classLevel) &&
			!ownedSources.has(feature.uuid) &&
			!ownedIdentifiers.has(feature.identifier),
	);
	if (missing.length === 0) return;

	autoGrantActive.add(actor.id);
	try {
		const docs = await Promise.all(missing.map((feature) => fromUuid(feature.uuid)));
		const toCreate = [];
		for (const doc of docs) {
			if (!doc) continue;
			const obj = doc.toObject();
			delete obj._id;
			obj._stats = obj._stats ?? {};
			obj._stats.compendiumSource = doc.uuid;
			toCreate.push(obj);
		}
		if (toCreate.length > 0) {
			await actor.createEmbeddedDocuments('Item', toCreate);
			ui.notifications?.info(
				`${actor.name} gained ${toCreate.length} subclass feature${
					toCreate.length > 1 ? 's' : ''
				}.`,
			);
		}
	} finally {
		autoGrantActive.delete(actor.id);
	}
}

// ── Subclass spell-school swaps ──────────────────────────────────────────────
// Four core spellcasting classes (Mage, Shepherd, Stormshifter, Songweaver) have
// Blue's Codex subclasses that change which spell schools the caster learns.
// Per the book the mechanic is NOT uniform: Invoker of Ether "No More Elements"
// FULLY replaces the mage's Book of Elements with the Book of Ether; most others
// ADD a school and cap the caster at 3 known schools (so an over-cap subclass, or
// one whose flavor replaces a base school, makes the player drop one). The book
// also frames this as the player's choice ("either replace at level 3 or select
// the new school from level 1"), so the module OFFERS the choice in a dialog at
// level-up rather than forcing it.
//
// A caster's granted schools normally come from `grantSpells auto` rules baked
// into the *system's* class features, which keep granting the base schools at
// every tier regardless of subclass — so we can't express this in our data. This
// runtime instead: (1) prompts the player for their final school set when they
// take one of these subclasses, (2) removes owned spells of dropped schools and
// grants every Codex spell of the chosen schools up to the caster's unlocked
// tiers (idempotent back-fill, so higher tiers fill in on later level-ups), and
// (3) blocks the base class from granting any non-chosen managed school.
//
// Invoker of Knowledge (Grimoire — scribe any spells manually) and Herald of
// Swords (martial, no schools) are intentionally NOT listed: they get no school
// automation.

// Every spell school the four classes / their subclasses can grant. Spells whose
// school is in this set are "managed": droppable on a swap and blockable when not
// chosen. `necrotic` is the official-pack school the Codex doesn't re-author yet
// (Shepherd), included so it participates in the 3-school cap but never granted
// from the Codex pack (it isn't in it). `utility` is deliberately excluded —
// utility spells are school-agnostic and never swapped.
const MANAGED_SPELL_SCHOOLS = new Set([
	'fire', 'ice', 'earth', 'lightning', 'water', 'wind', // Book of Elements
	'illusion', 'domination', 'inspiration', // Book of Ether
	'radiant', 'protection', 'divination', 'nature', // Book of Radiance
	'shadow', 'death', 'blood', 'curse', // Book of Ruin
	'necrotic', // official (Shepherd) — counts toward the cap, never Codex-granted
]);

// Per-subclass school policy. `mandatory` = schools the subclass forces you to
// know; `choose` = either/or pairs the player picks one school from; `cap` = max
// known schools; `replaceAll` = the mandatory/chosen schools become your ENTIRE
// set (drop every base school) rather than being added to it.
const SUBCLASS_SPELL_POLICY = {
	// ── Mage (base auto: fire/ice/lightning) ──
	'invoker-of-ether': {
		mandatory: ['illusion', 'domination', 'inspiration'],
		cap: 3,
		replaceAll: true,
		newLabel: 'Book of Ether (Illusion, Domination, Inspiration)',
		summary:
			'“No More Elements.” Replace your Book of Elements spell schools with the Book of Ether. You will only learn Illusion, Domination and Inspiration spells from now on.',
	},
	'invoker-of-elements': {
		mandatory: ['fire', 'earth'],
		choose: [
			{ label: 'Ice or Water', options: ['ice', 'water'] },
			{ label: 'Wind or Lightning', options: ['wind', 'lightning'] },
		],
		cap: 4,
		replaceAll: true,
		newLabel: 'four Book of Elements schools',
		summary:
			'Elementalist: you know Fire and Earth, plus either Ice or Water, and either Wind or Lightning.',
	},
	// ── Shepherd (base auto: radiant + necrotic) ──
	'luminary-of-fate': { mandatory: ['divination'], cap: 3, summary: 'Learn Divination spells. You can know only 3 spell schools.' },
	'luminary-of-storms': { mandatory: ['lightning'], cap: 3, summary: 'Learn Lightning spells. You can know only 3 spell schools.' },
	'luminary-of-trickery': { mandatory: ['illusion'], cap: 3, summary: 'Learn Illusion spells. You can know only 3 spell schools.' },
	// ── Stormshifter (base auto: lightning + wind) ──
	'circle-of-earth': { mandatory: ['earth'], cap: 3, summary: 'Learn Earth spells.' },
	'circle-of-hunger': { mandatory: ['shadow', 'illusion'], cap: 3, summary: 'Learn Shadow and Illusion spells. You can know only 3 spell schools.' },
	'circle-of-spores': { mandatory: ['nature'], cap: 3, summary: 'Learn Nature spells.' },
	// ── Songweaver (base auto: wind + 1 chosen) ──
	'herald-of-disruption': { mandatory: ['domination'], cap: 3, summary: 'Learn Domination spells.' },
	'herald-of-inspiration': { mandatory: ['inspiration'], cap: 3, summary: 'Learn Inspiration spells.' },
};

// ── Class-level necrotic re-home ─────────────────────────────────────────────
// necrotic is the one base spell school Blue's Codex doesn't re-author — it splits
// it into shadow / death / blood / curse — so the coverage filter can't auto-swap
// it the way it does fire / radiant / etc. The two base necrotic casters are
// remapped here (keyed by class identifier → the Codex school they learn instead):
// their official necrotic grants are suppressed (grant-index drop + preCreateItem
// block, which together catch the school-, uuid- and selectSpell-mode grants) and
// the Codex replacement school is granted at runtime by classSpellRemapSync, one
// tier at a time. Only these two classes grant necrotic as a fixed part of their
// progression; Mage (Invoker of Control) and Songweaver merely *offer* it as a
// choice and are deliberately excluded so those picks keep working.
const CLASS_SPELL_REMAP = {
	shadowmancer: 'shadow',
	shepherd: 'death',
};

// ── System class-feature spell-rule rewrites ─────────────────────────────────
// The character-creation and level-up dialogs read each class feature's own
// `grantSpells` rules (via the global `fromUuid`) both to PREVIEW and to GRANT
// spells. To make those dialogs reflect Blue's Codex schools we rewrite the rules
// of the relevant SYSTEM features as they're resolved (see installFromUuidRewrite).
// Keyed by `system.class`:
//   swap        — replace these school names wherever they appear in a grantSpells
//                 rule's `schools` (Shadowmancer/Shepherd necrotic → shadow/death;
//                 Songweaver's necrotic *choice* → death).
//   uuidMap     — remap the specific spell UUIDs of a uuid-only grant 1:1
//                 (Shadowmancer's conduit-of-shadow patron cantrips: official necrotic
//                 Shadow Blast/Summon Shadow → their Codex-shadow equivalents), so the
//                 level-1 caster previews/learns exactly those two Codex spells rather
//                 than the whole school.
//   addSchools  — extend a `selectSchool` rule's option list (Songweaver gains the
//                 Book of Ether + Divination + Curse as choosable additional schools).
const CLASS_FEATURE_SPELL_REWRITES = {
	shadowmancer: {
		swap: { necrotic: 'shadow' },
		uuidMap: {
			'Compendium.nimble.nimble-spells.Item.9TNPdOXlCcGgxw6r':
				'Compendium.blue-codex-package.blue-codex-spells.Item.enkqIepuxNVpUsCh',
			'Compendium.nimble.nimble-spells.Item.ho2KADcmQWWTeYR0':
				'Compendium.blue-codex-package.blue-codex-spells.Item.nrDkGygSyNE6JR7n',
		},
	},
	shepherd: { swap: { necrotic: 'death' } },
	songweaver: {
		swap: { necrotic: 'death' },
		addSchools: ['illusion', 'domination', 'inspiration', 'divination', 'curse'],
	},
};

/** Order-preserving de-dupe of a string list. */
function uniqueList(list) {
	const seen = new Set();
	return list.filter((value) => (seen.has(value) ? false : seen.add(value)));
}

/**
 * Return a rewritten copy of a feature's `rules` per `cfg`, or null when nothing
 * changed. Only `grantSpells` rules are touched.
 */
function rewriteFeatureSpellRules(rules, cfg) {
	let changed = false;
	const out = rules.map((rule) => {
		if (rule?.type !== 'grantSpells') return rule;

		// A uuid-only grant (no schools) → remap those specific spell UUIDs 1:1 to
		// their Codex equivalents, preserving the precise (2-spell) grant.
		if (cfg.uuidMap && Array.isArray(rule.uuids) && rule.uuids.length && !rule.schools?.length) {
			const mapped = rule.uuids.map((u) => cfg.uuidMap[u] ?? u);
			if (mapped.join(',') !== rule.uuids.join(',')) {
				changed = true;
				return { ...rule, uuids: mapped };
			}
			return rule;
		}

		if (Array.isArray(rule.schools) && rule.schools.length) {
			let schools = rule.schools.map((school) => cfg.swap?.[school] ?? school);
			if (cfg.addSchools && rule.mode === 'selectSchool') schools = [...schools, ...cfg.addSchools];
			schools = uniqueList(schools);
			if (schools.join(',') !== rule.schools.join(',')) {
				changed = true;
				return { ...rule, schools };
			}
		}
		return rule;
	});
	return changed ? out : null;
}

// fromUuid returns cached compendium docs; rewriting one in place (idempotently)
// updates every reader. The WeakSet skips docs already handled; the rewrite itself
// is idempotent anyway (re-running finds no necrotic / already-added schools).
const rewrittenFeatureDocs = new WeakSet();

/**
 * Wrap the global `fromUuid` so a SYSTEM class feature belonging to a rewritten
 * class comes back with Codex-adjusted grantSpells rules. This is the single point
 * that makes the creation/level-up dialogs both preview and grant the Codex schools
 * (Shadowmancer→shadow, Shepherd→death, Songweaver's extra-school choice). Gated on
 * the `replaceOfficialSpells` setting; fully guarded so a failure leaves fromUuid
 * behaving normally.
 */
function installFromUuidRewrite() {
	const original = globalThis.fromUuid;
	if (typeof original !== 'function' || original.__blueCodexRewrapped) return;
	const wrapped = async function blueCodexFromUuid(...args) {
		const doc = await original.apply(this, args);
		try {
			if (!isReplaceSpellsEnabled()) return doc;
			if (!doc || doc.type !== 'feature' || rewrittenFeatureDocs.has(doc)) return doc;
			const cfg = doc.system?.class ? CLASS_FEATURE_SPELL_REWRITES[doc.system.class] : null;
			if (!cfg) return doc;
			const rules = doc.system?.rules;
			if (Array.isArray(rules)) {
				const rewritten = rewriteFeatureSpellRules(rules, cfg);
				if (rewritten) doc.updateSource({ 'system.rules': rewritten });
			}
			rewrittenFeatureDocs.add(doc);
		} catch (error) {
			console.error(`[${MODULE_ID}] fromUuid spell-rule rewrite failed`, error);
		}
		return doc;
	};
	wrapped.__blueCodexRewrapped = true;
	globalThis.fromUuid = wrapped;
}

/**
 * The managed spell schools to hide from the grant index during the current
 * level-up, so the native "GRANTED SPELLS" preview doesn't list base-class
 * spells that a school-swapping subclass will immediately replace. Returns a
 * Set of school keys, or null when the leveling character isn't a swap subclass.
 *
 * Prefers the character's stored final school set (recorded once they answer the
 * swap prompt); before that (e.g. the level-3 level-up that first grants the
 * subclass) it falls back to the subclass policy — for a full-replacement
 * subclass, every managed school except the ones it is guaranteed to keep (its
 * mandatory schools plus every option a choose-pair might resolve to, since we
 * can't yet know which the player picks). For an add-and-cap subclass with no
 * stored choice yet the dropped base schools aren't knowable, so nothing is
 * hidden (never hide a school the character might keep).
 */
function getLevelUpSwapDroppedSchools() {
	const ctx = levelUpContext;
	if (!ctx?.subclassId) return null;
	const policy = SUBCLASS_SPELL_POLICY[ctx.subclassId];
	if (!policy) return null;

	const actor = game.actors?.get?.(ctx.actorId);
	const stored = actor?.getFlag?.(MODULE_ID, 'spellSchools');
	let keep;
	if (stored && stored.subclass === ctx.subclassId && Array.isArray(stored.schools)) {
		keep = new Set(stored.schools);
	} else if (policy.replaceAll) {
		keep = new Set(policy.mandatory ?? []);
		for (const pair of policy.choose ?? []) for (const opt of pair.options) keep.add(opt);
	} else {
		return null;
	}

	const dropped = new Set();
	for (const school of MANAGED_SPELL_SCHOOLS) {
		if (!keep.has(school)) dropped.add(school);
	}
	return dropped;
}

// Flag marking the transient "carrier" feature created during a swap subclass's
// level-up (see createSwapGrantCarrier). It exists only for the lifetime of the
// level-up dialog so the native preview/grant can see the swapped schools, then
// is removed — it never persists on the sheet.
const SWAP_GRANT_CARRIER_FLAG = 'swapGrantCarrier';

/**
 * Build `grantSpells auto` rules that grant every Codex spell of `schools` up to
 * the tier unlocked at each level, mirroring a caster's tier progression (tier 0
 * at level 1, tier T at level 2·T). Fed to the native level-up dialog via a
 * carrier feature so its "Granted Spells" preview lists the schools a swap
 * subclass actually gains (Book of Ether, etc.) with correct school headers.
 */
function buildSwapGrantRules(schools) {
	const schoolList = [...schools];
	const rules = [];
	for (let tier = 0; tier <= 9; tier += 1) {
		const rule = {
			id: `blue-codex-swap-grant-t${tier}`,
			type: 'grantSpells',
			mode: 'auto',
			schools: schoolList,
			tiers: [tier],
		};
		if (tier > 0) rule.predicate = { level: { min: tier * 2 } };
		rules.push(rule);
	}
	return rules;
}

/**
 * Create the transient carrier feature for a school-swapping subclass's level-up
 * (returns its id, or null). The base class's own grantSpells rules are hidden by
 * getLevelUpSwapDroppedSchools; this adds the character's chosen schools back so
 * the native preview shows what they'll actually gain — and the native submit
 * grants those spells (idempotent with the runtime swap, which dedupes on
 * compendiumSource). grantSpells rules have no create-time side effects, so the
 * carrier is inert except inside the level-up dialog. Returns null before the
 * player has chosen their schools (the level-3 level-up), since the swap prompt
 * runs after that submit.
 */
async function createSwapGrantCarrier(actor, subclassId) {
	try {
		if (!isReplaceSpellsEnabled()) return null;
		if (!subclassId) return null;
		const policy = SUBCLASS_SPELL_POLICY[subclassId];
		if (!policy) return null;
		const stored = actor.getFlag(MODULE_ID, 'spellSchools');
		if (
			!stored ||
			stored.subclass !== subclassId ||
			!Array.isArray(stored.schools) ||
			stored.schools.length === 0
		) {
			return null;
		}
		const [created] = await actor.createEmbeddedDocuments('Item', [
			{
				name: "Blue's Codex Spellcasting",
				type: 'feature',
				system: { rules: buildSwapGrantRules(stored.schools) },
				flags: { [MODULE_ID]: { [SWAP_GRANT_CARRIER_FLAG]: true } },
			},
		]);
		return created?.id ?? null;
	} catch (error) {
		console.error(`[${MODULE_ID}] Failed to create transient spell-grant carrier`, error);
		return null;
	}
}

/**
 * Remove any leftover carrier features (e.g. from a crash or forced reload mid
 * level-up). Skips the actor currently leveling — that carrier is live and owned
 * by the triggerLevelUp wrapper's own cleanup.
 */
const carrierSweepInFlight = new Set();

async function sweepStaleGrantCarriers(actor) {
	if (levelUpContext?.actorId === actor.id) return;
	if (carrierSweepInFlight.has(actor.id)) return;
	carrierSweepInFlight.add(actor.id);
	try {
		const stale = (actor.items ?? [])
			.filter((item) =>
				foundry.utils.getProperty(item, `flags.${MODULE_ID}.${SWAP_GRANT_CARRIER_FLAG}`),
			)
			.map((item) => item.id)
			.filter((id) => actor.items.get(id));
		if (stale.length === 0) return;
		await actor.deleteEmbeddedDocuments('Item', stale);
	} catch (error) {
		// A carrier can vanish mid-flight (the level-up wrapper's own cleanup owns
		// the live one); losing that race is harmless — stay quiet about it.
		if (!/does not exist/i.test(error?.message ?? '')) {
			console.error(`[${MODULE_ID}] Failed to sweep stale spell-grant carrier`, error);
		}
	} finally {
		carrierSweepInFlight.delete(actor.id);
	}
}

const SCHOOL_LABEL = (school) => school.charAt(0).toUpperCase() + school.slice(1);

/** Spell tier T unlocks at character level 2·T (cantrips at 1); this caps the tiers to grant. */
function maxSpellTierForLevel(level) {
	return Math.max(0, Math.min(9, Math.floor(Number(level ?? 0) / 2)));
}

/** The managed spell schools the actor currently knows (distinct across owned spell items). */
function getActorSpellSchools(actor) {
	const schools = new Set();
	for (const item of actor.items ?? []) {
		if (item.type !== 'spell') continue;
		const school = item.system?.school;
		if (school && MANAGED_SPELL_SCHOOLS.has(school)) schools.add(school);
	}
	return schools;
}

let codexSpellsBySchoolPromise = null;
/** Index the Codex spell pack as school → [{uuid, tier}], excluding secret spells. */
function loadCodexSpellsBySchool() {
	if (!codexSpellsBySchoolPromise) {
		codexSpellsBySchoolPromise = (async () => {
			const bySchool = new Map();
			const pack = game.packs?.get?.(CODEX_SPELLS_PACK);
			if (!pack) return bySchool;
			const index = await pack.getIndex({
				fields: ['type', 'system.school', 'system.tier', 'system.properties.selected'],
			});
			for (const entry of index) {
				if (entry.type !== 'spell') continue;
				const school = entry.system?.school;
				if (!school) continue;
				const selected = entry.system?.properties?.selected ?? [];
				if (selected.includes('secretSpell')) continue; // never auto-granted
				const tier = Number(entry.system?.tier ?? 0) || 0;
				if (!bySchool.has(school)) bySchool.set(school, []);
				bySchool.get(school).push({ uuid: entry.uuid, tier });
			}
			return bySchool;
		})().catch((error) => {
			console.error(`[${MODULE_ID}] Failed to index Codex spells by school`, error);
			return new Map();
		});
	}
	return codexSpellsBySchoolPromise;
}

/**
 * Offer the subclass's spell-school choice. Returns the final Set of chosen
 * schools, or null if the player dismissed the dialog (defer — re-offer later).
 */
async function promptSchoolChoice(actor, policy) {
	const mandatory = [...policy.mandatory];
	const choosePairs = policy.choose ?? [];
	const current = getActorSpellSchools(actor);
	// Slots left for keeping base schools once mandatory + one-per-choose are set.
	const slots = Math.max(0, policy.cap - mandatory.length - choosePairs.length);
	const keepCandidates = policy.replaceAll
		? []
		: [...current].filter((school) => !mandatory.includes(school));
	const mustPickKeep = slots > 0 && keepCandidates.length > slots;

	const mandatoryLine = mandatory.length
		? `<p>You gain: <strong>${mandatory.map(SCHOOL_LABEL).join(', ')}</strong>.</p>`
		: '';
	const chooseRows = choosePairs
		.map(
			(pair, index) => `
			<fieldset class="blue-codex-school-choose">
				<legend>${escapeHtml(pair.label)}</legend>
				${pair.options
					.map(
						(opt, oi) => `<label><input type="radio" name="blue-codex-choose-${index}" value="${escapeHtml(
							opt,
						)}" ${oi === 0 ? 'checked' : ''}> ${escapeHtml(SCHOOL_LABEL(opt))}</label>`,
					)
					.join('')}
			</fieldset>`,
		)
		.join('');
	const keepRows = mustPickKeep
		? `<fieldset class="blue-codex-school-keep">
				<legend>Keep ${slots} of your current school${slots > 1 ? 's' : ''}</legend>
				${keepCandidates
					.map(
						(school) => `<label><input type="checkbox" name="blue-codex-keep" value="${escapeHtml(
							school,
						)}"> ${escapeHtml(SCHOOL_LABEL(school))}</label>`,
					)
					.join('')}
			</fieldset>`
		: '';

	while (true) {
		// eslint-disable-next-line no-await-in-loop
		const result = await foundry.applications.api.DialogV2.wait({
			window: { title: `${actor.name} — Spell Schools` },
			content: `<form class="blue-codex-school-form">
					<p>${escapeHtml(policy.summary)}</p>
					${mandatoryLine}
					${chooseRows}
					${keepRows}
				</form>
				<style>
					.blue-codex-school-form fieldset{border:1px solid var(--color-border-light-tertiary,#666);border-radius:4px;margin:6px 0;padding:4px 8px}
					.blue-codex-school-form legend{padding:0 4px;font-weight:600}
					.blue-codex-school-form label{display:inline-flex;gap:4px;align-items:center;margin-right:12px;cursor:pointer}
				</style>`,
			buttons: [
				{
					action: 'confirm',
					label: 'Confirm',
					default: true,
					callback: (_event, button, dialog) => {
						const root = dialog?.element ?? button?.form ?? document;
						const chosen = choosePairs.map(
							(_pair, index) =>
								root.querySelector(`input[name="blue-codex-choose-${index}"]:checked`)?.value,
						);
						const keep = [...root.querySelectorAll('input[name="blue-codex-keep"]:checked')].map(
							(input) => input.value,
						);
						return { chosen, keep };
					},
				},
			],
			rejectClose: false,
			modal: true,
		}).catch(() => null);

		if (!result) return null; // dismissed — defer

		const { chosen, keep } = result;
		if (chosen.some((value) => !value)) continue; // a radio somehow unset
		const final = new Set([...mandatory, ...chosen]);
		if (mustPickKeep) {
			if (keep.length !== slots) {
				ui.notifications?.warn(`Keep exactly ${slots} of your current spell schools.`);
				continue;
			}
			for (const school of keep) final.add(school);
		} else {
			for (const school of keepCandidates) final.add(school); // room for all
		}
		return final;
	}
}

/**
 * Sync the actor's spell items toward `finalSchools`: (optionally) drop spells of
 * the schools this subclass no longer keeps, then grant every Codex spell of the
 * chosen schools in the tier band `(fromTier, unlocked tier]` they don't own.
 *
 * Both halves are ONE-TIME transitions, never per-render enforcement, so the
 * player keeps full manual control of their spellbook:
 *   - `fromTier` is the exclusive lower bound — the highest tier already granted
 *     for this school set. The initial school choice grants `(-1, maxTier]`, a
 *     later level-up grants only the newly-unlocked tiers, and a plain re-render
 *     grants nothing. Without it, a manually removed spell was re-added next render.
 *   - `pruneDropped` is true ONLY when the schools are actually (re)chosen. On a
 *     routine re-render it is false, so a spell the player deliberately added — from
 *     ANY school, including one this subclass "dropped" — is left untouched. The
 *     swap's school drop still happens once, at the moment of the choice.
 */
async function applySpellSchools(actor, finalSchools, level, fromTier = -1, pruneDropped = false) {
	const maxTier = maxSpellTierForLevel(level);
	const spellItems = (actor.items ?? []).filter((item) => item.type === 'spell');

	let removed = 0;
	if (pruneDropped) {
		const toDelete = spellItems
			.filter(
				(item) =>
					MANAGED_SPELL_SCHOOLS.has(item.system?.school) &&
					!finalSchools.has(item.system?.school),
			)
			.map((item) => item.id);
		if (toDelete.length) await actor.deleteEmbeddedDocuments('Item', toDelete);
		removed = toDelete.length;
	}

	const bySchool = await loadCodexSpellsBySchool();
	const ownedSources = new Set(
		(actor.items ?? []).map((item) => item._stats?.compendiumSource).filter(Boolean),
	);
	const ownedNameSchool = new Set(
		spellItems.map((item) => `${item.name}|${item.system?.school}`),
	);
	// A spell already learned via another path (e.g. the creation dialog's rewritten
	// grantSpells rules) can carry a different compendiumSource/name casing; its stable
	// `system.identifier` is the cross-path key that stops us re-creating a duplicate.
	const ownedIdentifiers = new Set(
		spellItems
			.filter((item) => item.system?.identifier)
			.map((item) => `${item.system.identifier}|${item.system?.school}`),
	);

	const toCreate = [];
	const seen = new Set();
	for (const school of finalSchools) {
		const list = bySchool.get(school); // necrotic/official schools aren't in the Codex pack
		if (!list) continue;
		for (const { uuid, tier } of list) {
			if (tier > maxTier || tier <= fromTier || seen.has(uuid) || ownedSources.has(uuid)) continue;
			seen.add(uuid);
			// eslint-disable-next-line no-await-in-loop
			const doc = await fromUuid(uuid);
			if (!doc) continue;
			if (ownedNameSchool.has(`${doc.name}|${doc.system?.school}`)) continue;
			if (doc.system?.identifier && ownedIdentifiers.has(`${doc.system.identifier}|${doc.system?.school}`)) continue;
			const obj = doc.toObject();
			delete obj._id;
			obj._stats = obj._stats ?? {};
			obj._stats.compendiumSource = doc.uuid;
			toCreate.push(obj);
		}
	}
	if (toCreate.length) await actor.createEmbeddedDocuments('Item', toCreate);
	return { removed, granted: toCreate.length };
}

// Guard against the render-storm (our own create/delete re-triggers the hooks).
const spellSyncActive = new Set();

async function spellSchoolSync(actor) {
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	if (spellSyncActive.has(actor.id)) return;

	const classInfo = getPrimaryClass(actor);
	if (!classInfo?.classId || classInfo.classLevel < 1) return;
	const subclassId = getActorSubclassId(actor, classInfo.classId);
	const policy = subclassId ? SUBCLASS_SPELL_POLICY[subclassId] : null;

	const stored = actor.getFlag(MODULE_ID, 'spellSchools');
	if (!policy) {
		// Respec away from a school-swapping subclass — drop the stale flag so it
		// stops blocking spell grants. (Existing spell items are left as-is.)
		if (stored) await actor.unsetFlag(MODULE_ID, 'spellSchools');
		return;
	}
	// Hold the guard continuously across prompt + setFlag + apply so our own
	// document writes (which re-fire the sheet-render hook) can't re-enter.
	spellSyncActive.add(actor.id);
	try {
		const maxTier = maxSpellTierForLevel(classInfo.classLevel);
		let finalSchools;
		// Exclusive lower bound of tiers to grant now: the highest tier already
		// granted for this school set. This makes the grant one-time-per-tier so a
		// manually removed spell is NOT re-added on the next render.
		let fromTier;
		// True only when the schools are actually (re)chosen — the one moment we
		// apply the swap's school drop. False on routine renders / level-ups so the
		// player's manual additions from any school survive.
		let pruneDropped = false;
		if (stored && stored.subclass === subclassId && Array.isArray(stored.schools)) {
			finalSchools = new Set(stored.schools);
			// Existing pick. `grantedTier` is the high-water mark. When it is absent
			// the flag pre-dates this field: the previous back-fill-every-render
			// behavior already granted every unlocked tier, so adopt the current tier
			// as the mark WITHOUT re-granting (nothing new to grant this render, and
			// deletions stick). When present, grant only the tiers a level-up has
			// since unlocked, `(grantedTier, maxTier]`.
			fromTier = typeof stored.grantedTier === 'number' ? stored.grantedTier : maxTier;
		} else {
			// New/changed subclass — offer the choice, grant every unlocked tier, and
			// apply the school drop this once.
			finalSchools = await promptSchoolChoice(actor, policy);
			if (!finalSchools) return; // deferred
			fromTier = -1;
			pruneDropped = true;
		}

		// Persist the school set + advanced high-water mark BEFORE granting so a
		// re-entrant render (fired by our own writes) already sees the final state.
		await actor.setFlag(MODULE_ID, 'spellSchools', {
			subclass: subclassId,
			schools: [...finalSchools],
			grantedTier: Math.max(fromTier, maxTier),
		});

		const { removed, granted } = await applySpellSchools(
			actor,
			finalSchools,
			classInfo.classLevel,
			fromTier,
			pruneDropped,
		);
		if (removed || granted) {
			ui.notifications?.info(
				`${actor.name}: spell schools updated (${granted} learned${
					removed ? `, ${removed} replaced` : ''
				}).`,
			);
		}
	} finally {
		spellSyncActive.delete(actor.id);
	}
}

// Grant every Codex spell of a single `school` in the tier band `(fromTier, maxTier]`
// the actor doesn't already own. Same one-time-per-tier discipline as
// applySpellSchools, so a manually removed spell isn't re-added and manual adds of
// any school survive. Returns the count created.
async function grantCodexSchoolSpells(actor, school, maxTier, fromTier) {
	const bySchool = await loadCodexSpellsBySchool();
	const list = bySchool.get(school);
	if (!list || list.length === 0) return 0;

	const spellItems = (actor.items ?? []).filter((item) => item.type === 'spell');
	const ownedSources = new Set(
		(actor.items ?? []).map((item) => item._stats?.compendiumSource).filter(Boolean),
	);
	const ownedNameSchool = new Set(spellItems.map((item) => `${item.name}|${item.system?.school}`));
	// Cross-path duplicate guard: the creation/level-up dialog can grant this school's
	// spells directly (its necrotic rules are rewritten to death/shadow), so match on
	// the stable `system.identifier` too — a spell already present that way, even with a
	// different compendiumSource, must never be re-created here.
	const ownedIdentifiers = new Set(
		spellItems
			.filter((item) => item.system?.identifier)
			.map((item) => `${item.system.identifier}|${item.system?.school}`),
	);

	const toCreate = [];
	const seen = new Set();
	for (const { uuid, tier } of list) {
		if (tier > maxTier || tier <= fromTier || seen.has(uuid) || ownedSources.has(uuid)) continue;
		seen.add(uuid);
		// eslint-disable-next-line no-await-in-loop
		const doc = await fromUuid(uuid);
		if (!doc) continue;
		if (ownedNameSchool.has(`${doc.name}|${doc.system?.school}`)) continue;
		if (doc.system?.identifier && ownedIdentifiers.has(`${doc.system.identifier}|${doc.system?.school}`)) continue;
		const obj = doc.toObject();
		delete obj._id;
		obj._stats = obj._stats ?? {};
		obj._stats.compendiumSource = doc.uuid;
		toCreate.push(obj);
	}
	if (toCreate.length) await actor.createEmbeddedDocuments('Item', toCreate);
	return toCreate.length;
}

// Self-heal: collapse accidental duplicate Codex spells down to one copy. A spell is
// a duplicate when another spell item on the actor shares its (non-empty)
// `system.identifier` AND `system.school`. Conservative on purpose — it only ever
// touches spell items, requires an exact identifier+school match, and always keeps
// the first occurrence — so a legitimately distinct spell is never removed. Fully
// guarded; returns the number deleted. Cleans characters already affected by the
// earlier double-grant bug.
async function pruneDuplicateCodexSpells(actor) {
	try {
		const spellItems = (actor.items ?? []).filter((item) => item.type === 'spell');
		const kept = new Set();
		const duplicateIds = [];
		for (const item of spellItems) {
			const identifier = item.system?.identifier;
			const school = item.system?.school;
			if (!identifier || !school) continue; // only exact identifier+school matches
			const key = `${identifier}|${school}`;
			if (kept.has(key)) duplicateIds.push(item.id);
			else kept.add(key);
		}
		if (duplicateIds.length) await actor.deleteEmbeddedDocuments('Item', duplicateIds);
		return duplicateIds.length;
	} catch (error) {
		console.error(`[${MODULE_ID}] duplicate Codex-spell sweep failed`, error);
		return 0;
	}
}

// Guard against the render-storm (our own create/delete re-fires the hooks).
const classRemapActive = new Set();

// Re-home a base necrotic caster (Shadowmancer → shadow, Shepherd → death) onto its
// Codex school. Idempotent and one-time-per-tier via a `classSchools` high-water
// mark, exactly like the subclass swap, so a manually removed spell is not re-added
// and a spell added from any school survives. The official necrotic spells the class
// replaces are pruned ONCE (when the remap is first applied or the class changes);
// future necrotic grants are already suppressed by the grant-index drop + the
// preCreateItem block, so no continuous deletion is needed.
async function classSpellRemapSync(actor) {
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	if (!isReplaceSpellsEnabled()) return;
	if (classRemapActive.has(actor.id)) return;

	const classInfo = getPrimaryClass(actor);
	if (!classInfo?.classId || classInfo.classLevel < 1) return;
	const target = CLASS_SPELL_REMAP[classInfo.classId];
	if (!target) return;

	const maxTier = maxSpellTierForLevel(classInfo.classLevel);
	const stored = actor.getFlag(MODULE_ID, 'classSchools');
	const isNew = !stored || stored.classId !== classInfo.classId;

	classRemapActive.add(actor.id);
	try {
		// Self-heal characters already hit by the earlier double-grant: collapse any
		// duplicate Codex spells (same identifier+school) to a single copy. Cheap,
		// idempotent, guarded — safe to run on every sync.
		await pruneDuplicateCodexSpells(actor);

		// Adoption discipline (mirrors applySpellSchools' "absent high-water flag ⇒
		// adopt current tier, don't re-grant"). At character creation the dialog grants
		// this class's Codex school directly — its necrotic grantSpells rules are
		// rewritten to death/shadow (see installFromUuidRewrite) — so the actor can own
		// the target-school spells before this back-fill ever runs. When there is no
		// high-water flag yet but the actor already owns spells of the target school,
		// those grants happened elsewhere: adopt the current tier as the mark WITHOUT
		// re-granting, or we would create a second copy of each. (An untouched existing
		// character owns only official necrotic here — not the Codex school — so it
		// still falls through to the one-time prune + grant below.)
		const ownsTargetSchool = (actor.items ?? []).some(
			(item) => item.type === 'spell' && item.system?.school === target,
		);
		// maxTier === 0: at level 1 the class feature (via the fromUuid rewrite) is the
		// sole authority on cantrips. During creation the sheet renders after the class
		// item lands but BEFORE the granted spells do, so ownsTargetSchool is briefly
		// false — blanket-granting here would hand out the whole tier-0 school.
		if (isNew && (ownsTargetSchool || maxTier === 0)) {
			// Still prune any official necrotic this class replaces that leaked through.
			const necroticIds = (actor.items ?? [])
				.filter((item) => item.type === 'spell' && item.system?.school === 'necrotic')
				.map((item) => item.id);
			if (necroticIds.length) await actor.deleteEmbeddedDocuments('Item', necroticIds);
			await actor.setFlag(MODULE_ID, 'classSchools', {
				classId: classInfo.classId,
				grantedTier: maxTier,
			});
			return;
		}

		const fromTier = isNew
			? -1
			: typeof stored.grantedTier === 'number'
				? stored.grantedTier
				: maxTier;

		// Already granted through the current tier and no class change → nothing to do
		// (persist a missing grantedTier so an upgraded flag stops re-checking).
		if (!isNew && fromTier >= maxTier) {
			if (typeof stored.grantedTier !== 'number') {
				await actor.setFlag(MODULE_ID, 'classSchools', {
					classId: classInfo.classId,
					grantedTier: maxTier,
				});
			}
			return;
		}

		if (isNew) {
			// One-time prune of the official necrotic spells this class replaces (e.g.
			// a character that already leveled before this remap existed).
			const necroticIds = (actor.items ?? [])
				.filter((item) => item.type === 'spell' && item.system?.school === 'necrotic')
				.map((item) => item.id);
			if (necroticIds.length) await actor.deleteEmbeddedDocuments('Item', necroticIds);
		}

		// Persist the advanced high-water mark BEFORE granting so a re-entrant render
		// (fired by our own writes) already sees the final state.
		await actor.setFlag(MODULE_ID, 'classSchools', {
			classId: classInfo.classId,
			grantedTier: Math.max(fromTier, maxTier),
		});

		const granted = await grantCodexSchoolSpells(actor, target, maxTier, fromTier);
		if (granted) {
			ui.notifications?.info(
				`${actor.name}: learned ${granted} ${SCHOOL_LABEL(target)} spell${granted > 1 ? 's' : ''}.`,
			);
		}
	} finally {
		classRemapActive.delete(actor.id);
	}
}

// Suppress ONLY the automated base-class grant that fires during a swapped
// caster's level-up — this is what stops an Invoker of Ether from re-gaining Book
// of Elements spells every level-up. It is deliberately scoped to the leveling
// character's own level-up (levelUpContext): outside a level-up this returns early,
// so the player can freely add a spell of ANY school and ANY tier from the sheet
// (drag-in, spell browser, etc.). Runs as its own hook because the official-spell
// filter above returns early for non-official (i.e. Codex) spells.
Hooks.on('preCreateItem', (item, data) => {
	try {
		if (!isReplaceSpellsEnabled()) return true;
		if (item?.type !== 'spell') return true;
		const actor = item?.parent;
		if (!(actor instanceof Actor) || actor.type !== 'character') return true;

		// Manual adds happen outside any level-up dialog — let them all through.
		if (levelUpContext?.actorId !== actor.id) return true;

		const stored = actor.getFlag(MODULE_ID, 'spellSchools');
		if (!stored || !Array.isArray(stored.schools)) return true;

		const school = item?.system?.school ?? data?.system?.school;
		if (school && MANAGED_SPELL_SCHOOLS.has(school) && !stored.schools.includes(school)) {
			console.log(
				`[${MODULE_ID}] Blocked ${school} spell "${item.name}" during level-up — not among this subclass's chosen schools (${stored.schools.join(', ')}).`,
			);
			return false;
		}
	} catch (error) {
		console.error(`[${MODULE_ID}] preCreateItem school filter failed`, error);
	}
	return true;
});

// Wrap the character document's `triggerLevelUp` so that, for the whole time its
// native level-up dialog is open, `levelUpContext` names the leveling character
// and its subclass. The class-feature index patch reads that to swap the base
// class's generic pool options for the subclass's themed ones (see
// maybeInjectSubclassPoolOptions). Installed lazily from the first character
// sheet render (and eagerly at ready when an actor already exists) because the
// document subclass isn't on a stable global.
let levelUpWrapInstalled = false;
function wrapTriggerLevelUp(actor) {
	if (levelUpWrapInstalled) return;
	let proto = actor ? Object.getPrototypeOf(actor) : null;
	while (proto && !Object.prototype.hasOwnProperty.call(proto, 'triggerLevelUp')) {
		proto = Object.getPrototypeOf(proto);
	}
	if (!proto || typeof proto.triggerLevelUp !== 'function' || proto.__blueCodexLevelUpWrapped) return;

	const originalTriggerLevelUp = proto.triggerLevelUp;
	proto.triggerLevelUp = async function blueCodexTriggerLevelUp(...args) {
		const previous = levelUpContext;
		let carrierId = null;
		try {
			const classInfo = getPrimaryClass(this);
			const classId = classInfo?.classId ?? '';
			const subclassId = classId ? getActorSubclassId(this, classId) : '';
			// Track the leveling character's subclass AND class. `classId` scopes the
			// grant-index necrotic drop to a remapped class's own level-up; `subclassId`
			// drives the swap machinery. Set whenever either applies.
			levelUpContext =
				subclassId || CLASS_SPELL_REMAP[classId]
					? { actorId: this.id, subclassId, classId }
					: null;
			// Seed the native preview/grant with the chosen swapped schools (transient;
			// removed in the finally so it never sticks on the sheet). Necrotic base
			// casters (Shadowmancer/Shepherd) need no carrier: installFromUuidRewrite
			// already rewrites their base feature rules to grant the Codex school.
			carrierId = await createSwapGrantCarrier(this, subclassId);
			return await originalTriggerLevelUp.apply(this, args);
		} finally {
			// Delete the carrier BEFORE clearing levelUpContext: the grant-triggered
			// sheet re-renders run sweepStaleGrantCarriers, which only skips this
			// actor while the context still names it — clearing first lets the sweep
			// race this delete for the same id ("Item does not exist").
			if (carrierId) {
				try {
					await this.deleteEmbeddedDocuments('Item', [carrierId]);
				} catch (error) {
					console.error(`[${MODULE_ID}] Failed to remove transient spell-grant carrier`, error);
				}
			}
			levelUpContext = previous;
		}
	};
	proto.__blueCodexLevelUpWrapped = true;
	levelUpWrapInstalled = true;
}

// ── Reusable on-hit automation ───────────────────────────────────────────────
// A small, data-driven "when this item hits a target, do X" framework. Any item
// (spell, weapon, feature) opts in with a flag:
//
//   flags.blue-codex-package.automation.onHit = [ { type: '<effect>' }, … ]
//
// Currently the only effect is `disadvantageNextAttack` (used by Vicious
// Mockery): on a hit, the target's *next* attack rolls at disadvantage, then the
// mark clears itself. Nimble has no rule/condition for this — attack advantage/
// disadvantage is the `rollMode` passed into `item.activate` (negative =
// disadvantage), which flows through the activation dialog into the DamageRoll's
// primary die. So the mechanism is two halves:
//   1. On a hit (the system's `useItem` hook), drop a tracking ActiveEffect on
//      each hit target.
//   2. Wrap `item.activate`: if the acting actor carries a mark and the item is
//      an attack, decrement `rollMode` (pre-selecting disadvantage in the roll
//      dialog) and, once the attack resolves, delete the mark.
//
// New on-hit effects can be added by extending ON_HIT_APPLIERS and the marker
// bookkeeping — the flag schema and the useItem plumbing are already generic.
const DISADVANTAGE_MARK_FLAG = 'disadvantageNextAttack';

// Read an item's declared on-hit automations (always an array).
function getItemOnHitAutomations(item) {
	const automation =
		item?.getFlag?.(MODULE_ID, 'automation') ?? item?.flags?.[MODULE_ID]?.automation;
	const onHit = automation?.onHit;
	return Array.isArray(onHit) ? onHit : [];
}

// True when the item makes a to-hit attack roll — a `damage` activation effect
// that can miss. Auto-hit effects (canMiss:false) roll no d20, so disadvantage
// is meaningless and such items neither trigger nor consume a mark.
function isAttackItem(item) {
	const effects = item?.system?.activation?.effects;
	if (!Array.isArray(effects)) return false;
	return effects.some((effect) => effect?.type === 'damage' && effect?.canMiss !== false);
}

// The disadvantage-on-next-attack marks currently on an actor.
function getDisadvantageMarks(actor) {
	const effects = actor?.effects ? [...actor.effects] : [];
	return effects.filter((effect) => effect?.getFlag?.(MODULE_ID, DISADVANTAGE_MARK_FLAG) === true);
}

// Drop a tracking ActiveEffect that flags the target's next attack as
// disadvantaged. Idempotent (one mark at a time — you can't be "more" than
// disadvantaged on a single next attack). Requires permission to edit the
// target actor; in single-GM play the acting client is the GM so this always
// succeeds. In multiplayer, a player targeting an actor they don't own can't
// create the effect — it degrades to the reminder note on the spell's chat card.
async function applyDisadvantageNextAttack(targetActor, sourceItem) {
	if (!targetActor) return;
	if (getDisadvantageMarks(targetActor).length) return;
	const effectData = {
		name: sourceItem?.name ?? 'Disadvantage (Next Attack)',
		img: sourceItem?.img ?? 'icons/svg/downgrade.svg',
		description: '<p>Disadvantage on your next attack.</p>',
		disabled: false,
		transfer: false,
		flags: {
			[MODULE_ID]: {
				[DISADVANTAGE_MARK_FLAG]: true,
				sourceName: sourceItem?.name ?? '',
			},
		},
	};
	try {
		await targetActor.createEmbeddedDocuments('ActiveEffect', [effectData]);
	} catch (error) {
		console.warn(
			`[${MODULE_ID}] Could not apply "disadvantage on next attack" to ${targetActor?.name}` +
				' (insufficient permission?); relying on the chat-card reminder instead.',
			error,
		);
	}
}

// Maps an on-hit automation type to the function that applies it to a target.
const ON_HIT_APPLIERS = {
	disadvantageNextAttack: applyDisadvantageNextAttack,
};

// `useItem` fires (on the acting client only) after an item's chat card is
// created, with the aggregate hit/miss of its primary attack. For any item that
// declares on-hit automations, apply each to every target the attack hit.
async function onItemUsed(item, _chatCard, context) {
	try {
		await applyOnHitAutomations(item, context);
	} catch (error) {
		console.error(`[${MODULE_ID}] on-hit automation failed`, error);
	}
	// Summon spells spawn their companion after the cast resolves; summoned
	// healers spend a heal charge when their Cure resolves. Both are independent
	// of the on-hit path and each degrade to a console.warn (single-GM play).
	try {
		await handleSummonSpawn(item, context);
	} catch (error) {
		console.warn(`[${MODULE_ID}] summon spawn failed`, error);
	}
	try {
		await consumeSummonCharge(item, context);
	} catch (error) {
		console.warn(`[${MODULE_ID}] summon charge consumption failed`, error);
	}
	// Swarming Shadows: a shadow minion's single attack that would crit spawns
	// another minion beside the target.
	try {
		await handleSwarmingShadowsUseItem(item, context);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Swarming Shadows (single attack) failed`, error);
	}
	// Shadowmancer Pilfered Power: enforce the flat 1-mana cost after the system's
	// own tier-based deduction has run.
	try {
		await applyShadowmancerFlatCost(item, context);
	} catch (error) {
		console.warn(`[${MODULE_ID}] shadowmancer flat-cost correction failed`, error);
	}
}

// Apply every declared on-hit automation to each target the primary attack hit.
async function applyOnHitAutomations(item, context) {
	const automations = getItemOnHitAutomations(item);
	if (!automations.length) return;
	// Only fire on a hit. `isMiss` is the primary attack's aggregate outcome
	// (undefined for auto-hit items, which count as hits here).
	if (context?.isMiss === true) return;
	const targets = context?.targets ?? [];
	for (const automation of automations) {
		const apply = ON_HIT_APPLIERS[automation?.type];
		if (!apply) continue;
		for (const token of targets) {
			const targetActor = token?.actor ?? token?.document?.actor;
			if (targetActor) await apply(targetActor, item, automation);
		}
	}
}

// The wrapped body shared by every item document class's `activate`: if the
// acting actor carries a disadvantage mark and this item is an attack, pre-apply
// disadvantage (rollMode −1) and, once the attack resolves, clear the mark(s).
async function runWrappedActivate(originalActivate, options = {}) {
	// The macro path is not an attack roll; pass straight through.
	if (options?.executeMacro) return originalActivate.call(this, options);
	// Summon gating: for spells carrying a summon automation flag, decide whether
	// the cast may proceed BEFORE the dialog/mana/chat-card. Blocking here means
	// `originalActivate` never runs, so a recast-dismiss costs no mana (see the
	// Summon automation section below).
	try {
		if (await summonActivationBlocked(this)) return null;
	} catch (error) {
		console.error(`[${MODULE_ID}] summon pre-activate gate failed`, error);
	}
	let marks = [];
	try {
		if (this?.actor && isAttackItem(this)) {
			marks = getDisadvantageMarks(this.actor);
			if (marks.length) options = { ...options, rollMode: (options.rollMode ?? 0) - 1 };
		}
	} catch (error) {
		console.error(`[${MODULE_ID}] disadvantage pre-activate failed`, error);
	}
	// Tier-cap lift: a summon boost with `uncapsTierLimit` (Empowered Companion —
	// "ignoring the typical spell tier restrictions") lets the upcast slider run
	// to full mana. The system's SpellUpcastDialog reads the DERIVED in-memory
	// value `actor.system.resources.highestUnlockedSpellTier` both at render and
	// at submit validation, and `originalActivate` awaits the dialog's whole
	// lifetime — so raising the value here and restoring it in `finally` brackets
	// both reads. Real mana still bounds the slider's maxMana, so the player can
	// never overspend actual mana; and if the system re-derives the value
	// mid-dialog, submit validation just falls back to the real cap (fail-safe:
	// dialog warns, the user retries).
	let tierResources = null;
	let priorTier = 0;
	let hadOverride = false;
	try {
		const summon = getItemSummonAutomation(this);
		if (summon && getSummonFeatureBoosts(summon, this?.actor).uncapTier) {
			const resources = this?.actor?.system?.resources;
			const current = resources?.highestUnlockedSpellTier;
			// Only lift a real numeric cap that sits below Nimble's max tier (9).
			if (resources && typeof current === 'number' && current < 9) {
				tierResources = resources;
				priorTier = current;
				resources.highestUnlockedSpellTier = 9;
				hadOverride = true;
			}
		}
	} catch (error) {
		console.warn(`[${MODULE_ID}] summon tier-uncap pre-activate failed`, error);
	}
	// Shadowmancer Pilfered Power forced max-tier: the SpellUpcastDialog is auto-
	// answered at the cap (see onRenderUpcastDialog), but getData's applyUpcastDeltas
	// also enforces Rule 4 (manaToSpend <= mana.current, reading the derived in-memory
	// value). Under Pilfered Power mana.current is a use-count, not a per-tier budget,
	// so raise it to the cap for the duration of getData; onSpellPreUse restores the
	// real value BEFORE the system's own deduction (so the true flat cost persists),
	// and the `finally` restores it if the cast is cancelled before preUse ever fires.
	// Also strip fastForward so the dialog (hence the auto-answer) always runs.
	try {
		if (this?.type === 'spell' && (Number(this.system?.tier) || 0) >= 1 && isShadowmancerActor(this?.actor)) {
			if (options?.fastForward) options = { ...options, fastForward: false };
			const resources = this.actor.system?.resources;
			const realMana = Number(resources?.mana?.current) || 0;
			const cap = Number(resources?.highestUnlockedSpellTier) || 0;
			if (resources?.mana && realMana < cap) {
				resources.mana.current = cap;
				// Store only the plain value; the live `resources` object can be
				// replaced if prepareData() re-runs during the dialog window, so the
				// restore re-resolves the actor's mana object freshly.
				shadowmancerManaFudge.set(this.actor.uuid, realMana);
			}
		}
	} catch (error) {
		console.warn(`[${MODULE_ID}] shadowmancer mana pre-activate fudge failed`, error);
	}
	let result;
	try {
		result = await originalActivate.call(this, options);
		// Consume the mark only if an attack actually resolved (dialog not cancelled).
		if (marks.length && result) {
			try {
				await this.actor.deleteEmbeddedDocuments(
					'ActiveEffect',
					marks.map((mark) => mark.id).filter(Boolean),
				);
			} catch (error) {
				console.warn(`[${MODULE_ID}] Could not clear disadvantage mark`, error);
			}
		}
		return result;
	} finally {
		// ALWAYS restore the exact prior tier cap, even when activate throws.
		if (hadOverride) {
			try {
				tierResources.highestUnlockedSpellTier = priorTier;
			} catch (error) {
				console.warn(`[${MODULE_ID}] Could not restore spell tier cap`, error);
			}
		}
		try {
			const uuid = this?.actor?.uuid;
			// Restore the mana fudge if onSpellPreUse never ran (the cast was
			// cancelled/aborted before the deduction); a completed cast already
			// restored it in preUse. Re-resolve the live mana object — the reference
			// captured at fudge time may be stale after a mid-dialog prepareData().
			if (uuid && shadowmancerManaFudge.has(uuid)) {
				const realMana = shadowmancerManaFudge.get(uuid);
				shadowmancerManaFudge.delete(uuid);
				const mana = this?.actor?.system?.resources?.mana;
				if (mana) mana.current = realMana;
			}
			// Clear a leftover cost snapshot ONLY when the cast did not complete (e.g.
			// a later preUseItem handler blocked it after ours ran). A completed cast
			// leaves the snapshot for the async useItem handler to consume — clearing
			// it here would race that handler and skip the flat-cost/overdraft step.
			if (uuid && !result) shadowmancerPreCastMana.delete(uuid);
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not restore shadowmancer mana fudge`, error);
		}
	}
}

// Wrap `activate` on every distinct item document class prototype that defines
// its own. `NimbleSpellItem` reimplements activate (it only calls super in the
// macro path), so wrapping `NimbleBaseItem` alone would miss attack spells —
// hence iterating the per-type classes. Idempotent per prototype.
let onHitAutomationInstalled = false;
function installOnHitAutomation() {
	if (onHitAutomationInstalled) return;

	Hooks.on(`${game.system?.id ?? 'nimble'}.useItem`, onItemUsed);

	const classes = CONFIG?.NIMBLE?.Item?.documentClasses;
	if (classes) {
		const seen = new Set();
		for (const cls of Object.values(classes)) {
			const proto = cls?.prototype;
			if (!proto || seen.has(proto)) continue;
			seen.add(proto);
			if (!Object.prototype.hasOwnProperty.call(proto, 'activate')) continue;
			// Own-property check: a subclass (e.g. NimbleSpellItem, which reimplements
			// activate) inherits the base prototype's `__blueCodexActivateWrapped`
			// flag, so an inherited-value guard would wrongly skip wrapping its own
			// activate. Only skip a prototype we have already wrapped directly.
			if (typeof proto.activate !== 'function') continue;
			if (Object.prototype.hasOwnProperty.call(proto, '__blueCodexActivateWrapped')) continue;
			const originalActivate = proto.activate;
			proto.activate = async function blueCodexActivate(options = {}) {
				return runWrappedActivate.call(this, originalActivate, options);
			};
			proto.__blueCodexActivateWrapped = true;
		}
	} else {
		console.warn(`[${MODULE_ID}] CONFIG.NIMBLE.Item.documentClasses missing; on-hit attack-roll automation not installed.`);
	}

	onHitAutomationInstalled = true;
}

// ── Summon automation ────────────────────────────────────────────────────────
// A data-driven "casting this spell spawns/dismisses a companion token" layer,
// riding the same `useItem` hook and `activate` wrap as the on-hit section. A
// spell opts in with a flag:
//
//   flags.blue-codex-package.automation.summon = {
//     template, combatOnly?, expireOnCombatEnd?, maxCount?, unique?,
//     recastDismisses?, chargesFromMana?, upcastDieStep?: { baseFaces, maxFaces }
//   }
//
// Two spells use it today:
//   • summon-shadow → many shadow-minion tokens, capped at min(INT, level), only
//     during combat, cleaned up when combat ends.
//   • summon-lifebinding-spirit → one unique spirit; recasting dismisses it (no
//     mana); its heal die scales with upcast; its Cure carries a pool of heal
//     charges (= mana spent) that dismiss the spirit when exhausted.
//
// The companions themselves are world actors imported once from the
// `blue-codex-package.blue-codex-companions` pack, tagged with an actor flag
// `flags.blue-codex-package.companionTemplate === '<template>'`. Each spawned
// token records its provenance on `flags.blue-codex-package.summon`; unique
// templates are also tracked on the caster under
// `flags.blue-codex-package.summons.<template>`. All spawning/patching degrades
// to console.warn — single-GM play, same assumption as the on-hit section.
const COMPANION_PACK = `${MODULE_ID}.blue-codex-companions`;
const COMPANION_TEMPLATE_FLAG = 'companionTemplate';
const SUMMON_FLAG = 'summon'; // token flag: provenance of a spawned companion
const SUMMONS_TRACK_FLAG = 'summons'; // caster-actor flag namespace for unique summons

// Read a spell's declared summon automation (or null).
function getItemSummonAutomation(item) {
	const automation =
		item?.getFlag?.(MODULE_ID, 'automation') ?? item?.flags?.[MODULE_ID]?.automation;
	const summon = automation?.summon;
	return summon && typeof summon === 'object' ? summon : null;
}

// Read the raw summon provenance flag off a token document.
function getTokenSummonFlag(tokenDoc) {
	return tokenDoc?.getFlag?.(MODULE_ID, SUMMON_FLAG) ?? tokenDoc?.flags?.[MODULE_ID]?.[SUMMON_FLAG] ?? null;
}

// Total character level = one entry per level in classData.levels (matches the
// system's own `_prepareLevelData`).
function getCharacterLevel(actor) {
	const levels = actor?.system?.classData?.levels;
	return Array.isArray(levels) ? levels.length : 0;
}

function getAbilityMod(actor, ability) {
	return Number(actor?.system?.abilities?.[ability]?.mod ?? 0);
}

// Die-size steps walk the standard ladder (upcast "+1 die step" semantics), so
// a d12 steps straight to a d20 — never a nonstandard d14/16/18.
const SUMMON_DIE_LADDER = [4, 6, 8, 10, 12, 20];

// Step `baseFaces` up the standard die ladder by `steps`, then clamp DOWN to the
// largest ladder value <= `maxFaces` (a d12 cap yields d6/d8/d10/d12; a d20 cap
// yields d6→d8→d10→d12→d20). If baseFaces isn't a standard die, fall back to the
// old +2-faces arithmetic as a safety net.
function stepSummonDie(baseFaces, steps, maxFaces) {
	const start = SUMMON_DIE_LADDER.indexOf(baseFaces);
	if (start === -1) return Math.min(maxFaces, baseFaces + 2 * steps);
	const stepped = SUMMON_DIE_LADDER[Math.min(start + steps, SUMMON_DIE_LADDER.length - 1)];
	// Largest standard die that fits under the cap (fall back to baseFaces should
	// the cap somehow sit below every ladder entry).
	let cap = baseFaces;
	for (const faces of SUMMON_DIE_LADDER) {
		if (faces <= maxFaces) cap = faces;
	}
	return Math.min(stepped, cap);
}

// A summon flag may declare featureBoosts: bonuses granted when the caster owns
// a specific feature (e.g. the Shepherd Sacred Grace "Empowered Companion":
// +1 effective mana ignoring tier restrictions, die cap raised to d20). Each
// entry applies AT MOST ONCE — the grace cannot be owned more than once, and a
// duplicated item still counts a single time. Returns an aggregate
// { bonusMana, maxFacesOverride, uncapTier } (0 / null / false when the caster
// owns none).
function getSummonFeatureBoosts(summon, actor) {
	const result = {
		bonusMana: 0,
		maxFacesOverride: null,
		uncapTier: false,
		reachBonus: 0,
		formulaOverride: null,
	};
	const boosts = summon?.featureBoosts;
	if (!Array.isArray(boosts) || !(actor instanceof Actor)) return result;

	// Snapshot the caster's feature items once for cheap identifier/name matching.
	const features = [];
	for (const it of actor.items ?? []) {
		if (it?.type === 'feature') features.push(it);
	}

	for (const entry of boosts) {
		if (!entry || typeof entry !== 'object') continue;
		// The owned item's identifier is often EMPTY in the core pack, so match on
		// identifier OR exact (case-sensitive) name — either counts the entry once.
		const owned = features.some(
			(it) =>
				(entry.feature && it.system?.identifier === entry.feature) ||
				(entry.name && it.name === entry.name),
		);
		if (!owned) continue;
		result.bonusMana += Number(entry.bonusMana) || 0;
		const faces = Number(entry.maxFaces) || 0;
		if (faces > (result.maxFacesOverride ?? 0)) result.maxFacesOverride = faces;
		if (entry.uncapsTierLimit === true) result.uncapTier = true;
		result.reachBonus += Number(entry.reachBonus) || 0;
		if (typeof entry.formulaOverride === 'string' && entry.formulaOverride) {
			result.formulaOverride = entry.formulaOverride; // last owned entry wins
		}
	}
	return result;
}

// Every live token, across all scenes, that this caster summoned of `template`.
// Iterating scene.tokens (never getDocuments) keeps this cheap and never stalls.
// Uses the caster's UUID rather than the (possibly stale) caster tracking flag,
// so a tracking flag pointing at a deleted token never produces a phantom.
function findLiveSummons(casterActor, template) {
	const out = [];
	const casterUuid = casterActor?.uuid;
	if (!casterUuid) return out;
	for (const scene of game.scenes ?? []) {
		for (const token of scene.tokens ?? []) {
			const flag = getTokenSummonFlag(token);
			if (!flag || flag.template !== template) continue;
			if (flag.summonerActorUuid !== casterUuid) continue;
			out.push(token);
		}
	}
	return out;
}

// Resolve the caster Actor recorded on a summoned token's flag.
function resolveSummonerFromToken(tokenDoc) {
	const uuid = getTokenSummonFlag(tokenDoc)?.summonerActorUuid;
	if (!uuid) return null;
	try {
		const doc = fromUuidSync?.(uuid);
		if (doc instanceof Actor) return doc;
		return doc?.actor instanceof Actor ? doc.actor : null;
	} catch {
		return null;
	}
}

// Post a brief summon chat card. `content` is trusted HTML (callers escape any
// interpolated names); `flavor` is a plain string.
function postSummonChat(actor, content, flavor) {
	try {
		const data = { content };
		if (actor) data.speaker = ChatMessage.getSpeaker({ actor });
		if (flavor) data.flavor = `<strong>${escapeHtml(flavor)}</strong>`;
		ChatMessage.create(data);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not post summon chat card`, error);
	}
}

// Import (once) or find the world actor backing a companion template.
async function resolveCompanionBaseActor(template) {
	const existing = game.actors?.find?.(
		(a) =>
			(a.getFlag?.(MODULE_ID, COMPANION_TEMPLATE_FLAG) ??
				a.flags?.[MODULE_ID]?.[COMPANION_TEMPLATE_FLAG]) === template,
	);
	if (existing) return existing;

	const pack = game.packs?.get?.(COMPANION_PACK);
	if (!pack) return null;

	// Index-only lookup, then a single getDocument — never getDocuments (stalls).
	const index = await pack.getIndex({ fields: [`flags.${MODULE_ID}.${COMPANION_TEMPLATE_FLAG}`] });
	const entry = index.find(
		(e) => foundry.utils.getProperty(e, `flags.${MODULE_ID}.${COMPANION_TEMPLATE_FLAG}`) === template,
	);
	if (!entry) return null;

	const source = await pack.getDocument(entry._id);
	if (!source) return null;

	return Actor.implementation.create(source.toObject(), { keepId: false });
}

// Adjacent to the caster's token, else the scene centre.
function computeSummonSpawnPosition(actor, scene) {
	const ownToken = actor?.getActiveTokens?.(true, true)?.[0];
	const grid = scene?.grid?.size ?? 100;
	if (ownToken) return { x: ownToken.x + grid, y: ownToken.y };
	return {
		x: Math.round((scene?.dimensions?.sceneWidth ?? scene?.width ?? 4000) / 2),
		y: Math.round((scene?.dimensions?.sceneHeight ?? scene?.height ?? 4000) / 2),
	};
}

// Shared teardown for a single summoned token: delete it, clear the caster's
// matching unique-tracking flag, and (optionally) narrate why. Fully null-safe.
async function dismissSummon(tokenDoc, { reason, summonerActor, template } = {}) {
	try {
		const flag = getTokenSummonFlag(tokenDoc);
		const tmpl = template ?? flag?.template;
		const caster = summonerActor ?? resolveSummonerFromToken(tokenDoc);
		const tokenId = tokenDoc?.id;

		if (tokenDoc) {
			try {
				await tokenDoc.delete();
			} catch (error) {
				console.warn(`[${MODULE_ID}] Could not delete summoned token`, error);
			}
		}
		if (caster && tmpl) {
			try {
				const tracked = caster.getFlag?.(MODULE_ID, `${SUMMONS_TRACK_FLAG}.${tmpl}`);
				// Only clear the tracking flag if it points at the token we removed
				// (or we have no id to compare) — never clobber a newer summon.
				if (!tracked || !tokenId || tracked.tokenId === tokenId) {
					await caster.unsetFlag(MODULE_ID, `${SUMMONS_TRACK_FLAG}.${tmpl}`);
				}
			} catch (error) {
				console.warn(`[${MODULE_ID}] Could not clear summon tracking flag`, error);
			}
		}
		if (reason) postSummonChat(caster ?? null, reason);
	} catch (error) {
		console.warn(`[${MODULE_ID}] dismissSummon failed`, error);
	}
}

// Pre-activate gate (A): returns true when the cast must be BLOCKED. Runs inside
// the activate wrap, before any dialog/mana/chat card.
async function summonActivationBlocked(item) {
	const summon = getItemSummonAutomation(item);
	if (!summon) return false;
	const actor = item?.actor;
	if (!(actor instanceof Actor)) return false;

	// 1. combat-only spells cannot be cast outside combat.
	if (summon.combatOnly && !game.combat?.started) {
		ui.notifications?.warn(`${item.name} can only be cast during combat.`);
		return true;
	}

	// 3. recast dismisses: if a live summon of this template exists, remove it
	// (no mana, since originalActivate never runs) and block. With no live
	// summon, fall through and let the cast proceed normally.
	if (summon.recastDismisses) {
		const live = findLiveSummons(actor, summon.template);
		if (live.length) {
			await dismissSummon(live[0], {
				summonerActor: actor,
				template: summon.template,
				reason: `<p><strong>${escapeHtml(live[0].name ?? 'Lifebinding Spirit')}</strong> dismissed.</p>`,
			});
			// Sweep any strays (shouldn't happen for a unique summon, but stay safe).
			for (let i = 1; i < live.length; i += 1) {
				await dismissSummon(live[i], { summonerActor: actor, template: summon.template });
			}
			return true;
		}
	}

	// 2. maxCount cap = min(INT mod, character level), floored at 0.
	if (summon.maxCount === 'minIntOrLevel') {
		const cap = Math.max(0, Math.min(getAbilityMod(actor, 'intelligence'), getCharacterLevel(actor)));
		if (cap <= 0) {
			ui.notifications?.warn(`${actor.name} cannot summon any shadow minions right now.`);
			return true;
		}
		const count = findLiveSummons(actor, summon.template).length;
		if (count >= cap) {
			ui.notifications?.warn(`${actor.name} already has the maximum ${cap} shadow minion${cap === 1 ? '' : 's'}.`);
			return true;
		}
	}

	return false;
}

// Create one summoned companion token: stamps the shared provenance/expiration
// flags every summon path relies on, then applies owned-feature reach/damage
// boosts to the spawned token's synthetic (unlinked) actor. Shared by the
// post-cast spawn (handleSummonSpawn) and the Swarming Shadows trigger, so a
// swarm-spawned minion inherits the same Shadow Magus reach/die as a cast one.
// `extraFlag` merges into the token summon flag (e.g. { charges } for healers).
async function spawnSummonedToken({ caster, summon, baseActor, scene, x, y, extraFlag } = {}) {
	if (!(caster instanceof Actor) || !baseActor || !scene) return null;

	const casterToken = caster.getActiveTokens?.(true, true)?.[0] ?? null;
	const tokenFlag = {
		template: summon.template,
		summonerActorUuid: caster.uuid,
		summonerTokenId: casterToken?.id ?? null,
	};
	if (summon.expireOnCombatEnd) tokenFlag.combatId = game.combat?.id ?? null;
	if (extraFlag && typeof extraFlag === 'object') Object.assign(tokenFlag, extraFlag);

	const tokenSrc = baseActor.prototypeToken.toObject();
	const tokenData = foundry.utils.mergeObject(
		tokenSrc,
		{
			name: baseActor.name,
			x,
			y,
			actorId: baseActor.id,
			actorLink: false,
			disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
			flags: { [MODULE_ID]: { [SUMMON_FLAG]: tokenFlag } },
		},
		{ inplace: false },
	);
	delete tokenData._id;

	const [created] = await scene.createEmbeddedDocuments('Token', [tokenData]);
	if (!created) return null;

	await patchSummonFeatureBoosts(created, summon, caster);
	return created;
}

// Apply owned-feature reach/damage boosts (e.g. Shadow Magus: +4 Reach, d10) and
// the spell's "Reach +1 every N levels" scaling to a spawned token's synthetic
// actor. Reach scaling always applies (a base spell feature); reachBonus and the
// damage formula override only apply when the caster owns the boost feature. The
// same technique as patchLifebindingSpiritFormulas — patch after creation on the
// unlinked token actor, rewriting both the mechanical fields and the visible
// attack-sequence / description text so the sheet reads correctly.
async function patchSummonFeatureBoosts(tokenDoc, summon, caster) {
	try {
		const synth = tokenDoc?.actor;
		if (!synth) return;

		const boosts = getSummonFeatureBoosts(summon, caster);
		const perLevels = Number(summon?.reachPerLevels) || 0;
		const levelReach = perLevels > 0 ? Math.floor(getCharacterLevel(caster) / perLevels) : 0;
		const reachBonus = (boosts.reachBonus || 0) + levelReach;
		const formulaOverride = boosts.formulaOverride;
		if (reachBonus <= 0 && !formulaOverride) return;

		const itemUpdates = [];
		const textReplacements = []; // { pattern: RegExp, to } applied to visible text

		for (const item of listEmbeddedItems(synth)) {
			const activation = item.system?.activation;
			if (!activation) continue;
			const update = { _id: item.id ?? item._id };
			let changed = false;
			let description = typeof item.system?.description === 'string' ? item.system.description : null;

			if (reachBonus > 0 && activation.targets?.attackType === 'reach') {
				const oldDistance = Number(activation.targets.distance) || 0;
				const newDistance = oldDistance + reachBonus;
				foundry.utils.setProperty(update, 'system.activation.targets.distance', newDistance);
				changed = true;
				const pattern = new RegExp(`(Reach:\\s*)${oldDistance}\\b`, 'g');
				textReplacements.push({ pattern, to: `$1${newDistance}` });
				if (description) description = description.replace(pattern, `$1${newDistance}`);
			}

			if (formulaOverride) {
				const effects = foundry.utils.deepClone(activation.effects ?? []);
				let effectsChanged = false;
				for (const node of effects) {
					if (node?.type !== 'damage' || typeof node.formula !== 'string' || !node.formula) continue;
					const oldFormula = node.formula;
					if (oldFormula !== formulaOverride) {
						const pattern = new RegExp(escapeRegExp(oldFormula), 'g');
						textReplacements.push({ pattern, to: formulaOverride });
						if (description) description = description.replace(pattern, formulaOverride);
					}
					node.formula = formulaOverride;
					effectsChanged = true;
				}
				if (effectsChanged) {
					foundry.utils.setProperty(update, 'system.activation.effects', effects);
					changed = true;
				}
			}

			if (changed) {
				if (description && description !== item.system?.description) {
					foundry.utils.setProperty(update, 'system.description', description);
				}
				itemUpdates.push(update);
			}
		}

		if (itemUpdates.length) await synth.updateEmbeddedDocuments('Item', itemUpdates);

		// Rewrite the actor-level free-text mirror of the attack (Reach / Damage).
		const seq = synth.system?.attackSequence;
		if (typeof seq === 'string' && seq && textReplacements.length) {
			let newSeq = seq;
			for (const { pattern, to } of textReplacements) newSeq = newSeq.replace(pattern, to);
			if (newSeq !== seq) {
				try {
					await synth.update({ 'system.attackSequence': newSeq });
				} catch (error) {
					console.warn(`[${MODULE_ID}] Could not rewrite summon attack-sequence text`, error);
				}
			}
		}
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not apply summon feature boosts`, error);
	}
}

// Post-cast spawn (B): fires from `useItem` after the summon spell resolves.
async function handleSummonSpawn(item, context) {
	const summon = getItemSummonAutomation(item);
	if (!summon) return;
	const caster = item?.actor;
	if (!(caster instanceof Actor)) return;

	const scene = canvas?.scene;
	if (!scene) {
		console.warn(`[${MODULE_ID}] No active scene to summon "${summon.template}" onto.`);
		return;
	}

	const baseActor = await resolveCompanionBaseActor(summon.template);
	if (!baseActor) {
		console.warn(`[${MODULE_ID}] Could not resolve companion template "${summon.template}".`);
		return;
	}

	const { x, y } = computeSummonSpawnPosition(caster, scene);

	// Mana actually spent = upcast amount, else the base tier cost.
	const manaSpent = Number(context?.upcast?.manaSpent ?? item?.system?.tier ?? 0) || 0;
	// Owned-feature bonuses (e.g. "Empowered Companion"). The REAL mana deduction
	// stays whatever the system already took; effectiveMana is a virtual total the
	// summon's charges and die scaling treat as if that much mana were spent.
	const boosts = getSummonFeatureBoosts(summon, caster);
	const effectiveMana = manaSpent + boosts.bonusMana;

	const extraFlag = summon.chargesFromMana ? { charges: effectiveMana } : null;
	const created = await spawnSummonedToken({ caster, summon, baseActor, scene, x, y, extraFlag });
	if (!created) {
		console.warn(`[${MODULE_ID}] Failed to spawn "${summon.template}" token.`);
		return;
	}

	// Track unique summons on the caster so future casts can find/dismiss them.
	if (summon.unique) {
		try {
			await caster.setFlag(MODULE_ID, `${SUMMONS_TRACK_FLAG}.${summon.template}`, {
				tokenId: created.id,
				sceneId: scene.id,
			});
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not record unique summon tracking`, error);
		}
	}

	// Lifebinding Spirit: scale its die by upcast and bake in the caster's WIL.
	if (summon.upcastDieStep && typeof summon.upcastDieStep === 'object') {
		const baseFaces = Number(summon.upcastDieStep.baseFaces) || 6;
		const flagMax = Number(summon.upcastDieStep.maxFaces) || baseFaces;
		// A feature boost can raise the die cap (e.g. "Empowered Companion" → d20)
		// and add virtual mana steps. The higher of the flag cap / boost cap wins.
		const maxFaces = Math.max(flagMax, boosts.maxFacesOverride ?? 0);
		const steps = Math.max(0, Number(context?.upcast?.upcastSteps) || 0) + boosts.bonusMana;
		const faces = stepSummonDie(baseFaces, steps, maxFaces);
		await patchLifebindingSpiritFormulas(created, faces, getAbilityMod(caster, 'will'));
	}

	// School-gated bonus commands: keep only the spirit's commands whose required
	// spell school the caster knows (deletes the rest from the spawned token).
	let schoolGrant = { gated: false, granted: [] };
	try {
		schoolGrant = await applySchoolGatedAbilities(created, caster);
	} catch (error) {
		console.warn(`[${MODULE_ID}] school-gated ability filtering failed`, error);
	}

	// Summon chat card (with charge count for the spirit).
	let content = `<p>${escapeHtml(caster.name)} summons <strong>${escapeHtml(created.name ?? summon.template)}</strong>.</p>`;
	if (summon.chargesFromMana) {
		content += `<p>Heal charges remaining: <strong>${effectiveMana}</strong>.</p>`;
	}
	if (schoolGrant.gated) {
		const names = schoolGrant.granted.length
			? schoolGrant.granted.map(escapeHtml).join(', ')
			: 'none';
		content += `<p>School abilities: <strong>${names}</strong>.</p>`;
	}
	postSummonChat(caster, content, item?.name);
}

// Every embedded item on `actorLike` as a plain array, spanning both the live
// client (Foundry Collection → `.contents`) and the test harness (a plain array
// with a `getName` helper). Never triggers a getDocuments load.
function listEmbeddedItems(actorLike) {
	const items = actorLike?.items;
	if (!items) return [];
	if (Array.isArray(items.contents)) return items.contents;
	if (Array.isArray(items)) return items;
	try {
		return Array.from(items);
	} catch {
		return [];
	}
}

// Read a companion-item automation config (works for real Item docs via getFlag
// and for the plain-object items the harness/synthetic actors expose).
function getItemAutomationFlag(item, key) {
	const automation =
		item?.getFlag?.(MODULE_ID, 'automation') ??
		foundry.utils.getProperty(item, `flags.${MODULE_ID}.automation`);
	return automation ? automation[key] : undefined;
}

// Rewrite the summoned companion's roll formulas on the unlinked token's
// synthetic actor. Data-driven: every embedded item carrying a
// `automation.summonFormula` flag has its damage/healing node rewritten. Patched
// after creation (not via the create payload) to avoid fragile array-merge
// semantics — matches the nim-plus spirit.
//
//   summonFormula = { count?: 1, baseFaces, addWil?: bool, scalesWithUpcast?: bool }
//
// `scalesWithUpcast` items (Attack/Cure) use `steppedFaces` (the upcast die
// step); the rest (school-command abilities like Reap 3d4+WIL) use their own
// `baseFaces` unchanged. `addWil` bakes in the caster's WIL modifier with the
// exact "+ <wil>" rendering (WIL 0 → "+ 0", negatives → "+ -1").
async function patchLifebindingSpiritFormulas(tokenDoc, steppedFaces, wilMod) {
	try {
		const synth = tokenDoc?.actor;
		if (!synth) return;
		const updates = [];
		for (const item of listEmbeddedItems(synth)) {
			const cfg = getItemAutomationFlag(item, 'summonFormula');
			if (!cfg || typeof cfg !== 'object') continue;
			const count = Number(cfg.count) || 1;
			const faces = cfg.scalesWithUpcast ? steppedFaces : (Number(cfg.baseFaces) || 6);
			let formula = `${count}d${faces}`;
			if (cfg.addWil) formula += ` + ${wilMod}`;

			const effects = foundry.utils.deepClone(item.system?.activation?.effects ?? []);
			const node = effects.find((e) => e?.type === 'damage' || e?.type === 'healing');
			if (!node) continue;
			node.formula = formula;
			updates.push({ _id: item.id ?? item._id, system: { activation: { effects } } });
		}
		if (updates.length) await synth.updateEmbeddedDocuments('Item', updates);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not patch Lifebinding Spirit formulas`, error);
	}
}

// The set of spell schools a caster knows: distinct `system.school` over the
// caster's owned spell-type items. Iterates the actor's item list (never
// getDocuments) so it is cheap in the live client.
function getKnownSpellSchools(actor) {
	const schools = new Set();
	if (!(actor instanceof Actor)) return schools;
	for (const item of listEmbeddedItems(actor)) {
		if (item?.type !== 'spell') continue;
		const school = item.system?.school;
		if (typeof school === 'string' && school) schools.add(school);
	}
	return schools;
}

// School-gated bonus commands (Lifebinding Spirit): the full companion template
// carries one command per spell school; at summon time we DELETE every embedded
// item whose `automation.requiresSchool` the caster does NOT know, leaving only
// the granted commands. The compendium/world actor keeps the full set for
// browsing. Returns { gated, granted: [names] } for the chat card.
async function applySchoolGatedAbilities(tokenDoc, caster) {
	const synth = tokenDoc?.actor;
	if (!synth) return { gated: false, granted: [] };

	const gatedItems = [];
	for (const item of listEmbeddedItems(synth)) {
		const req = getItemAutomationFlag(item, 'requiresSchool');
		if (typeof req === 'string' && req) gatedItems.push({ item, req });
	}
	if (!gatedItems.length) return { gated: false, granted: [] };

	const known = getKnownSpellSchools(caster);
	const granted = [];
	const toDelete = [];
	for (const { item, req } of gatedItems) {
		if (known.has(req)) granted.push(item.name);
		else toDelete.push(item.id ?? item._id);
	}
	if (toDelete.length) {
		try {
			await synth.deleteEmbeddedDocuments('Item', toDelete.filter(Boolean));
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not remove unknown-school spirit abilities`, error);
		}
	}
	return { gated: true, granted };
}

// Heal-charge consumption (D): a summoned healer's Cure item carries
// `automation.consumesSummonCharge`. Each use decrements the token's charge
// pool; at zero the spirit fades.
async function consumeSummonCharge(item, _context) {
	const automation =
		item?.getFlag?.(MODULE_ID, 'automation') ?? item?.flags?.[MODULE_ID]?.automation;
	if (automation?.consumesSummonCharge !== true) return;

	// An unlinked token actor exposes its TokenDocument via actor.token
	// (actor.isToken is true). Linked/world actors have no charge pool.
	const actor = item?.actor;
	if (!actor?.isToken) return;
	const tokenDoc = actor.token;
	if (!tokenDoc) return;

	const flag = getTokenSummonFlag(tokenDoc);
	if (!flag || typeof flag.charges !== 'number') return;

	const remaining = flag.charges - 1;
	if (remaining > 0) {
		try {
			await tokenDoc.setFlag(MODULE_ID, `${SUMMON_FLAG}.charges`, remaining);
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not decrement summon heal charges`, error);
		}
		postSummonChat(
			actor,
			`<p>Lifebinding Spirit: <strong>${remaining}</strong> heal charge${remaining === 1 ? '' : 's'} remaining.</p>`,
		);
	} else {
		await dismissSummon(tokenDoc, {
			summonerActor: resolveSummonerFromToken(tokenDoc),
			template: flag.template,
			reason: '<p><em>Its power expended, the Lifebinding Spirit fades.</em></p>',
		});
	}
}

// ── Swarming Shadows (Feature B) ─────────────────────────────────────────────
// A shadow minion whose attack "would crit" (its primary die rolls its max face)
// summons another shadow minion adjacent to the target — provided its summoner
// owns the "Swarming Shadows" boon. Minions never actually crit (the system
// hard-suppresses isCritical on the minion attack paths), so crit is re-derived
// from the roll's dice. Two attack paths: single-item use (nimble.useItem) and
// group attacks (a `minionGroupAttack` chat card). The spawned minion costs
// nothing and inherits the same provenance/expiration/feature-boost patching as
// a cast one via spawnSummonedToken.
const SWARMING_SHADOWS_FEATURE = 'Swarming Shadows';
const SHADOW_MINION_TEMPLATE = 'shadow-minion';

// "Would crit": an active, non-discarded result on the primary (first) die term
// equals its faces. Works on a live DamageRoll (primaryDie accessor / .terms) and
// on a serialized rollData JSON (damageRoll.toJSON() → .terms).
function rollHasPrimaryMaxFace(rollLike) {
	if (!rollLike || typeof rollLike !== 'object') return false;
	const dieHasMaxFace = (die) => {
		const faces = Number(die?.faces);
		if (!(faces > 0) || !Array.isArray(die?.results)) return false;
		return die.results.some((r) => r && r.active !== false && !r.discarded && Number(r.result) === faces);
	};
	// Live DamageRoll exposes its extracted primary die directly.
	if (rollLike.primaryDie && dieHasMaxFace(rollLike.primaryDie)) return true;
	const terms = rollLike.terms;
	if (!Array.isArray(terms)) return false;
	const die = terms.find((t) => Number(t?.faces) > 0 && Array.isArray(t?.results));
	return die ? dieHasMaxFace(die) : false;
}

// True when the actor owns a `feature`-type item with this exact name.
function actorHasFeatureNamed(actor, name) {
	if (!(actor instanceof Actor)) return false;
	for (const it of listEmbeddedItems(actor)) {
		if (it?.type === 'feature' && it.name === name) return true;
	}
	return false;
}

// The summon config that spawns `template`, read off the caster's own spell that
// declares it (the summoner necessarily owns Summon Shadow). Carries maxCount,
// featureBoosts and reachPerLevels so a swarm spawn matches a cast one.
function findSummonConfigForTemplate(actor, template) {
	if (!(actor instanceof Actor)) return null;
	for (const it of listEmbeddedItems(actor)) {
		const summon = getItemSummonAutomation(it);
		if (summon?.template === template) return summon;
	}
	return null;
}

// Live summon cap for `summon` on `caster` (Infinity when uncapped).
function getSummonCap(caster, summon) {
	if (summon?.maxCount === 'minIntOrLevel') {
		return Math.max(0, Math.min(getAbilityMod(caster, 'intelligence'), getCharacterLevel(caster)));
	}
	return Infinity;
}

// First free grid square among a target token's 8 neighbours (orthogonals first),
// else overlap to the east as a last resort.
function findFreeAdjacentPosition(scene, targetToken) {
	const grid = scene?.grid?.size ?? 100;
	const tx = Number(targetToken?.x) || 0;
	const ty = Number(targetToken?.y) || 0;
	const occupied = new Set();
	for (const t of scene?.tokens ?? []) occupied.add(`${Math.round(t.x)},${Math.round(t.y)}`);
	const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
	for (const [dx, dy] of offsets) {
		const x = tx + dx * grid;
		const y = ty + dy * grid;
		if (!occupied.has(`${Math.round(x)},${Math.round(y)}`)) return { x, y };
	}
	return { x: tx + grid, y: ty };
}

// Whisper the summoner's owner(s) that the swarm is at its limit.
function postSwarmAtCapWhisper(caster) {
	try {
		const recipients = [];
		for (const user of game.users ?? []) {
			if (user?.isGM) continue;
			if (caster?.testUserPermission?.(user, 'OWNER')) recipients.push(user.id);
		}
		const gm = game.users?.activeGM;
		if (gm?.id && !recipients.includes(gm.id)) recipients.push(gm.id);
		const data = {
			content: '<p><em>Swarming Shadows:</em> the shadow swarm is already at its limit — no new minion rises.</p>',
			whisper: recipients,
		};
		if (caster) data.speaker = ChatMessage.getSpeaker({ actor: caster });
		ChatMessage.create(data);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Could not post swarm-at-cap whisper`, error);
	}
}

// Spawn one Swarming-Shadows minion adjacent to `targetToken` (respecting the
// spell's cap). Returns the created token, or null when blocked/at cap.
async function spawnSwarmingShadow(caster, summon, targetToken, scene) {
	if (!(caster instanceof Actor) || !summon || !scene) return null;

	const cap = getSummonCap(caster, summon);
	const count = findLiveSummons(caster, summon.template).length;
	if (count >= cap) {
		postSwarmAtCapWhisper(caster);
		return null;
	}

	const baseActor = await resolveCompanionBaseActor(summon.template);
	if (!baseActor) {
		console.warn(`[${MODULE_ID}] Swarming Shadows could not resolve template "${summon.template}".`);
		return null;
	}

	const { x, y } = findFreeAdjacentPosition(scene, targetToken);
	const created = await spawnSummonedToken({ caster, summon, baseActor, scene, x, y });
	if (!created) return null;

	const targetName = targetToken?.name ?? 'the target';
	postSummonChat(
		caster,
		`<p><em>Swarming Shadows:</em> a new shadow minion rises beside <strong>${escapeHtml(targetName)}</strong>.</p>`,
		SWARMING_SHADOWS_FEATURE,
	);
	return created;
}

// Given a shadow-minion token and its damage rolls, spawn a swarm minion iff any
// roll "would crit" and the summoner owns Swarming Shadows. Shared by both paths.
async function maybeSwarmFromMinionAttack(minionTokenDoc, rollLikes, targetToken, scene) {
	const flag = getTokenSummonFlag(minionTokenDoc);
	if (flag?.template !== SHADOW_MINION_TEMPLATE) return;
	if (!Array.isArray(rollLikes) || !rollLikes.some(rollHasPrimaryMaxFace)) return;

	const caster = resolveSummonerFromToken(minionTokenDoc);
	if (!caster || !actorHasFeatureNamed(caster, SWARMING_SHADOWS_FEATURE)) return;

	const summon = findSummonConfigForTemplate(caster, SHADOW_MINION_TEMPLATE);
	if (!summon) return;

	const spawnScene = scene ?? minionTokenDoc?.parent ?? canvas?.scene;
	if (!spawnScene) return;
	await spawnSwarmingShadow(caster, summon, targetToken, spawnScene);
}

// Path 1: single-item minion attack (nimble.useItem). Fires on the acting client
// only, so no double-execution guard is needed.
async function handleSwarmingShadowsUseItem(item, context) {
	const actor = item?.actor;
	if (!actor?.isToken) return;
	const tokenDoc = actor.token;
	if (!tokenDoc) return;

	const targetPlaceable = context?.targets?.[0] ?? null;
	const targetDoc = targetPlaceable?.document ?? targetPlaceable ?? null;
	const scene = targetDoc?.parent ?? tokenDoc.parent ?? canvas?.scene;
	await maybeSwarmFromMinionAttack(tokenDoc, context?.rolls ?? [], targetDoc, scene);
}

// Resolve a combatant by id across every active combat.
function resolveCombatantById(id) {
	if (!id) return null;
	for (const combat of game.combats ?? []) {
		const combatant = combat.combatants?.get?.(id);
		if (combatant) return combatant;
	}
	return null;
}

// Resolve the primary target TokenDocument from a group-attack card's target
// UUID list (system.targets; targets[0] is the primary).
function resolveGroupAttackTargetToken(targetUuids) {
	for (const uuid of targetUuids ?? []) {
		try {
			const doc = fromUuidSync?.(uuid);
			const tokenDoc = doc?.document ?? doc;
			if (tokenDoc) return tokenDoc;
		} catch {
			/* ignore and try the next */
		}
	}
	return null;
}

// Path 2: group attacks post ONE `minionGroupAttack` card with a per-member row
// (row.roll = damageRoll.toJSON()). Each would-crit shadow-minion member whose
// summoner owns Swarming Shadows spawns one minion beside the shared target.
async function handleSwarmingShadowsGroupAttack(message) {
	const rows = message?.system?.rows;
	if (!Array.isArray(rows) || !rows.length) return;

	const targetDoc = resolveGroupAttackTargetToken(message.system?.targets);
	const scene = targetDoc?.parent ?? canvas?.scene;

	for (const row of rows) {
		if (row?.isMiss) continue;
		if (!rollHasPrimaryMaxFace(row?.roll)) continue;
		const combatant = resolveCombatantById(row?.memberCombatantId);
		const tokenDoc = combatant?.token;
		if (!tokenDoc) continue;
		// Each qualifying member spawns its own minion (cap re-checked per spawn).
		await maybeSwarmFromMinionAttack(tokenDoc, [row.roll], targetDoc, scene);
	}
}

// createChatMessage hook: only the client whose user authored the card executes,
// so a group attack spawns each swarm minion exactly once regardless of GM count.
async function onCreateChatMessage(message) {
	try {
		if (message?.type !== 'minionGroupAttack') return;
		const authorId = message.author?.id ?? message.author;
		if (authorId && game.user?.id !== authorId) return;
		await handleSwarmingShadowsGroupAttack(message);
	} catch (error) {
		console.warn(`[${MODULE_ID}] Swarming Shadows group-attack handler failed`, error);
	}
}

// Combat-end cleanup (C): remove every token whose summon flag names the combat
// that just ended. Only one client acts (prefer the active GM).
async function cleanupCombatSummons(combat) {
	const combatId = combat?.id;
	if (!combatId) return;

	const hits = [];
	for (const scene of game.scenes ?? []) {
		for (const token of scene.tokens ?? []) {
			if (getTokenSummonFlag(token)?.combatId === combatId) hits.push({ scene, token });
		}
	}
	if (!hits.length) return;

	// Clear any unique-tracking flags pointing at the doomed tokens.
	for (const { token } of hits) {
		const caster = resolveSummonerFromToken(token);
		const tmpl = getTokenSummonFlag(token)?.template;
		if (!caster || !tmpl) continue;
		try {
			const tracked = caster.getFlag?.(MODULE_ID, `${SUMMONS_TRACK_FLAG}.${tmpl}`);
			if (tracked?.tokenId === token.id) {
				await caster.unsetFlag(MODULE_ID, `${SUMMONS_TRACK_FLAG}.${tmpl}`);
			}
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not clear summon tracking on combat end`, error);
		}
	}

	// Batch-delete per scene.
	const byScene = new Map();
	for (const { scene, token } of hits) {
		if (!byScene.has(scene)) byScene.set(scene, []);
		byScene.get(scene).push(token.id);
	}
	for (const [scene, ids] of byScene) {
		try {
			await scene.deleteEmbeddedDocuments('Token', ids);
		} catch (error) {
			console.warn(`[${MODULE_ID}] Could not delete combat-expired summons`, error);
		}
	}

	postSummonChat(null, '<p><em>The shadow minions dissolve as combat ends.</em></p>');
}

function onDeleteCombat(combat) {
	try {
		// Only one client should perform the deletions. Prefer the designated
		// active GM; fall back to any GM if that API is unavailable.
		const shouldAct = game.users?.activeGM ? game.users.activeGM.isSelf : game.user?.isGM;
		if (!shouldAct) return;
		void cleanupCombatSummons(combat);
	} catch (error) {
		console.warn(`[${MODULE_ID}] combat-end summon cleanup failed`, error);
	}
}

// Safe Rest (E): dismiss every lifebinding-spirit summon (all casters). Fires on
// the resting client; no active-GM guard (that client owns/deletes the tokens).
async function dismissAllLifebindingSpirits() {
	const tokens = [];
	for (const scene of game.scenes ?? []) {
		for (const token of scene.tokens ?? []) {
			if (getTokenSummonFlag(token)?.template === 'lifebinding-spirit') tokens.push(token);
		}
	}
	if (!tokens.length) return;
	for (const token of tokens) {
		await dismissSummon(token, {
			summonerActor: resolveSummonerFromToken(token),
			template: 'lifebinding-spirit',
		});
	}
	postSummonChat(null, '<p><em>The Lifebinding Spirits fade as the party takes a Safe Rest.</em></p>');
}

function onSummonRest(payload) {
	if (payload?.restType !== 'safe') return;
	dismissAllLifebindingSpirits().catch((error) =>
		console.warn(`[${MODULE_ID}] Safe Rest summon dismiss failed`, error),
	);
}

// Register the combat-end + rest hooks. The `useItem` hook (spawn + charge
// consumption) and the `activate` wrap (pre-activate gate) are already installed
// by installOnHitAutomation, so this only adds what that section doesn't.
// Idempotent, mirroring `onHitAutomationInstalled`.
let summonAutomationInstalled = false;
function installSummonAutomation() {
	if (summonAutomationInstalled) return;
	Hooks.on('deleteCombat', onDeleteCombat);
	Hooks.on(`${game.system?.id ?? 'nimble'}.rest`, onSummonRest);
	// Swarming Shadows group-attack path: minion group attacks bypass `useItem`
	// and post a single `minionGroupAttack` chat card instead.
	Hooks.on('createChatMessage', onCreateChatMessage);
	summonAutomationInstalled = true;
}

// ── Shadowmancer casting rules (Pilfered Power) ──────────────────────────────
// Shadowmancer casters differ from the generic Nimble mana model in two ways:
//   1. A custom spell-tier unlock table (steeper than the core [1,4,6,8,…]).
//   2. "Pilfered Power": mana.max == DEX and every tiered cast costs exactly
//      1 mana (= one of your DEX uses), regardless of the spell's tier.
// Only actors owning a class item with identifier 'shadowmancer' are affected;
// every other actor is untouched. Cantrips (tier 0, incl. Summon Shadow) are
// never touched. See installShadowmancerCasting for the four seams: (1) custom
// cap table, (2) flat 1-mana cost, (3) forced max-tier upcast (auto-answering the
// upcast dialog), and (4) 0-mana overdraft damage.
const SHADOWMANCER_TIER_THRESHOLDS = [2, 5, 7, 10, 13, 16, 19];

// Highest castable spell tier for a shadowmancer at `level` (0 below level 2).
function shadowmancerHighestTier(level) {
	for (let i = SHADOWMANCER_TIER_THRESHOLDS.length - 1; i >= 0; i -= 1) {
		if (level >= SHADOWMANCER_TIER_THRESHOLDS[i]) return i + 1;
	}
	return 0;
}

// True when the actor owns a shadowmancer class item (any multiclass slot).
function isShadowmancerActor(actor) {
	if (!(actor instanceof Actor)) return false;
	for (const item of actor.items ?? []) {
		if (item.type !== 'class') continue;
		const id = item.system?.identifier || item.name?.slugify?.({ strict: true }) || '';
		if (id === 'shadowmancer') return true;
	}
	return false;
}

// Pre-cast mana snapshot per caster (uuid → mana.current before the system's own
// deduction), written in preUseItem and consumed in useItem. Single-user casting
// means one live entry at a time; keyed by uuid to stay safe across actors.
const shadowmancerPreCastMana = new Map();

// Active forced-upcast mana fudge per caster (uuid → { resources, realMana }); set
// in runWrappedActivate, cleared/restored in onSpellPreUse (on cast) or the
// activate `finally` (on cancel). See runWrappedActivate for the rationale.
const shadowmancerManaFudge = new Map();

/* ── The cast dialog, kept open ──────────────────────────────────────────────
 *
 * A shadowmancer does not choose a tier: Pilfered Power always casts at the
 * highest tier they can reach. That is a rule about mana, and it used to be
 * enforced by answering the entire dialog on the player's behalf from inside
 * this render hook — `submitActivation` resolves the promise that
 * `ItemActivationManager` is awaiting, so the window closed before it could be
 * seen. Everything else the dialog decides went with it: advantage and
 * disadvantage, situational modifiers, the primary-die fields, and — for a
 * spell whose upcast offers alternatives — which one.
 *
 * The dialog now renders and waits. Only the part the class actually fixes is
 * forced, by wrapping `submitActivation` so the player's own submission passes
 * through with `upcast` overwritten on the way past. Whatever they chose
 * everywhere else survives untouched.
 *
 * The mana fudge in `runWrappedActivate` therefore has to stand for as long as
 * the dialog is open: the Svelte component refuses to submit when
 * `manaToSpend > currentMana` (SpellUpcastDialog.svelte:248), which under
 * Pilfered Power — where mana is a use-count, not a per-tier budget — would
 * block the 0-mana overdraft cast the class is built around. It is an in-memory
 * write that triggers no re-render, and `onSpellPreUse` still restores the true
 * value before the system's own deduction.
 */
function onRenderUpcastDialog(app) {
	try {
		const actor = app?.actor;
		const item = app?.item;
		if (!isShadowmancerActor(actor)) return;
		const tier = Number(item?.system?.tier) || 0;
		if (tier < 1) return;
		if (app.__blueCodexUpcastPrepared) return;
		app.__blueCodexUpcastPrepared = true;

		const cap = Number(actor.system?.resources?.highestUnlockedSpellTier) || 0;
		const scaling = item.system?.scaling;
		const canScale = !!scaling && scaling.mode && scaling.mode !== 'none';
		const doUpcast = canScale && cap > tier;
		const choices =
			doUpcast && scaling.mode === 'upcastChoice' && Array.isArray(scaling.choices)
				? scaling.choices
				: [];

		// Read at submit time, not captured now: the player may change it while
		// the dialog is open.
		const pick = { index: 0 };

		const submit = app.submitActivation.bind(app);
		app.submitActivation = (results = {}) =>
			submit({
				...results,
				upcast: doUpcast
					? { manaToSpend: cap, choiceIndex: choices.length ? pick.index : undefined }
					: undefined,
			});

		injectForcedUpcastSection(app, { cap, doUpcast, choices, pick });
	} catch (error) {
		console.warn(`[${MODULE_ID}] shadowmancer upcast dialog setup failed`, error);
	}
}

/**
 * Stand in for the system's upcast controls on a shadowmancer's cast dialog.
 *
 * The native section is hidden rather than reused: its mana slider offers a
 * choice this class does not have, and its choice radios are only drawn once
 * that slider has been dragged past the base tier — which, for a cast that is
 * forced to the cap, never happens. In its place goes a plain statement of the
 * tier being cast at, plus the radio group when the spell's upcast has genuine
 * alternatives.
 *
 * Every anchor is optional. If the system's markup moves, nothing is injected
 * and the dialog is left exactly as the system drew it — the cast still works,
 * it just loses the explanatory row.
 */
function injectForcedUpcastSection(app, { cap, doUpcast, choices, pick }) {
	if (!doUpcast) return;
	const root = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
	if (!(root instanceof HTMLElement)) return;

	ensurePilferedPowerStyles();

	const native = root.querySelector('.nimble-upcast-section');
	if (native instanceof HTMLElement) native.style.display = 'none';

	const section = document.createElement('div');
	section.className = 'bcx-forced-upcast';

	const rows = [
		'<h3 class="bcx-forced-upcast__heading"><i class="fa-solid fa-moon"></i> Pilfered Power</h3>',
		`<p class="bcx-forced-upcast__note">Cast at <strong>tier ${cap}</strong> — a shadowmancer always casts at the highest tier they can reach.</p>`,
	];
	if (choices.length) {
		rows.push('<fieldset class="bcx-forced-upcast__choices">');
		rows.push('<legend>Choose an enhancement</legend>');
		choices.forEach((choice, index) => {
			const label = escapeHtml(choice?.label ?? `Option ${index + 1}`);
			rows.push(
				`<label class="bcx-forced-upcast__option"><input type="radio" name="bcx-upcast-choice" value="${index}"${
					index === 0 ? ' checked' : ''
				}><span>${label}</span></label>`,
			);
		});
		rows.push('</fieldset>');
	}
	section.innerHTML = rows.join('');

	for (const input of section.querySelectorAll('input[type="radio"]')) {
		input.addEventListener('change', (event) => {
			const value = Number(event.currentTarget?.value);
			if (Number.isInteger(value)) pick.index = value;
		});
	}

	if (native instanceof HTMLElement) native.after(section);
	else (root.querySelector('.nimble-sheet__body') ?? root).append(section);
}

// preUseItem (fires before the system deducts mana, upcast passed by reference).
// For a shadowmancer tiered cast: restore any active mana fudge to the real value
// (so the deduction persists the true flat cost), snapshot the real pre-cast mana,
// and tell the system to deduct exactly 1 when an upcast result exists. Never
// blocks (always returns true).
function onSpellPreUse(item, context) {
	try {
		if (item?.type !== 'spell') return true;
		const actor = item.actor;
		if (!isShadowmancerActor(actor)) return true;
		if ((Number(item.system?.tier) || 0) < 1) return true; // cantrips are free/untouched
		const fudge = shadowmancerManaFudge.get(actor.uuid);
		let realMana;
		if (fudge) {
			shadowmancerManaFudge.delete(actor.uuid);
			if (fudge.resources?.mana) fudge.resources.mana.current = fudge.realMana;
			realMana = fudge.realMana;
		} else {
			realMana = Number(actor.system?.resources?.mana?.current) || 0;
		}
		shadowmancerPreCastMana.set(actor.uuid, realMana);
		// Flat Pilfered Power cost: make the system's deduction exactly 1 mana when
		// an upcast object is present (the useItem correction is the real backstop).
		if (context?.upcast && typeof context.upcast === 'object') context.upcast.manaSpent = 1;
	} catch (error) {
		console.warn(`[${MODULE_ID}] shadowmancer preUse cost hook failed`, error);
	}
	return true;
}

// Overdraft (Pilfered Power): a tiered cast made with no remaining uses draws the
// patron's notice — take floor(maxHP/2) damage via the system's own applyDamage
// (temp-then-value), with a plain HP update as a fallback.
async function applyPatronBacklash(actor) {
	try {
		const maxHp = Number(actor.system?.attributes?.hp?.max) || 0;
		const damage = Math.floor(maxHp / 2);
		if (damage > 0) {
			if (typeof actor.applyDamage === 'function') {
				await actor.applyDamage(damage);
			} else {
				const hp = actor.system?.attributes?.hp ?? {};
				const temp = Number(hp.temp) || 0;
				const value = Number(hp.value) || 0;
				const absorbed = Math.min(temp, damage);
				await actor.update({
					'system.attributes.hp.temp': temp - absorbed,
					'system.attributes.hp.value': Math.max(0, value - (damage - absorbed)),
				});
			}
		}
		postSummonChat(
			actor,
			`<p><em>Your patron takes notice.</em> ${escapeHtml(actor.name)} suffers <strong>${damage}</strong> damage (half max HP) for casting beyond Pilfered Power's limit.</p>`,
			'Pilfered Power',
		);
	} catch (error) {
		console.warn(`[${MODULE_ID}] patron backlash failed`, error);
	}
}

// useItem correction: enforce the flat 1-mana cost regardless of the tier the
// system deducted for, and apply overdraft damage when the caster had no uses
// left. Authoritative — covers the base-tier (no-upcast) and upcast paths alike.
// No-ops for any actor without a snapshot (so it only fires on a completed cast).
async function applyShadowmancerFlatCost(item, _context) {
	if (item?.type !== 'spell') return;
	// Tier gate: a tier-0 cantrip must never consume a snapshot (defence in depth
	// against a snapshot leaked by a tiered cast that aborted after onSpellPreUse).
	if ((Number(item.system?.tier) || 0) < 1) return;
	const actor = item.actor;
	if (!actor || !shadowmancerPreCastMana.has(actor.uuid)) return;
	const preMana = shadowmancerPreCastMana.get(actor.uuid);
	shadowmancerPreCastMana.delete(actor.uuid);
	const desired = Math.max(0, preMana - 1);
	const current = Number(actor.system?.resources?.mana?.current) || 0;
	if (current !== desired) {
		await actor.update({ 'system.resources.mana.current': desired });
	}
	if (preMana <= 0) await applyPatronBacklash(actor);
}

// Install: (1) custom cap table via a prepareDerivedData wrap on the character
// document class, and (2) the flat-cost hooks. Idempotent.
let shadowmancerCastingInstalled = false;
function installShadowmancerCasting() {
	if (shadowmancerCastingInstalled) return;

	// (1) Custom casting-cap table. Core assigns highestUnlockedSpellTier with `??=`
	// (a manually-set value sticks), so we override AFTER the original prep runs —
	// a straight assignment for shadowmancers. This intentionally supersedes the
	// manual +/- tier UI for shadowmancers, and reads the total character level
	// (exact for a pure shadowmancer; approximate for a multiclass).
	const charClass = CONFIG?.NIMBLE?.Actor?.documentClasses?.character;
	const proto = charClass?.prototype;
	if (proto && typeof proto.prepareDerivedData === 'function') {
		if (!Object.prototype.hasOwnProperty.call(proto, '__blueCodexPrepDerivedWrapped')) {
			const original = proto.prepareDerivedData;
			proto.prepareDerivedData = function blueCodexPrepareDerivedData(...args) {
				const result = original.apply(this, args);
				try {
					if (isShadowmancerActor(this)) {
						const resources = this.system?.resources;
						// Only for spellcasters (mana.max > 0), matching core semantics.
						if (resources && (Number(resources.mana?.max) || 0) > 0) {
							resources.highestUnlockedSpellTier = shadowmancerHighestTier(getCharacterLevel(this));
						}
					}
				} catch (error) {
					console.warn(`[${MODULE_ID}] shadowmancer cap override failed`, error);
				}
				return result;
			};
			proto.__blueCodexPrepDerivedWrapped = true;
			// Refresh any already-prepared shadowmancer characters so the cap applies
			// without a reload.
			for (const actor of game.actors ?? []) {
				if (actor?.type === 'character' && isShadowmancerActor(actor)) {
					try {
						actor.prepareData();
					} catch (error) {
						console.warn(`[${MODULE_ID}] Could not refresh shadowmancer prep`, error);
					}
				}
			}
		}
	} else {
		console.warn(`[${MODULE_ID}] character document class missing; shadowmancer cap table not installed.`);
	}

	// (2) Flat Pilfered Power cost. useItem is already handled by onItemUsed (which
	// calls applyShadowmancerFlatCost); here we only add the preUseItem snapshot.
	Hooks.on(`${game.system?.id ?? 'nimble'}.preUseItem`, onSpellPreUse);

	// (3) Forced max-tier upcast: auto-answer the SpellUpcastDialog. It is a
	// SvelteApplicationMixin(ApplicationV2) whose render lifecycle emits the
	// standard `render<ClassName>` hook (same pattern nim-plus uses for
	// renderCharacterCreationDialog / renderGenericDialog); keepNames keeps the
	// class name `SpellUpcastDialog` intact in the dist bundle.
	Hooks.on('renderSpellUpcastDialog', onRenderUpcastDialog);

	shadowmancerCastingInstalled = true;
}

// ── Shadowmancer "Fiendish Boon" invocation ──────────────────────────────────
// The core Nimble Greater Invocation "Fiendish Boon" (system feature
// YkmdeKqEaGwhcKz1) reads "Increase your DEX or INT by 1. You have 1 fewer
// maximum Hit Dice." but ships with `system.rules: []` — pure text, no
// automation. It can be picked multiple times (gainedAtLevels [4,6,9,14,18]);
// each pick is a separate embedded feature and should independently apply its
// chosen +1 ability and −1 max Hit Die. When a pick lands (createItem) — or, for
// characters who took it before this automation existed, on the reconciler sweep
// — we prompt the owner for DEX vs INT and write two rules onto that feature
// instance: `maxHitDice -1` (dieSize 0 → the class hit-die size, self-restoring
// each prepare cycle via HitDiceManager) and `abilityBonus +1` on the chosen
// ability (added to `abilities.<ability>.bonus`). Both are permanent and derived,
// so nothing is mutated directly on the actor.
const FIENDISH_BOON_SOURCE_ID = 'YkmdeKqEaGwhcKz1';
const FIENDISH_BOON_FLAG = 'fiendishBoon';

/** True for an embedded Fiendish Boon feature (by name or compendium source). */
function isFiendishBoonItem(item) {
	if (!item || item.type !== 'feature') return false;
	if (item.name === 'Fiendish Boon') return true;
	const source = item._stats?.compendiumSource ?? '';
	return typeof source === 'string' && source.includes(FIENDISH_BOON_SOURCE_ID);
}

/** True once a Fiendish Boon instance already carries our flag or bonus rule. */
function isFiendishBoonAutomated(item) {
	if (foundry.utils.getProperty(item, `flags.${MODULE_ID}.${FIENDISH_BOON_FLAG}`)) return true;
	const rules = item.system?.rules;
	return Array.isArray(rules) && rules.some((rule) => rule?.type === 'abilityBonus');
}

/** Small DEX-vs-INT chooser; returns 'dexterity' / 'intelligence', or null if dismissed. */
async function promptFiendishBoonAbility(actor) {
	const result = await foundry.applications.api.DialogV2.wait({
		window: { title: `${actor.name} — Fiendish Boon` },
		content: `<form class="blue-codex-boon-form">
				<p>Increase an ability score by <strong>1</strong>. Your maximum Hit Dice is reduced by 1.</p>
				<div class="blue-codex-boon-list">
					<label class="blue-codex-boon-pick"><input type="radio" name="blue-codex-boon" value="dexterity" checked> Dexterity (DEX)</label>
					<label class="blue-codex-boon-pick"><input type="radio" name="blue-codex-boon" value="intelligence"> Intelligence (INT)</label>
				</div>
			</form>
			<style>
				.blue-codex-boon-pick{display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer}
				.blue-codex-boon-list{margin-top:4px}
			</style>`,
		buttons: [
			{
				action: 'confirm',
				label: 'Confirm',
				default: true,
				callback: (_event, button, dialog) => {
					const root = dialog?.element ?? button?.form ?? document;
					return root.querySelector('input[name="blue-codex-boon"]:checked')?.value ?? null;
				},
			},
		],
		rejectClose: false,
		modal: true,
	}).catch(() => null);
	return result === 'dexterity' || result === 'intelligence' ? result : null;
}

/** Write the two derived rules + our flag onto a Fiendish Boon instance. */
async function applyFiendishBoon(item, ability) {
	const existingRules = Array.isArray(item.system?.rules) ? item.system.rules : [];
	await item.update({
		'system.rules': [
			...existingRules,
			{ id: foundry.utils.randomID(), type: 'maxHitDice', value: '-1', dieSize: 0, label: 'Fiendish Boon' },
			{ id: foundry.utils.randomID(), type: 'abilityBonus', value: '1', abilities: [ability], label: 'Fiendish Boon' },
		],
	});
	await item.setFlag(MODULE_ID, FIENDISH_BOON_FLAG, { ability });
}

// In-flight prompts keyed by item.uuid (render-storm / duplicate-hook guard) and
// session-scoped declines so a dismissed prompt isn't reopened every re-render.
const fiendishBoonActive = new Set();
const fiendishBoonDeclined = new Set();

/** Prompt for + apply one Fiendish Boon instance (owner-only, idempotent). */
async function automateFiendishBoon(item) {
	const actor = item?.parent;
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	if (!isFiendishBoonItem(item) || isFiendishBoonAutomated(item)) return;
	if (fiendishBoonActive.has(item.uuid) || fiendishBoonDeclined.has(item.uuid)) return;

	fiendishBoonActive.add(item.uuid);
	try {
		const ability = await promptFiendishBoonAbility(actor);
		if (!ability) {
			// Dismissed — don't nag on every render; the sweep re-offers next session.
			fiendishBoonDeclined.add(item.uuid);
			return;
		}
		await applyFiendishBoon(item, ability);
		ui.notifications?.info(
			`Fiendish Boon: +1 ${ability === 'dexterity' ? 'DEX' : 'INT'}, −1 max Hit Die.`,
		);
	} finally {
		fiendishBoonActive.delete(item.uuid);
	}
}

/** Back-fill: automate any owned Fiendish Boon instances missing our rules (one at a time). */
async function backfillFiendishBoons(actor) {
	if (!(actor instanceof Actor) || actor.type !== 'character' || !actor.isOwner) return;
	const pending = (actor.items ?? []).filter(
		(item) => isFiendishBoonItem(item) && !isFiendishBoonAutomated(item),
	);
	for (const item of pending) {
		if (fiendishBoonActive.has(item.uuid) || fiendishBoonDeclined.has(item.uuid)) continue;
		// eslint-disable-next-line no-await-in-loop
		await automateFiendishBoon(item);
	}
}

// Combined handler: first back-fill any missing auto-grants (forms), then sync
// subclass spell schools, then offer any owed subclass-pool choices.
async function handleActorFeatures(actor) {
	if (!actor) return;
	try {
		await sweepStaleGrantCarriers(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] carrier sweep failed`, error);
	}
	try {
		await backfillAutoGrants(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] auto-grant back-fill failed`, error);
	}
	try {
		await backfillFiendishBoons(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] Fiendish Boon back-fill failed`, error);
	}
	try {
		// Runs before the subclass swap so a Shepherd already owns its death spells
		// (not necrotic) by the time a Luminary's school choice reads its schools.
		await classSpellRemapSync(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] class spell-school remap failed`, error);
	}
	try {
		await spellSchoolSync(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] spell-school sync failed`, error);
	}
	try {
		await maybePromptPools(actor);
	} catch (error) {
		console.error(`[${MODULE_ID}] pool prompt failed`, error);
	}
}

api.choosePoolOptions = (actor) => maybePromptPools(actor ?? game.user?.character);
api.syncSubclassFeatures = (actor) => handleActorFeatures(actor ?? game.user?.character);

// Re-open the subclass spell-school choice (clears the stored pick so the dialog
// is offered again). Useful if a player wants to re-decide their schools.
api.chooseSpellSchools = async (actor) => {
	const target = actor ?? game.user?.character;
	if (!target) return;
	await target.unsetFlag(MODULE_ID, 'spellSchools');
	return spellSchoolSync(target);
};

// Grant/offer subclass content after any level change, subclass selection, and
// when a character sheet opens.
Hooks.on('updateItem', (item, changes) => {
	if (item?.type !== 'class' && item?.type !== 'subclass') return;
	if (item?.type === 'class' && foundry.utils.getProperty(changes, 'system.classLevel') === undefined)
		return;
	const actor = item.parent;
	if (actor) {
		poolDeclinedAtLevel.delete(actor.id);
		handleActorFeatures(actor);
	}
});

Hooks.on('createItem', (item) => {
	if (item?.type === 'subclass') {
		const actor = item.parent;
		if (actor) handleActorFeatures(actor);
		return;
	}
	// A freshly-picked Fiendish Boon invocation → prompt the owner for the ability
	// it raises and write its derived rules (owner-only guard lives in automateFiendishBoon).
	if (item?.type === 'feature' && item.parent?.type === 'character' && isFiendishBoonItem(item)) {
		automateFiendishBoon(item);
	}
});

// ── Shadowmancer sheet reskin: "Pilfered Power" ──────────────────────────────
// Purely presentational. The Shadowmancer's casting resource is the same
// `system.resources.mana` field every Nimble caster uses, but themed as
// "Pilfered Power" (mana.max == DEX, flat 1-per-cast; see installShadowmancerCasting).
// On a shadowmancer's sheet only, we relabel the "Mana ✦" heading, swap the
// sparkles glyph for the shadow-school moon (matching SPELL_SCHOOLS.shadow above,
// `fa-solid fa-moon`), and recolor the mana bar shadow-violet.
//
// The label is a hardcoded text node in the system's PlayerCharacterSheet.svelte
// (h3.nimble-heading--mana) and the bar colors are Svelte-scoped in ManaBar.svelte,
// so the CSS overrides need an ancestor scope class (`.bcx-shadowmancer` on the
// sheet root) plus `!important`. Svelte 5 re-renders reactively without re-firing
// the Foundry render hook, so a MutationObserver keeps the patch alive; the sync
// is idempotent (no DOM writes once patched) so the observer never loops.

const PILFERED_POWER_STYLE_ID = 'bcx-pilfered-power';
const PILFERED_POWER_CSS = `
	.bcx-shadowmancer .nimble-mana-bar__bar::before {
		background: linear-gradient(to right, hsl(270 45% 18%) 0%, hsl(275 55% 42%) 100%) !important;
	}
	.bcx-shadowmancer .nimble-mana-bar {
		border-color: hsl(275 40% 45%) !important;
	}
	.bcx-shadowmancer h3.nimble-heading--mana i.fa-moon {
		color: hsl(275 60% 60%);
	}
	/* The forced-tier row that stands in for the system's upcast controls on a
	   shadowmancer's cast dialog. */
	.bcx-forced-upcast {
		border-top: 1px solid hsl(275 30% 40% / 0.5);
		margin-block-start: 0.5rem;
		padding-block-start: 0.5rem;
	}
	.bcx-forced-upcast__heading {
		align-items: center;
		display: flex;
		font-size: var(--font-size-14, 0.875rem);
		gap: 0.375rem;
		margin: 0 0 0.25rem;
	}
	.bcx-forced-upcast__heading i.fa-moon {
		color: hsl(275 60% 60%);
	}
	.bcx-forced-upcast__note {
		font-size: var(--font-size-12, 0.75rem);
		margin: 0 0 0.5rem;
		opacity: 0.85;
	}
	.bcx-forced-upcast__choices {
		border: 1px solid hsl(275 30% 40% / 0.5);
		border-radius: 4px;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0;
		padding: 0.375rem 0.5rem 0.5rem;
	}
	.bcx-forced-upcast__choices legend {
		font-size: var(--font-size-12, 0.75rem);
		padding-inline: 0.25rem;
	}
	.bcx-forced-upcast__option {
		align-items: center;
		cursor: pointer;
		display: flex;
		gap: 0.375rem;
	}
`;

/** Inject the Pilfered Power stylesheet once (guarded by id). */
function ensurePilferedPowerStyles() {
	if (document.getElementById(PILFERED_POWER_STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = PILFERED_POWER_STYLE_ID;
	style.textContent = PILFERED_POWER_CSS;
	document.head.append(style);
}

/**
 * Idempotently reskin a shadowmancer's mana resource as "Pilfered Power".
 * On non-shadowmancer character sheets it strips the scope class and returns.
 * Every branch is a no-op once already applied, so the MutationObserver that
 * drives it never enters a mutation loop.
 */
function syncPilferedPower(app) {
	const actor = app?.document ?? app?.actor;
	const root = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
	if (!(root instanceof HTMLElement)) return;
	if (!(actor instanceof Actor) || actor.type !== 'character') return;

	if (!isShadowmancerActor(actor)) {
		root.classList.remove('bcx-shadowmancer');
		return;
	}

	ensurePilferedPowerStyles();
	root.classList.add('bcx-shadowmancer');

	const heading = root.querySelector('h3.nimble-heading--mana');
	if (!heading) return;

	// Relabel the hardcoded text node (first TEXT_NODE reading "Mana").
	for (const node of heading.childNodes) {
		if (node.nodeType !== Node.TEXT_NODE) continue;
		const trimmed = (node.nodeValue ?? '').trim();
		if (trimmed === 'Pilfered Power') break; // already patched
		if (trimmed === 'Mana') {
			node.nodeValue = (node.nodeValue ?? '').replace('Mana', 'Pilfered Power');
			break;
		}
	}

	// Swap the ✦ sparkles glyph for the shadow-school moon.
	const icon = heading.querySelector('i.fa-sparkles');
	if (icon) icon.classList.replace('fa-sparkles', 'fa-moon');
}

/**
 * Watch the sheet for reactive Svelte re-renders (which don't fire a Foundry
 * render hook) and keep the Pilfered Power reskin applied. Mirrors nim-plus's
 * setupFeatsTabObserver lifecycle.
 */
function setupPilferedPowerObserver(app) {
	const root = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
	if (!(root instanceof HTMLElement)) return;
	try {
		app.__bcxPilferedObserver?.disconnect();
	} catch (_error) {
		/* previous observer already gone */
	}
	const observer = new MutationObserver(() => syncPilferedPower(app));
	observer.observe(root, { childList: true, subtree: true });
	app.__bcxPilferedObserver = observer;
	syncPilferedPower(app);
}

Hooks.on('renderPlayerCharacterSheet', (app) => {
	const actor = app?.document ?? app?.actor;
	if (actor) {
		wrapTriggerLevelUp(actor);
		handleActorFeatures(actor);
	}
	setupPilferedPowerObserver(app);
});

Hooks.on('closePlayerCharacterSheet', (app) => {
	try {
		app.__bcxPilferedObserver?.disconnect();
	} catch (_error) {
		/* nothing to disconnect */
	}
	delete app.__bcxPilferedObserver;
});

// ── Compendium level badges for class features ───────────────────────────────
// Nimble's own renderCompendium hook badges each class-feature entry with its
// gainedAtLevels and sorts by level — but it is hard-scoped to the system's
// `nimble.nimble-class-features` pack. Replicate it for this module's pack so
// fixed features show a single level (3/7/11/15) while pool options show their
// full milestone list (e.g. "4, 6, 8, …"), exactly like the core subclasses.
// Reuses the system's CSS class names so the styling matches.
const CF_ENTRY_WITH_LEVEL_CLASS = 'nimble-compendium-entry-with-level';
const CF_LEVEL_BADGE_CLASS = 'nimble-compendium-entry-level';
const CF_LEVEL_NAME_FLEX_CLASS = 'nimble-class-feature-name-flex';

function cfToLevels(value) {
	const levels = new Set();
	const push = (candidate) => {
		const parsed = typeof candidate === 'number' ? candidate : Number.parseInt(candidate, 10);
		if (Number.isFinite(parsed) && parsed > 0) levels.add(parsed);
	};
	if (Array.isArray(value)) value.forEach(push);
	else if (typeof value === 'number') push(value);
	else if (typeof value === 'string') (value.match(/\d+/g) ?? []).forEach(push);
	return [...levels].sort((a, b) => a - b);
}

function cfEntryLevels(indexEntry) {
	const fromArray = cfToLevels(foundry.utils.getProperty(indexEntry ?? {}, 'system.gainedAtLevels'));
	if (fromArray.length > 0) return fromArray;
	return cfToLevels(foundry.utils.getProperty(indexEntry ?? {}, 'system.gainedAtLevel'));
}

function applyClassFeatureLevelBadges(pack, container) {
	const entries = [];
	for (const entryElement of container.querySelectorAll('[data-entry-id]')) {
		const entryId = entryElement.dataset.entryId;
		if (!entryId || !entryElement.parentElement) continue;
		const nameElement =
			entryElement.querySelector('.entry-name') ?? entryElement.querySelector('a') ?? entryElement;
		const levels = cfEntryLevels(pack.index.get(entryId));
		entries.push({ entryElement, nameElement, parent: entryElement.parentElement, levels });

		if (levels.length < 1) {
			entryElement.classList.remove(CF_ENTRY_WITH_LEVEL_CLASS);
			nameElement.classList.remove(CF_LEVEL_NAME_FLEX_CLASS);
			nameElement.querySelector(`.${CF_LEVEL_BADGE_CLASS}`)?.remove();
			continue;
		}

		nameElement.classList.add(CF_LEVEL_NAME_FLEX_CLASS);
		nameElement.style.setProperty('display', 'flex', 'important');
		nameElement.style.setProperty('align-items', 'center', 'important');
		nameElement.style.setProperty('width', '100%', 'important');
		nameElement.style.setProperty('min-width', '0', 'important');

		let badge = nameElement.querySelector(`.${CF_LEVEL_BADGE_CLASS}`);
		if (!badge) {
			badge = document.createElement('span');
			badge.classList.add(CF_LEVEL_BADGE_CLASS);
			nameElement.append(badge);
		}
		badge.style.setProperty('margin-left', 'auto', 'important');
		badge.style.setProperty('margin-right', '6px', 'important');
		badge.style.setProperty('display', 'inline-block', 'important');
		badge.style.setProperty('white-space', 'nowrap', 'important');
		badge.textContent = levels.join(', ');
		entryElement.classList.add(CF_ENTRY_WITH_LEVEL_CLASS);
	}

	// Sort entries within each folder by first level (then single-level before
	// multi-level, then name) — matching the core subclass ordering.
	const byParent = new Map();
	for (const entry of entries) {
		if (!byParent.has(entry.parent)) byParent.set(entry.parent, []);
		byParent.get(entry.parent).push(entry);
	}
	for (const [parent, group] of byParent) {
		group.sort((a, b) => {
			const aLevel = a.levels[0] ?? Number.MAX_SAFE_INTEGER;
			const bLevel = b.levels[0] ?? Number.MAX_SAFE_INTEGER;
			if (aLevel !== bLevel) return aLevel - bLevel;
			if (a.levels.length !== b.levels.length) return a.levels.length - b.levels.length;
			return (a.nameElement.textContent ?? '').localeCompare(b.nameElement.textContent ?? '', undefined, {
				numeric: true,
				sensitivity: 'base',
			});
		});
		for (const entry of group) parent.append(entry.entryElement);
	}
}

Hooks.on('renderCompendium', (application, element) => {
	const pack = application?.collection;
	if (!pack || pack.collection !== CLASS_FEATURES_PACK) return;
	const container = element instanceof HTMLElement ? element : element?.[0];
	if (!(container instanceof HTMLElement)) return;
	pack
		.getIndex({ fields: ['system.gainedAtLevel', 'system.gainedAtLevels'] })
		.then(() => applyClassFeatureLevelBadges(pack, container))
		.catch((error) =>
			console.error(`[${MODULE_ID}] Failed to badge class-feature levels`, error),
		);
});
