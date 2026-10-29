// Foundry Armor. Simpler monster armor for Nimble: Medium Armor subtracts 10 from incoming damage, Heavy Armor
// subtracts 20. Everything else about armor stays as Nimble has it: critical hits, vulnerable damage and
// "Ignores Armor" damage still get past it, and heroes' Armor (the Defend value) is untouched.
//
// How: Nimble already knows flat damage reduction (the "-10" badges on a card's target list). While Nimble works
// out a card's damage, each armored target briefly reads as unarmored, so Nimble's own Medium/Heavy math is off,
// and gains one flat reduction for its armor. Nimble applies that once per attack, like Defend. Everything is put
// back as soon as the numbers are worked out, so nothing is saved to the actor.

const MODULE_ID = 'foundry-armor';
const ARMOR = { medium: 10, heavy: 20 };

const getProperty = (object, path) => foundry.utils.getProperty(object, path);

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
      if (outcome === 'noDamage') continue;
      packets.push({
        damageType: node.damageType,
        ignoreArmor: node.ignoreArmor === true,
        isCritical: roll.isCritical === true,
      });
    }
  }
  return packets;
}

function packetFromOptions(options = {}) {
  const rolls = [...(options.rolls ?? []), options.roll].filter(Boolean);
  const isCritical = rolls.length ? rolls.every((roll) => roll.isCritical === true) : options.isCritical === true;
  return { damageType: options.damageType, ignoreArmor: options.ignoreArmor === true, isCritical };
}

// Which damage types the armor works against for this attack. [] means all damage; null means none of it.
function armorScope(packets, vulnerabilities) {
  const blocked = (packet) =>
    !packet.isCritical && !packet.ignoreArmor && !(packet.damageType && vulnerabilities.includes(packet.damageType));
  const affected = packets.filter(blocked);
  if (!affected.length) return null;
  if (affected.length === packets.length) return [];
  const types = [...new Set(affected.map((packet) => packet.damageType).filter(Boolean))];
  return types.length ? types : null;
}

// Run Nimble's damage math with each armored target switched over to flat armor, then put the targets back.
function withFlatArmor(targetUuids, packets, run) {
  const actors = new Set();
  for (const uuid of targetUuids ?? []) {
    const actor = fromUuidSync(uuid)?.actor;
    if (actor && armorOf(actor)) actors.add(actor);
  }

  const restores = [];
  try {
    for (const actor of actors) {
      const armor = armorOf(actor);
      const { system } = actor;
      const attributes = system.attributes;
      const before = {
        armor: attributes.armor,
        vulnerabilities: attributes.damageVulnerabilities,
        hadReductions: Object.hasOwn(system, 'damageReductions'),
        reductions: system.damageReductions,
      };
      restores.push(() => {
        attributes.armor = before.armor;
        attributes.damageVulnerabilities = before.vulnerabilities;
        if (before.hadReductions) system.damageReductions = before.reductions;
        else delete system.damageReductions;
      });

      const vulnerabilities = Array.isArray(before.vulnerabilities) ? before.vulnerabilities : [];
      const scope = armorScope(packets, vulnerabilities);

      // Unarmored to Nimble, so it skips its own armor math. Vulnerable damage already gets past armor, so it
      // is left out of the armor below and must not double here (Nimble doubles it only on unarmored targets).
      attributes.armor = 'none';
      attributes.damageVulnerabilities = [];
      if (scope) {
        const entry = {
          value: ARMOR[armor],
          damageTypes: scope,
          mode: 'flat',
          label: game.i18n.localize(`FOUNDRY_ARMOR.${armor}`),
        };
        system.damageReductions = [entry, ...(Array.isArray(before.reductions) ? before.reductions : [])];
      }
    }
    // Nimble works out the numbers straight away, before its first pause, so they are done when this returns.
    return run();
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

Hooks.once('setup', () => {
  if (game.system.id !== 'nimble') return;

  // The armor tooltip on a card's target list.
  const effects = CONFIG.NIMBLE?.npcArmorEffects;
  if (effects) {
    effects.medium = game.i18n.localize('FOUNDRY_ARMOR.mediumEffect');
    effects.heavy = game.i18n.localize('FOUNDRY_ARMOR.heavyEffect');
  }

  const proto = CONFIG.ChatMessage.documentClass?.prototype;
  const wraps = {
    applyDamage: (message, [, options]) => [message.system?.targets, [packetFromOptions(options)]],
    canApplyDamage: (message, [, options]) => [message.system?.targets, [packetFromOptions(options)]],
    applyAllDamage: (message) => [message.system?.targets, cardPackets(message)],
    canApplyAllDamage: (message) => [message.system?.targets, cardPackets(message)],
    getDamageBreakdownForTarget: (message, [targetUuid]) => [[targetUuid], cardPackets(message)],
  };

  for (const [name, read] of Object.entries(wraps)) {
    const original = proto?.[name];
    if (typeof original !== 'function') {
      console.warn(`${MODULE_ID} | Nimble's chat cards have no ${name}; armor there stays as Nimble has it.`);
      continue;
    }
    proto[name] = function (...args) {
      if (!this.isActivationCard?.()) return original.apply(this, args);
      const [targets, packets] = read(this, args);
      return withFlatArmor(targets, packets, () => original.apply(this, args));
    };
  }
});
