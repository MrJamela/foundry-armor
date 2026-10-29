// Foundry Armor. Monster armor, vulnerability and resistance for Nimble, as the 3.x books have them:
// - Medium Armor: -10 damage from each attack; Heavy Armor: -20. Critical hits ignore armor, as does damage marked
//   "Ignores Armor".
// - Vulnerable: +10 damage vs a specific damage type. Resistant: -10 damage vs a specific damage type.
// Heroes are untouched: their Armor is the Defend value, and their vulnerability and resistance stay as Nimble has it.
//
// How: while Nimble works out a card's damage, each monster target briefly reads as unarmored with no vulnerability
// or resistance, so Nimble's own versions (dice only, half, double) are off. This module works out the change
// itself and hands it to Nimble as one flat damage reduction (Nimble already knows those), or adds the extra when
// vulnerability outweighs it. Everything is put back as soon as the numbers are worked out; nothing is saved.

const MODULE_ID = 'foundry-armor';
const ARMOR = { medium: 10, heavy: 20 };
const VULNERABLE = 10;
const RESISTANT = 10;
// Marks the one reduction this module hands Nimble, so its badge can be swapped for the itemised ones.
const NET_LABEL = 'foundry-armor';

const getProperty = (object, path) => foundry.utils.getProperty(object, path);
const t = (key, data) => (data ? game.i18n.format(`FOUNDRY_ARMOR.${key}`, data) : game.i18n.localize(`FOUNDRY_ARMOR.${key}`));
const typeLabel = (type) => {
  const label = CONFIG.NIMBLE?.damageTypes?.[type];
  return label ? game.i18n.localize(label) : type;
};

const isMonster = (actor) => actor && actor.type !== 'character';

function armorOf(actor) {
  const armor = getProperty(actor, 'system.attributes.armor');
  return armor === 'medium' || armor === 'heavy' ? armor : null;
}

// The damage packets a card's Apply Damage button uses, read the way Nimble reads them.
function cardPackets(message) {
  const packets = [];
  const isMiss = message.system?.isMiss === true;
  for (const group of message.effectNodes ?? []) {
    for (const node of group) {
      if (node.type !== 'damage' && node.type !== 'damageOutcome') continue;
      const roll = node.roll;
      if (!roll || typeof roll.class !== 'string') continue;
      const outcome = node.type === 'damageOutcome' ? node.outcome : isMiss ? 'noDamage' : 'fullDamage';
      const total = Number(roll.total ?? 0);
      const value = Math.ceil((Number.isFinite(total) ? total : 0) * (outcome === 'halfDamage' ? 0.5 : 1));
      if (outcome === 'noDamage' || !(value > 0)) continue;
      packets.push({
        value,
        damageType: node.damageType,
        ignoreArmor: node.ignoreArmor === true,
        isCritical: roll.isCritical === true,
      });
    }
  }
  return packets;
}

function packetFromOptions(value, options = {}) {
  const rolls = [...(options.rolls ?? []), options.roll].filter(Boolean);
  const isCritical = rolls.length ? rolls.every((roll) => roll.isCritical === true) : options.isCritical === true;
  return {
    value: Math.max(0, Math.floor(Number(value) || 0)),
    damageType: options.damageType,
    ignoreArmor: options.ignoreArmor === true,
    isCritical,
  };
}

// One monster's defenses as Nimble stores them.
function readDefenses(actor) {
  const list = (path) => {
    const value = getProperty(actor, path);
    return Array.isArray(value) ? value : [];
  };
  const reductions = list('system.damageReductions');
  return {
    armor: armorOf(actor),
    immunities: list('system.attributes.damageImmunities'),
    vulnerabilities: list('system.attributes.damageVulnerabilities'),
    resistances: list('system.attributes.damageResistances'),
    // Resistance from a feature's rule (Nimble halves it; here it is -10 like any resistance).
    resistanceRules: reductions.filter((entry) => entry?.mode === 'half'),
    otherReductions: reductions.filter((entry) => entry?.mode !== 'half'),
  };
}

// Work out what each packet deals after armor, vulnerability and resistance. Vulnerability goes first, so a small
// vulnerable hit on an armored monster still gets its +10 before the armor comes off.
function resolveMonster(defenses, packets) {
  const rows = packets.map((packet) => {
    const immune = Boolean(packet.damageType && defenses.immunities.includes(packet.damageType));
    return { packet, immune, value: immune ? 0 : packet.value, modifiers: [] };
  });
  const live = rows.filter((row) => row.value > 0);

  let added = 0;
  for (const type of new Set(defenses.vulnerabilities)) {
    const row = live.find((candidate) => candidate.packet.damageType === type);
    if (!row) continue;
    row.value += VULNERABLE;
    added += VULNERABLE;
    row.modifiers.push({ kind: 'vulnerable', label: t('vulnerable', { type: typeLabel(type), value: VULNERABLE }) });
  }

  const spend = (amount, matches, modifier) => {
    let remaining = amount;
    for (const row of live) {
      if (remaining <= 0) break;
      if (row.value <= 0 || !matches(row)) continue;
      const used = Math.min(row.value, remaining);
      row.value -= used;
      remaining -= used;
      row.modifiers.push(modifier);
    }
    return amount - remaining;
  };

  let removed = 0;
  if (defenses.armor) {
    const amount = ARMOR[defenses.armor];
    removed += spend(amount, (row) => !row.packet.isCritical && !row.packet.ignoreArmor, {
      kind: 'reduction',
      label: t('armorBadge', { armor: t(defenses.armor), value: amount }),
    });
  }

  // Each resistance takes 10 once per attack. A packet is only resisted once, even when two sources cover it.
  const resisted = new Set();
  const resist = (covers, label) => {
    removed += spend(RESISTANT, (row) => !resisted.has(row) && covers(row.packet.damageType), {
      kind: 'resistant',
      label,
    });
    for (const row of live) if (covers(row.packet.damageType) && row.modifiers.some((m) => m.label === label)) resisted.add(row);
  };
  for (const type of new Set(defenses.resistances)) {
    resist((damageType) => damageType === type, t('resistant', { type: typeLabel(type), value: RESISTANT }));
  }
  for (const rule of defenses.resistanceRules) {
    const types = Array.isArray(rule.damageTypes) ? rule.damageTypes : [];
    const label = rule.label
      ? t('resistanceSource', { label: rule.label, value: RESISTANT })
      : t('resistanceGeneric', { value: RESISTANT });
    resist((damageType) => types.length === 0 || (damageType && types.includes(damageType)), label);
  }

  return { rows, net: removed - added };
}

// Run Nimble's damage math with each monster target switched over to these rules, then put the targets back.
// Returns, per actor, what this module worked out (for the target list and for the extra damage).
function withBookRules(targetUuids, packets, run) {
  const actors = new Set();
  for (const uuid of targetUuids ?? []) {
    const actor = fromUuidSync(uuid)?.actor;
    if (isMonster(actor)) actors.add(actor);
  }

  const results = new Map();
  const restores = [];
  let output;
  try {
    for (const actor of actors) {
      const { system } = actor;
      const attributes = system.attributes;
      const before = {
        armor: attributes.armor,
        vulnerabilities: attributes.damageVulnerabilities,
        resistances: attributes.damageResistances,
        hadReductions: Object.hasOwn(system, 'damageReductions'),
        reductions: system.damageReductions,
      };
      restores.push(() => {
        attributes.armor = before.armor;
        attributes.damageVulnerabilities = before.vulnerabilities;
        attributes.damageResistances = before.resistances;
        if (before.hadReductions) system.damageReductions = before.reductions;
        else delete system.damageReductions;
      });

      const defenses = readDefenses(actor);
      const resolved = resolveMonster(defenses, packets);
      const netLabel = NET_LABEL;
      results.set(actor, { ...resolved, defenses, netLabel });

      // Nimble's own armor, vulnerability and resistance off; this module's total change on as one reduction.
      attributes.armor = 'none';
      attributes.damageVulnerabilities = [];
      attributes.damageResistances = [];
      const reductions = [...defenses.otherReductions];
      if (resolved.net > 0) {
        reductions.unshift({ value: resolved.net, damageTypes: [], mode: 'flat', label: netLabel });
      }
      system.damageReductions = reductions;
    }
    // Nimble works out the numbers straight away, before its first pause, so they are done when this returns.
    output = run(results);
  } finally {
    for (const restore of restores.reverse()) restore();
  }
  return { output, results };
}

// When vulnerability outweighs armor and resistance, Nimble can't add damage, so add the extra as it applies it.
function addExtraDamage(results) {
  const undo = [];
  for (const [actor, { net }] of results) {
    if (net >= 0) continue;
    const extra = -net;
    const own = Object.hasOwn(actor, 'applyDamage');
    const previous = actor.applyDamage;
    actor.applyDamage = function (amount, ...rest) {
      restore();
      return previous.call(this, Number(amount) + extra, ...rest);
    };
    const restore = () => {
      if (own) actor.applyDamage = previous;
      else delete actor.applyDamage;
    };
    undo.push(restore);
  }
  return () => undo.forEach((restore) => restore());
}

// The target list: show this module's numbers and badges in place of Nimble's.
function rewriteBreakdown(breakdown, result) {
  if (!breakdown?.components || !result) return breakdown;
  const { rows, net, defenses, netLabel } = result;
  const simple = defenses.otherReductions.length === 0;
  const components = breakdown.components.map((component, index) => {
    const row = rows[index];
    if (!row) return component;
    const modifiers = component.modifiers.filter((modifier) => !modifier.label?.startsWith(netLabel));
    return {
      ...component,
      adjustedDamage: simple ? row.value : component.adjustedDamage,
      modifiers: [...row.modifiers, ...modifiers],
    };
  });
  const total = breakdown.total + (net < 0 ? -net : 0);
  return { ...breakdown, components, total };
}

Hooks.once('setup', () => {
  if (game.system.id !== 'nimble') return;

  // The armor tooltip on a card's target list.
  const effects = CONFIG.NIMBLE?.npcArmorEffects;
  if (effects) {
    effects.medium = t('mediumEffect');
    effects.heavy = t('heavyEffect');
  }

  const proto = CONFIG.ChatMessage.documentClass?.prototype;
  const readers = {
    applyDamage: (message, [value, options]) => [message.system?.targets, [packetFromOptions(value, options)]],
    canApplyDamage: (message, [value, options]) => [message.system?.targets, [packetFromOptions(value, options)]],
    applyAllDamage: (message) => [message.system?.targets, cardPackets(message)],
    canApplyAllDamage: (message) => [message.system?.targets, cardPackets(message)],
    getDamageBreakdownForTarget: (message, [targetUuid]) => [[targetUuid], cardPackets(message)],
  };

  for (const [name, read] of Object.entries(readers)) {
    const original = proto?.[name];
    if (typeof original !== 'function') {
      console.warn(`${MODULE_ID} | Nimble's chat cards have no ${name}; damage there stays as Nimble has it.`);
      continue;
    }
    proto[name] = function (...args) {
      if (!this.isActivationCard?.()) return original.apply(this, args);
      const [targets, packets] = read(this, args);
      let undoExtra = () => {};
      const { output, results } = withBookRules(targets, packets, (results) => {
        if (name === 'applyDamage' || name === 'applyAllDamage') undoExtra = addExtraDamage(results);
        return original.apply(this, args);
      });

      if (name === 'getDamageBreakdownForTarget') {
        const actor = fromUuidSync(args[0])?.actor;
        return rewriteBreakdown(output, results.get(actor));
      }
      if (output instanceof Promise) output.finally(undoExtra);
      else undoExtra();
      return output;
    };
  }
});
