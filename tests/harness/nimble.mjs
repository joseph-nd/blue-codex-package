/**
 * Ports of the Nimble system's character-creation and level-up grant pipeline
 * (FoundryVTT-Nimble `src/`), so tests drive main.mjs through the SAME seams the
 * real dialogs use:
 *
 *   - every index is read with `pack.getIndex({fields})` using the system's exact
 *     field lists (so main.mjs's getIndex patch sees the grant-path signature);
 *   - every feature/spell document is resolved through the GLOBAL `fromUuid` (so
 *     main.mjs's fromUuid rewrite applies, as it does to Nimble's dist bundle);
 *   - spells/features are created with `createEmbeddedDocuments` (preCreateItem
 *     vetoes apply), then the class item's `system.classLevel` is updated (the
 *     `updateItem` hook main.mjs listens to).
 *
 * Ported (keep in sync with the system when it changes):
 *   utils/getSpells.ts                 buildSpellIndex
 *   utils/getSpellsFromIndex.ts        getSpellsFromIndex
 *   view/dialogs/spellGrantUtils.ts    predicatePassesAtLevel, resolveSchools,
 *                                      collectKnownSchools, collectSpellGrants
 *   view/dialogs/characterCreation/utils/processGrantSpellsRules.ts
 *   utils/getClassFeatures.ts          buildClassFeatureIndex, getClassFeaturesFromIndex
 *                                      (without the duplicate-source picker and
 *                                      levelUpOptions sub-choices)
 *   utils/buildSubclassFeatureIndex.ts, utils/getSubclassFeatures.ts
 *   view/dialogs/CharacterLevelUpDialogState.svelte.ts  (the spell-grant effect)
 *   documents/actor/character.ts       triggerLevelUp → levelUp (subclass, features,
 *                                      spells, class item, actor) — HP/hit dice/skills
 *                                      are reduced to what the scripts read
 *   documents/dialogs/CharacterCreationDialog.svelte.ts (features + spells at L1)
 *
 * Choices the real dialogs ask the player for are scripted through callbacks:
 * `pickSpells(group) → uuids`, `pickSchools(group) → schools`,
 * `pickFeatures(group, features) → features`. Defaults: the first `count` options
 * for spells/schools; no feature picks (invocations etc. are not needed for spell
 * grants).
 */
import { MODULE_ID } from './foundry.mjs';

/* ───────────────────────────── spell index ───────────────────────────── */

export const SPELL_INDEX_FIELDS = [
	'system.school',
	'system.tier',
	'system.classes',
	'system.activation.cost',
	'system.properties.selected',
];

/** utils/getSpells.ts buildSpellIndex. */
export async function buildSpellIndex({ includeSecretSpells = false } = {}) {
	const index = new Map();
	const seen = new Set();
	const seenCompendiumSources = new Set();
	const addToIndex = (entry) => {
		if (seen.has(entry.uuid)) return false;
		seen.add(entry.uuid);
		if (!index.has(entry.school)) index.set(entry.school, new Map());
		const tierMap = index.get(entry.school);
		if (!tierMap.has(entry.tier)) tierMap.set(entry.tier, []);
		tierMap.get(entry.tier).push(entry);
		return true;
	};

	for (const item of game.items) {
		if (item.type !== 'spell') continue;
		const system = item.system ?? {};
		if (!system.school) continue;
		const selected = system.properties?.selected ?? [];
		const isSecret = selected.includes('secretSpell');
		if (isSecret && !includeSecretSpells) continue;
		const added = addToIndex({
			uuid: item.uuid,
			name: item.name ?? 'Unknown Spell',
			img: item.img,
			school: system.school,
			tier: system.tier ?? 0,
			isUtility: selected.includes('utilitySpell'),
			isSecret,
			classes: system.classes ?? [],
		});
		if (added && item._stats?.compendiumSource) seenCompendiumSources.add(item._stats.compendiumSource);
	}

	for (const pack of game.packs) {
		if (pack.documentName !== 'Item') continue;
		const packIndex = await pack.getIndex({ fields: SPELL_INDEX_FIELDS });
		for (const entry of packIndex) {
			if (entry.type !== 'spell') continue;
			if (seenCompendiumSources.has(entry.uuid)) continue;
			const system = entry.system;
			if (!system?.school) continue;
			const selected = system.properties?.selected ?? [];
			const isSecret = selected.includes('secretSpell');
			if (isSecret && !includeSecretSpells) continue;
			addToIndex({
				uuid: entry.uuid,
				name: entry.name ?? 'Unknown Spell',
				img: entry.img,
				school: system.school,
				tier: system.tier ?? 0,
				isUtility: selected.includes('utilitySpell'),
				isSecret,
				classes: system.classes ?? [],
			});
		}
	}
	for (const tierMap of index.values()) for (const spells of tierMap.values()) spells.sort((a, b) => a.name.localeCompare(b.name));
	return index;
}

/** utils/getSpellsFromIndex.ts */
export function getSpellsFromIndex(index, schools, tiers, { utilityOnly = false, forClass } = {}) {
	const results = [];
	for (const school of schools) {
		const tierMap = index.get(school);
		if (!tierMap) continue;
		for (const tier of tiers) {
			for (const spell of tierMap.get(tier) ?? []) {
				if (utilityOnly && !spell.isUtility) continue;
				if (!utilityOnly && spell.isUtility) continue;
				if (forClass && spell.classes.length > 0 && !spell.classes.includes(forClass)) continue;
				results.push(spell);
			}
		}
	}
	results.sort((a, b) => a.name.localeCompare(b.name));
	return results;
}

/** Flat list of every entry in a spell index (test helper). */
export function spellIndexEntries(index) {
	const out = [];
	for (const tierMap of index.values()) for (const list of tierMap.values()) out.push(...list);
	return out;
}

/* ───────────────────────────── spell grant rules ───────────────────────────── */

export function predicatePassesAtLevel(rule, level) {
	const levelPred = rule.predicate?.level;
	if (!levelPred || typeof levelPred !== 'object') return true;
	const { min, max } = levelPred;
	const mode = rule.mode ?? 'auto';
	if (mode === 'selectSchool' || mode === 'selectSpell') {
		if (min !== undefined && level !== min) return false;
	} else if (min !== undefined && level < min) return false;
	if (max !== undefined && level > max) return false;
	return true;
}

export function resolveSchools(schools, knownSchools) {
	if (!schools.includes('known')) return schools;
	return [...new Set([...schools.filter((s) => s !== 'known'), ...knownSchools])];
}

export function collectKnownSchools(rules, knownSchools) {
	for (const rule of rules) {
		if (rule.type !== 'grantSpells') continue;
		if (rule.mode !== 'auto' && rule.mode !== undefined) continue;
		for (const school of rule.schools ?? []) if (school !== 'known') knownSchools.add(school);
	}
}

/** view/dialogs/spellGrantUtils.ts collectSpellGrants (level-up). */
export function collectSpellGrants(rulesArrays, spellIndex, classIdentifier, targetLevel, ownedSpellUuids, knownSchools) {
	const autoGrant = [];
	const schoolSelections = [];
	const spellSelections = [];
	const seenUuids = new Set();
	const seenSelectionKeys = new Set();
	const uuidLookup = new Map(spellIndexEntries(spellIndex).map((s) => [s.uuid, s]));

	for (const rules of rulesArrays) {
		for (const rule of rules) {
			if (rule.type !== 'grantSpells') continue;
			if (!predicatePassesAtLevel(rule, targetLevel)) continue;
			const mode = rule.mode ?? 'auto';
			const tiers = rule.tiers ?? [0];
			const utilityOnly = rule.utilityOnly ?? false;
			const schools = Array.isArray(rule.schools) ? rule.schools : [];
			const resolvedSchools = resolveSchools(schools, knownSchools);

			if (mode === 'auto') {
				if (Array.isArray(rule.uuids) && rule.uuids.length > 0) {
					for (const uuid of rule.uuids) {
						if (seenUuids.has(uuid) || ownedSpellUuids.has(uuid)) continue;
						seenUuids.add(uuid);
						const spell = uuidLookup.get(uuid);
						if (spell) autoGrant.push(spell);
					}
				} else if (resolvedSchools.length > 0) {
					for (const spell of getSpellsFromIndex(spellIndex, resolvedSchools, tiers, { utilityOnly, forClass: classIdentifier })) {
						if (seenUuids.has(spell.uuid) || ownedSpellUuids.has(spell.uuid)) continue;
						seenUuids.add(spell.uuid);
						autoGrant.push(spell);
					}
				}
			} else if (mode === 'selectSchool' && resolvedSchools.length > 0) {
				const availableSchools = resolvedSchools.filter((school) =>
					getSpellsFromIndex(spellIndex, [school], tiers, { utilityOnly, forClass: classIdentifier }).some(
						(s) => !ownedSpellUuids.has(s.uuid),
					),
				);
				const ruleId = rule.id ?? '';
				if (availableSchools.length > 0 && !seenSelectionKeys.has(ruleId)) {
					seenSelectionKeys.add(ruleId);
					schoolSelections.push({
						ruleId,
						label: rule.label || 'Choose schools',
						availableSchools,
						tiers,
						count: rule.count ?? 1,
						utilityOnly,
						forClass: classIdentifier,
						source: 'class',
					});
				}
			} else if (mode === 'selectSpell' && resolvedSchools.length > 0) {
				const ruleId = rule.id ?? '';
				for (const school of resolvedSchools) {
					const availableSpells = getSpellsFromIndex(spellIndex, [school], tiers, {
						utilityOnly,
						forClass: classIdentifier,
					}).filter((s) => !ownedSpellUuids.has(s.uuid));
					if (availableSpells.length > 0 && !seenSelectionKeys.has(`${ruleId}-${school}`)) {
						seenSelectionKeys.add(`${ruleId}-${school}`);
						spellSelections.push({
							ruleId: `${ruleId}-${school}`,
							label: rule.label || 'Choose spells',
							availableSpells,
							count: rule.count ?? 1,
							utilityOnly,
							forClass: classIdentifier,
							source: 'class',
						});
					}
				}
			}
		}
	}
	return { autoGrant, schoolSelections, spellSelections };
}

/** characterCreation/utils/processGrantSpellsRules.ts (character creation). */
export function processGrantSpellsRules(rules, spellIndex, classIdentifier, source, autoGrant, schoolSelections, spellSelections) {
	for (const rule of rules) {
		if (rule.type !== 'grantSpells') continue;
		const mode = rule.mode ?? 'auto';
		const tiers = rule.tiers ?? [0];
		const utilityOnly = rule.utilityOnly ?? false;
		if (mode === 'auto') {
			if (rule.uuids && rule.uuids.length > 0) {
				for (const uuid of rule.uuids) {
					for (const tierMap of spellIndex.values()) {
						for (const spells of tierMap.values()) {
							const spell = spells.find((s) => s.uuid === uuid);
							if (spell) autoGrant.push(spell);
						}
					}
				}
			} else if (rule.schools && rule.schools.length > 0) {
				autoGrant.push(...getSpellsFromIndex(spellIndex, rule.schools, tiers, { utilityOnly, forClass: classIdentifier }));
			}
		} else if (mode === 'selectSchool') {
			schoolSelections.push({
				ruleId: rule.id,
				label: rule.label || 'Choose schools',
				availableSchools: rule.schools ?? [],
				tiers,
				count: rule.count ?? 1,
				utilityOnly,
				forClass: classIdentifier,
				source,
			});
		} else if (mode === 'selectSpell') {
			spellSelections.push({
				ruleId: rule.id,
				label: rule.label || 'Choose spells',
				availableSpells: getSpellsFromIndex(spellIndex, rule.schools ?? [], tiers, { utilityOnly, forClass: classIdentifier }),
				count: rule.count ?? 1,
				utilityOnly,
				forClass: classIdentifier,
				source,
			});
		}
	}
}

/* ───────────────────────────── class features ───────────────────────────── */

export const CLASS_FEATURE_INDEX_FIELDS = [
	'system.class',
	'system.subclass',
	'system.gainedAtLevel',
	'system.gainedAtLevels',
	'system.group',
	'system.selectionCountByLevel',
];
export const SUBCLASS_FEATURE_INDEX_FIELDS = [
	'system.class',
	'system.subclass',
	'system.gainedAtLevel',
	'system.gainedAtLevels',
	'system.group',
];

/** utils/getClassFeatures.ts buildClassFeatureIndex. */
export async function buildClassFeatureIndex() {
	const index = new Map();
	const seen = new Map();
	const add = (key, level, entry) => {
		const lookup = `${key}:${level}`;
		if (!seen.has(lookup)) seen.set(lookup, new Set());
		if (seen.get(lookup).has(entry.uuid)) return;
		seen.get(lookup).add(entry.uuid);
		if (!index.has(key)) index.set(key, new Map());
		const levelMap = index.get(key);
		if (!levelMap.has(level)) levelMap.set(level, []);
		levelMap.get(level).push(entry);
	};
	const processFeature = (uuid, system) => {
		if (system.subclass) return;
		const key = system.class || system.group;
		if (!key) return;
		const entry = { uuid, group: system.group || 'ungrouped', selectionCountByLevel: system.selectionCountByLevel ?? {} };
		if (system.gainedAtLevel) add(key, system.gainedAtLevel, entry);
		for (const level of system.gainedAtLevels ?? []) add(key, level, entry);
	};
	for (const item of game.items) if (item.type === 'feature') processFeature(item.uuid, item.system);
	for (const pack of game.packs) {
		if (pack.documentName !== 'Item') continue;
		const packIndex = await pack.getIndex({ fields: CLASS_FEATURE_INDEX_FIELDS });
		for (const entry of packIndex) {
			if (entry.type !== 'feature' || !entry.system) continue;
			processFeature(entry.uuid, entry.system);
		}
	}
	return index;
}

const isAutoGrantGroup = (group) => group === 'ungrouped' || group.endsWith('-progression');

/**
 * utils/getClassFeatures.ts getClassFeaturesFromIndex, without the
 * duplicate-source picker: `autoGrant` (ungrouped / *-progression, not owned),
 * `selectionGroups` (group → features), `optionFeatures` (progression features
 * with applicable levelUpOptions — offered, never auto-granted).
 */
export async function getClassFeaturesFromIndex(index, classIdentifier, level, { ownedFeatureUuids = new Set() } = {}, groupIdentifiers = []) {
	const result = { autoGrant: [], selectionGroups: new Map(), optionFeatures: [] };
	if (!classIdentifier || level < 1) return result;
	const entries = [];
	const seen = new Set();
	for (const key of [classIdentifier, ...groupIdentifiers]) {
		for (const entry of index.get(key)?.get(level) ?? []) {
			if (seen.has(entry.uuid)) continue;
			seen.add(entry.uuid);
			entries.push(entry);
		}
	}
	const features = await Promise.all(entries.map((entry) => fromUuid(entry.uuid)));
	features.forEach((feature, i) => {
		if (!feature) return;
		const group = entries[i].group;
		const options = (feature.system?.levelUpOptions ?? []).filter((opt) => (opt.levels ?? [level]).includes(level));
		if (group.endsWith('-progression') && options.length > 0) {
			result.optionFeatures.push(feature);
			return;
		}
		if (ownedFeatureUuids.has(entries[i].uuid)) return;
		if (isAutoGrantGroup(group)) result.autoGrant.push(feature);
		else {
			if (!result.selectionGroups.has(group)) result.selectionGroups.set(group, []);
			result.selectionGroups.get(group).push(feature);
		}
	});
	return result;
}

/** utils/buildSubclassFeatureIndex.ts */
export async function buildSubclassFeatureIndex() {
	const index = new Map();
	const indexFeature = (uuid, system) => {
		if (!system?.subclass || !system.class || !system.group) return;
		const levels = [...(system.gainedAtLevel ? [system.gainedAtLevel] : []), ...(system.gainedAtLevels ?? [])];
		for (const level of levels) {
			if (!index.has(system.class)) index.set(system.class, new Map());
			const classMap = index.get(system.class);
			if (!classMap.has(system.group)) classMap.set(system.group, new Map());
			const subMap = classMap.get(system.group);
			if (!subMap.has(level)) subMap.set(level, []);
			const list = subMap.get(level);
			if (!list.some((e) => e.uuid === uuid)) list.push({ uuid });
		}
	};
	for (const item of game.items) if (item.type === 'feature') indexFeature(item.uuid, item.system);
	for (const pack of game.packs) {
		if (pack.documentName !== 'Item') continue;
		const packIndex = await pack.getIndex({ fields: SUBCLASS_FEATURE_INDEX_FIELDS });
		for (const entry of packIndex) if (entry.type === 'feature') indexFeature(entry.uuid, entry.system);
	}
	return index;
}

/** utils/getSubclassFeatures.ts */
export async function getSubclassFeaturesFromIndex(index, classIdentifier, subclassIdentifier, level) {
	if (!classIdentifier || !subclassIdentifier || level < 1) return [];
	const entries = index.get(classIdentifier)?.get(subclassIdentifier)?.get(level) ?? [];
	const features = await Promise.all(entries.map((entry) => fromUuid(entry.uuid)));
	return features.filter(Boolean);
}

/* ───────────────────────────── helpers ───────────────────────────── */

const defaultPickSpells = (group) => group.availableSpells.slice(0, group.count).map((s) => s.uuid);
const defaultPickSchools = (group) => group.availableSchools.slice(0, group.count);

/** A pack document as Nimble copies it onto an actor (toObject + compendiumSource). */
function ownedSource(doc, uuid = doc.uuid) {
	const source = doc.toObject();
	source._stats ??= {};
	source._stats.compendiumSource = uuid;
	return source;
}

/** Expand school selections + spell selections into uuids (CharacterLevelUpDialogState#getGrantedSpellUuids). */
function selectedSpellUuids(spellIndex, grants, { pickSpells, pickSchools }) {
	const uuids = grants.autoGrant.map((s) => s.uuid);
	const seen = new Set(uuids);
	const choices = { schools: [], spells: [] };
	for (const group of grants.schoolSelections) {
		const schools = pickSchools(group) ?? [];
		choices.schools.push({ ruleId: group.ruleId, schools });
		for (const spell of getSpellsFromIndex(spellIndex, schools, group.tiers, { utilityOnly: group.utilityOnly, forClass: group.forClass })) {
			if (seen.has(spell.uuid)) continue;
			seen.add(spell.uuid);
			uuids.push(spell.uuid);
		}
	}
	for (const group of grants.spellSelections) {
		const picked = pickSpells(group) ?? [];
		choices.spells.push({ ruleId: group.ruleId, uuids: picked });
		for (const uuid of picked) {
			if (seen.has(uuid)) continue;
			seen.add(uuid);
			uuids.push(uuid);
		}
	}
	return { uuids, choices };
}

/** Resolve a pack document by uuid or by `{type, name, classId}` (first index hit). */
async function resolvePackDoc(ref, { type, parentClass } = {}) {
	if (!ref) return null;
	if (typeof ref !== 'string') return ref;
	if (ref.startsWith('Compendium.')) return fromUuid(ref);
	for (const pack of game.packs) {
		if (pack.documentName !== 'Item') continue;
		const index = await pack.getIndex({ fields: ['system.parentClass', 'system.identifier'] });
		for (const entry of index) {
			if (type && entry.type !== type) continue;
			if (entry.name !== ref && entry.system?.identifier !== ref) continue;
			if (parentClass && entry.system?.parentClass && entry.system.parentClass !== parentClass) continue;
			return fromUuid(entry.uuid ?? pack.getUuid(entry._id));
		}
	}
	throw new Error(`harness: no ${type ?? 'Item'} "${ref}" in the installed packs`);
}

/* ───────────────────────────── character creation ───────────────────────────── */

/**
 * The character creator for one class at level 1: creates the actor with its
 * class item, then (as CharacterCreationDialog does) the auto-granted L1 class
 * features, then the spells their grantSpells rules give — each through the
 * global fromUuid. Then renders the sheet (fires `renderPlayerCharacterSheet`,
 * which is where main.mjs installs its level-up wrap and runs its syncs) and
 * lets the async hook work settle.
 *
 * @param {object} env
 * @param {object} opts
 * @param {string} opts.classId          e.g. 'shadowmancer'
 * @param {string} [opts.name]
 * @param {object} [opts.abilities]      {dexterity: 3, …} ability MODIFIERS (default 2 each)
 * @param {Function} [opts.pickSpells]   selectSpell groups → uuids
 * @param {Function} [opts.pickSchools]  selectSchool groups → schools
 * @param {boolean} [opts.render=true]   fire renderPlayerCharacterSheet afterwards
 * @returns {Promise<{actor, spellIndex, features, spellUuids, choices}>}
 */
export async function createCharacter(env, {
	classId,
	name = `Test ${classId}`,
	abilities = {},
	pickSpells = defaultPickSpells,
	pickSchools = defaultPickSchools,
	render = true,
	ownedByPlayer = false,
} = {}) {
	const classDoc = await resolvePackDoc(classId, { type: 'class' });
	const identifier = classDoc.system?.identifier || classDoc.name.slugify({ strict: true });
	const classSource = ownedSource(classDoc);
	classSource.system = { ...classSource.system, classLevel: 1, hpData: [classSource.system?.hitDieSize ?? 8] };
	const abilityData = {};
	for (const key of ['strength', 'dexterity', 'intelligence', 'will']) {
		const mod = abilities[key] ?? 2;
		abilityData[key] = { baseValue: mod, mod };
	}
	const { Character } = env.classes;
	const actor = new Character({
		name,
		type: 'character',
		ownership: ownedByPlayer ? { default: 0, [env.users.player.id]: 3 } : { default: 0 },
		system: {
			abilities: abilityData,
			classData: { levels: [identifier] },
			levelUpHistory: [],
			resources: { mana: { current: 0, baseMax: 0 }, highestUnlockedSpellTier: null },
			attributes: { hp: { value: 10, max: 10, temp: 0 }, hitDice: {} },
		},
		items: [classSource],
	});
	env.game.actors.set(actor.id, actor);

	const [classIndex, spellIndex] = await Promise.all([buildClassFeatureIndex(), buildSpellIndex()]);
	const classFeatures = await getClassFeaturesFromIndex(classIndex, identifier, 1);

	const featureSources = classFeatures.autoGrant.map((f) => ownedSource(f));
	if (featureSources.length) await actor.createEmbeddedDocuments('Item', featureSources);

	const autoGrant = [];
	const schoolSelections = [];
	const spellSelections = [];
	for (const feature of classFeatures.autoGrant) {
		processGrantSpellsRules(feature.system?.rules ?? [], spellIndex, identifier, 'class', autoGrant, schoolSelections, spellSelections);
	}
	const { uuids, choices } = selectedSpellUuids(spellIndex, { autoGrant, schoolSelections, spellSelections }, { pickSpells, pickSchools });
	const spellSources = [];
	const seen = new Set();
	for (const uuid of uuids) {
		if (seen.has(uuid)) continue;
		seen.add(uuid);
		const spell = await fromUuid(uuid);
		if (spell) spellSources.push(ownedSource(spell, uuid));
	}
	if (spellSources.length) await actor.createEmbeddedDocuments('Item', spellSources);
	await env.flush();
	if (render) await renderSheet(env, actor);
	return { actor, spellIndex, features: classFeatures.autoGrant, spellUuids: uuids, choices, schoolSelections, spellSelections };
}

/** Fire the character sheet render hook main.mjs listens to and let its async work settle. */
export async function renderSheet(env, actor) {
	env.Hooks.callAll('renderPlayerCharacterSheet', { document: actor, actor, element: null });
	await env.flush();
}

/* ───────────────────────────── level-up ───────────────────────────── */

/**
 * `actor.triggerLevelUp(options)` → here (see documents.mjs Character). Mirrors
 * CharacterLevelUpDialogState (what the dialog previews and returns) and
 * character.ts `levelUp` (what it writes, in order):
 *   subclass → class features → spells → class item (`system.classLevel`) → actor.
 *
 * @param {object} options
 * @param {string|object} [options.subclass]   subclass name/identifier/uuid/doc to pick (level 3)
 * @param {Function} [options.pickSpells]
 * @param {Function} [options.pickSchools]
 * @param {Function} [options.pickFeatures]    (group, features) → features to take (default none)
 * @param {boolean} [options.render=true]      re-render the sheet afterwards (character.ts does)
 * @returns {Promise<object>} what the dialog showed and what landed:
 *   {level, spellIndex, preview: {autoGrant, schoolSelections, spellSelections}, spellUuids,
 *    features, createdSpells, choices}
 */
export async function runLevelUp(env, actor, {
	subclass = null,
	pickSpells = defaultPickSpells,
	pickSchools = defaultPickSchools,
	pickFeatures = () => [],
	render = true,
} = {}) {
	const characterClass = Object.values(actor.classes)[0];
	if (!characterClass) throw new Error('harness: runLevelUp on an actor without a class');
	const classIdentifier = characterClass.identifier;
	const current = Number(characterClass.system.classLevel) || 0;
	if (current >= 20) return null;
	const levelingTo = current + 1;

	// ── the dialog (CharacterLevelUpDialogState) ──
	const spellIndex = await buildSpellIndex();
	const ownedFeatureUuids = new Set(
		actor.items.filter((i) => i.type === 'feature').map((i) => i._stats?.compendiumSource).filter(Boolean),
	);
	const [classIndex, subclassIndex] = await Promise.all([buildClassFeatureIndex(), buildSubclassFeatureIndex()]);
	const rawFeatures = await getClassFeaturesFromIndex(classIndex, classIdentifier, levelingTo, { ownedFeatureUuids });

	const selectedSubclass = subclass ? await resolvePackDoc(subclass, { type: 'subclass', parentClass: classIdentifier }) : null;
	let subclassGroup;
	if (selectedSubclass) subclassGroup = selectedSubclass.name.slugify({ strict: true });
	else {
		const existing = actor.items.find((i) => i.type === 'subclass' && i.system?.parentClass === classIdentifier);
		if (existing?.name) subclassGroup = existing.name.slugify({ strict: true });
	}
	const subclassFeatures = subclassGroup
		? await getSubclassFeaturesFromIndex(subclassIndex, classIdentifier, subclassGroup, levelingTo)
		: [];
	const autoGrantFeatures = [...rawFeatures.autoGrant, ...subclassFeatures].filter((f) => !ownedFeatureUuids.has(f.uuid ?? ''));
	const selectedFeatures = [];
	for (const [group, features] of rawFeatures.selectionGroups) selectedFeatures.push(...(pickFeatures(group, features) ?? []));

	const ownedSpellUuids = new Set(
		actor.items.filter((i) => i.type === 'spell').map((i) => i._stats?.compendiumSource).filter(Boolean),
	);
	const knownSchools = new Set();
	const rulesArrays = [];
	for (const feature of [...autoGrantFeatures, ...selectedFeatures]) {
		const rules = feature.system?.rules ?? [];
		if (rules.length) rulesArrays.push(rules);
		collectKnownSchools(rules, knownSchools);
	}
	for (const item of actor.items) {
		if (item.type !== 'feature') continue;
		const rules = item.system?.rules ?? [];
		if (rules.some((r) => r.type === 'grantSpells')) {
			rulesArrays.push(rules);
			collectKnownSchools(rules, knownSchools);
		}
	}
	const grants = collectSpellGrants(rulesArrays, spellIndex, classIdentifier, levelingTo, ownedSpellUuids, knownSchools);
	const { uuids: spellUuids, choices } = selectedSpellUuids(spellIndex, grants, { pickSpells, pickSchools });

	// ── character.ts levelUp(dialogData) ──
	if (selectedSubclass && selectedSubclass.system?.parentClass === classIdentifier) {
		await actor.createEmbeddedDocuments('Item', [ownedSource(selectedSubclass)]);
	}
	const featureSources = [
		...autoGrantFeatures.map((f) => ownedSource(f)),
		...selectedFeatures.map((f) => ownedSource(f)),
	];
	const createdFeatures = featureSources.length ? await actor.createEmbeddedDocuments('Item', featureSources) : [];

	const spellSources = [];
	const seen = new Set();
	for (const uuid of spellUuids) {
		if (seen.has(uuid)) continue;
		seen.add(uuid);
		const spell = await fromUuid(uuid);
		if (spell) spellSources.push(ownedSource(spell, uuid));
	}
	const createdSpells = spellSources.length ? await actor.createEmbeddedDocuments('Item', spellSources) : [];

	await characterClass.update({
		'system.classLevel': levelingTo,
		'system.hpData': [...(characterClass.system.hpData ?? []), 5],
	});
	await actor.update({
		'system.classData.levels': [...(actor.system.classData?.levels ?? []), classIdentifier],
		'system.levelUpHistory': [
			...(actor.system.levelUpHistory ?? []),
			{
				level: levelingTo,
				classIdentifier,
				grantedFeatureIds: createdFeatures.map((i) => i.id),
				grantedSpellIds: createdSpells.map((i) => i.id),
			},
		],
	});
	await env.flush();
	if (render) await renderSheet(env, actor);
	return {
		level: levelingTo,
		spellIndex,
		preview: grants,
		spellUuids,
		choices,
		features: createdFeatures,
		createdSpells,
		optionFeatures: rawFeatures.optionFeatures,
	};
}

/**
 * Create a character at level 1 and level it up to `level` with the native
 * flow at every step (main.mjs's triggerLevelUp wrap included).
 * @returns {Promise<{actor, steps: object[]}>} steps[0] = creation, steps[n] = level n+1
 */
export async function buildCharacterByLevelUps(env, classId, level, { subclass = null, subclassAt = 3, ...opts } = {}) {
	const creation = await createCharacter(env, { classId, ...opts });
	const { actor } = creation;
	const steps = [creation];
	for (let lvl = 2; lvl <= level; lvl += 1) {
		// eslint-disable-next-line no-await-in-loop
		steps.push(
			await actor.triggerLevelUp({
				...opts,
				subclass: lvl === subclassAt ? subclass : null,
			}),
		);
	}
	return { actor, steps };
}

/** Owned spells as `{name, school, tier, source}` sorted by tier then name (test helper). */
export function spellSummary(actor) {
	return actor.items
		.filter((i) => i.type === 'spell')
		.map((i) => ({
			name: i.name,
			school: i.system?.school,
			tier: Number(i.system?.tier ?? 0) || 0,
			source: i._stats?.compendiumSource ?? null,
		}))
		.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
}

/** True when `uuid` is a Codex spells-pack uuid. */
export const isCodexSpellUuid = (uuid) => String(uuid ?? '').startsWith(`Compendium.${MODULE_ID}.blue-codex-spells.`);
