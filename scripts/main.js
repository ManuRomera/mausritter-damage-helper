const MODULE_ID = "mausritter-combat-carousel";
const SYSTEM_ID = "mausritter";
const ACTOR_TYPES = new Set(["character", "hireling", "creature"]);
const CHAT_HOOK = Number(globalThis.game?.release?.generation ?? 0) >= 13 ? "renderChatMessageHTML" : "renderChatMessage";
const processedCriticalMessages = new Set();
const processingUsageMessages = new Set();
const newUsageMessageIds = new Set();

Hooks.once("init", () => {
  if (game.system.id !== SYSTEM_ID) return;
  registerSettings();
});

Hooks.on(CHAT_HOOK, (message, html) => {
  if (game.system.id !== SYSTEM_ID) return;
  const element = html instanceof HTMLElement ? html : html?.[0];
  if (!element) return;
  injectDamageButton(message, element);
  injectUsageResult(message, element);
  if (newUsageMessageIds.has(message.id)) void consumeItemUse(message, element);
  resolvePendingCriticalFromSave(message, element);
});

Hooks.on("createChatMessage", (message, _options, userId) => {
  if (game.system.id !== SYSTEM_ID || !isLocalMessageAuthor(message, userId)) return;
  newUsageMessageIds.add(message.id);
  void consumeItemUse(message);
});

function registerSettings() {
  registerBooleanSetting("applyArmor", true, true, "MCC.Settings.ApplyArmor.Name", "MCC.Settings.ApplyArmor.Hint");
  registerBooleanSetting("promptStrengthSave", true, true, "MCC.Settings.PromptStrengthSave.Name", "MCC.Settings.PromptStrengthSave.Hint");
  registerBooleanSetting("autoCritical", true, true, "MCC.Settings.AutoCritical.Name", "MCC.Settings.AutoCritical.Hint");
  registerBooleanSetting("useGrit", false, true, "MCC.Settings.UseGrit.Name", "MCC.Settings.UseGrit.Hint");
  registerBooleanSetting("wdipLabels", true, true, "MCC.Settings.WdipLabels.Name", "MCC.Settings.WdipLabels.Hint");
  registerBooleanSetting("autoUsage", true, true, "MCC.Settings.AutoUsage.Name", "MCC.Settings.AutoUsage.Hint");
}

async function consumeItemUse(message, element = null) {
  if (!game.settings.get(MODULE_ID, "autoUsage")) return;
  if (message.getFlag(MODULE_ID, "usage")) return;

  const source = extractItemSource(message.content, message.speaker, element);
  if (!source?.itemId && !source?.itemName) return;

  const actor = resolveActor(source.actorId, message.speaker);
  const item = source.itemId
    ? actor?.items?.get(source.itemId)
    : actor?.items?.find(candidate => candidate.name === source.itemName && numberAt(candidate, "system.pips.max") > 0);
  if (!item || !actor.canUserModify(game.user, "update")) return;

  const maximum = Math.max(numberAt(item, "system.pips.max"), 0);
  if (!maximum) return;
  if (processingUsageMessages.has(message.id)) return;
  processingUsageMessages.add(message.id);

  try {
    const previous = Math.min(Math.max(numberAt(item, "system.pips.value"), 0), maximum);
    const current = Math.min(previous + 1, maximum);
    const exhausted = previous >= maximum;

    if (!exhausted) await item.update({ "system.pips.value": current });

    const usage = {
      actorId: actor.id,
      itemId: item.id,
      name: item.name,
      previous,
      current,
      maximum,
      exhausted
    };

    try {
      await message.setFlag(MODULE_ID, "usage", usage);
    } catch (error) {
      console.warn(`${MODULE_ID} | The item use was recorded, but the chat card could not be updated.`, error);
    }

    const notificationKey = exhausted ? "MCC.UsageAlreadyExhausted" : current >= maximum ? "MCC.UsageExhausted" : "MCC.UsageSpent";
    const notification = game.i18n.format(notificationKey, {
      name: item.name,
      current,
      maximum
    });
    exhausted || current >= maximum ? ui.notifications.warn(notification) : ui.notifications.info(notification);
    newUsageMessageIds.delete(message.id);
  } catch (error) {
    processingUsageMessages.delete(message.id);
    console.error(`${MODULE_ID} | Failed to spend an item use.`, error);
    ui.notifications.error(game.i18n.format("MCC.UsageError", { name: item.name }));
  }
}

function extractItemSource(content, speaker = {}, element = null) {
  let card = element?.matches?.(".mausritter[data-actor-id]") ? element : element?.querySelector?.(".mausritter[data-actor-id]");
  if (!card && content && typeof document !== "undefined") {
    const template = document.createElement("template");
    template.innerHTML = content;
    card = template.content.querySelector(".mausritter[data-actor-id]");
  }
  if (!card) return null;
  return {
    actorId: card.dataset.actorId ?? speaker.actor ?? null,
    itemId: card.dataset.itemId ?? null,
    itemName: card.querySelector(".rollweaponh1")?.textContent?.trim() ?? null
  };
}

function resolveActor(actorId, speaker = {}) {
  if (speaker.scene && speaker.token) {
    const tokenActor = game.scenes.get(speaker.scene)?.tokens.get(speaker.token)?.actor;
    if (tokenActor) return tokenActor;
  }
  return game.actors.get(actorId ?? speaker.actor) ?? null;
}

function isLocalMessageAuthor(message, userId = null) {
  const authorId = userId?.id ?? userId ?? message.user?.id ?? message.user ?? message.author?.id;
  return authorId === game.user.id;
}

function injectUsageResult(message, element) {
  const usage = message.getFlag(MODULE_ID, "usage");
  if (!usage) return;
  const anchor = element.querySelector(".mausritter .rollcontainer");
  if (!anchor || anchor.querySelector(".mcc-usage-result")) return;

  const result = document.createElement("div");
  result.className = `mcc-usage-result${usage.exhausted || usage.current >= usage.maximum ? " is-exhausted" : ""}`;
  const key = usage.exhausted ? "MCC.UsageAlreadyExhausted" : usage.current >= usage.maximum ? "MCC.UsageExhausted" : "MCC.UsageSpent";
  result.innerHTML = `<i class="fas fa-circle-dot"></i> ${escapeHtml(game.i18n.format(key, usage))}`;
  anchor.append(result);
}

function registerBooleanSetting(key, defaultValue, config, name, hint, onChange = null) {
  game.settings.register(MODULE_ID, key, {
    name,
    hint,
    scope: "world",
    config,
    type: Boolean,
    default: defaultValue,
    onChange
  });
}

function injectDamageButton(message, element) {
  const damage = extractDamageFromMessage(message, element);
  if (!damage) return;

  const anchor = element.querySelector(".mausritter .rollcontainer");
  if (!anchor || anchor.querySelector(".mcc-apply-damage")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "mcc-apply-damage";
  button.innerHTML = `<i class="fas fa-droplet"></i> ${game.i18n.localize(message.getFlag(MODULE_ID, "applied") ? "MCC.Applied" : "MCC.ApplyDamage")}`;
  button.disabled = Boolean(message.getFlag(MODULE_ID, "applied"));
  button.addEventListener("click", event => {
    event.preventDefault();
    button.disabled = true;
    applyMessageDamage(message, damage);
  });
  anchor.append(button);
}

function extractDamageFromMessage(message, element) {
  if (message.getFlag(MODULE_ID, "damage")) return message.getFlag(MODULE_ID, "damage");

  const card = element.querySelector(".mausritter");
  if (!card) return null;

  const damageTitle = card.querySelector(".roll-damage")?.textContent?.trim().toLowerCase();
  const expectedTitle = game.i18n.localize("Maus.RollDamage").toLowerCase();
  if (!damageTitle || !damageTitle.includes(expectedTitle)) return null;

  const damage = Number.parseInt(card.querySelector(".roll-damagebox .value")?.textContent?.trim() ?? "", 10);
  if (!Number.isFinite(damage) || damage < 0) return null;

  return {
    value: damage,
    actorId: card.dataset.actorId ?? message.speaker?.actor ?? null,
    itemId: card.dataset.itemId ?? null
  };
}

async function applyMessageDamage(message, damageData) {
  const targets = Array.from(game.user.targets ?? []);
  if (!targets.length) {
    ui.notifications.warn(game.i18n.localize("MCC.NoTargets"));
    return;
  }

  const results = [];
  for (const token of targets) {
    const actor = token.actor;
    if (!actor) {
      ui.notifications.warn(game.i18n.localize("MCC.NoActor"));
      continue;
    }
    if (!ACTOR_TYPES.has(actor.type)) continue;
    if (!actor.canUserModify(game.user, "update")) {
      ui.notifications.warn(game.i18n.format("MCC.NoPermission", { name: actor.name }));
      continue;
    }
    results.push(await applyDamageToActor(actor, damageData.value));
  }

  if (!results.length) return;

  try {
    await message.setFlag(MODULE_ID, "applied", true);
    await message.setFlag(MODULE_ID, "damage", damageData);
  } catch (error) {
    console.warn(`${MODULE_ID} | Damage was applied, but the chat card could not be marked as applied.`, error);
  }

  await postDamageSummary(results, message.speaker);
}

async function applyDamageToActor(actor, rawDamage) {
  const armor = game.settings.get(MODULE_ID, "applyArmor") ? getArmorValue(actor) : 0;
  let remaining = Math.max(Number(rawDamage) - armor, 0);

  const updates = {};
  let absorbedByGrit = 0;
  if (game.settings.get(MODULE_ID, "useGrit")) {
    const grit = numberAt(actor, "system.grit.value");
    absorbedByGrit = Math.min(grit, remaining);
    remaining -= absorbedByGrit;
    updates["system.grit.value"] = grit - absorbedByGrit;
  }

  const hp = numberAt(actor, "system.health.value");
  const hpDamage = Math.min(hp, remaining);
  remaining -= hpDamage;
  updates["system.health.value"] = hp - hpDamage;

  const strengthPath = "system.stats.strength.value";
  const strength = numberAt(actor, strengthPath);
  const strengthDamage = Math.min(strength, remaining);
  if (strengthDamage > 0) updates[strengthPath] = strength - strengthDamage;

  if (Object.keys(updates).length) await actor.update(updates);

  const result = {
    actor,
    rawDamage,
    armor,
    applied: rawDamage - armor,
    absorbedByGrit,
    hpDamage,
    strengthDamage,
    critical: strengthDamage > 0
  };

  if (result.critical) await actor.setFlag(MODULE_ID, "pendingCritical", {
    created: Date.now(),
    strength: numberAt(actor, "system.stats.strength.value")
  });

  return result;
}

function getArmorValue(actor) {
  const actorArmor = numberAt(actor, "system.armor");
  const equippedArmor = actor.items
    .filter(item => item.type === "armor")
    .filter(item => item.system?.equipped)
    .reduce((total, item) => total + numberAt(item, "system.armor.value"), 0);
  return Math.max(equippedArmor, actorArmor, 0);
}

function numberAt(document, path) {
  const value = foundry.utils.getProperty(document, path);
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

async function postDamageSummary(results, speaker) {
  const lines = results.map(result => {
    const base = game.i18n.format("MCC.DamageApplied", {
      name: result.actor.name,
      damage: result.rawDamage,
      armor: result.armor,
      applied: Math.max(result.applied, 0)
    });
    const critical = result.critical && game.settings.get(MODULE_ID, "promptStrengthSave")
      ? `<br><strong>${game.i18n.format("MCC.CriticalPending", { name: escapeHtml(result.actor.name) })}</strong>`
      : "";
    return `<li>${base}${critical}</li>`;
  }).join("");

  await ChatMessage.create({
    user: game.user.id,
    speaker,
    content: `
      <div class="mausritter mcc-damage-summary">
        <div class="rollcontainer">
          <div class="rollh1">${game.i18n.localize("MCC.ApplyDamage")}</div>
          <ul>${lines}</ul>
        </div>
      </div>
    `
  });

  if (game.settings.get(MODULE_ID, "promptStrengthSave")) {
    for (const result of results.filter(r => r.critical)) {
      result.actor.rollStat?.(result.actor.system.stats.strength);
    }
  }
}

async function resolvePendingCriticalFromSave(message, element) {
  if (!game.settings.get(MODULE_ID, "autoCritical")) return;
  if (!isLocalMessageAuthor(message)) return;

  const actor = game.actors.get(message.speaker?.actor);
  if (!actor?.getFlag(MODULE_ID, "pendingCritical")) return;

  const save = extractStrengthSaveResult(element);
  if (!save) return;
  if (processedCriticalMessages.has(message.id)) return;
  processedCriticalMessages.add(message.id);

  try {
    await actor.unsetFlag(MODULE_ID, "pendingCritical");
    if (save.success) {
      await postCriticalResult(actor, true);
      return;
    }

    await ensureInjuredCondition(actor);
    await postCriticalResult(actor, false);
  } catch (error) {
    processedCriticalMessages.delete(message.id);
    throw error;
  }
}

function extractStrengthSaveResult(element) {
  const card = element.querySelector(".mausritter");
  if (!card || card.querySelector(".roll-damage")) return null;

  const title = card.querySelector(".rollh1")?.textContent?.trim().toLowerCase();
  const strengthNames = new Set([
    game.i18n.localize("Maus.Strength").toLowerCase(),
    game.i18n.localize("Maus.ActorStr").toLowerCase(),
    "strength",
    "str",
    "fue",
    "fuerza"
  ]);
  if (!strengthNames.has(title)) return null;

  const resultText = card.querySelector(".rollh2")?.textContent?.trim().toLowerCase() ?? "";
  const successText = game.i18n.localize("Maus.RollSuccess").toLowerCase();
  const failureText = game.i18n.localize("Maus.RollFailure").toLowerCase();
  if (resultText.includes(successText)) return { success: true };
  if (resultText.includes(failureText)) return { success: false };
  return null;
}

async function ensureInjuredCondition(actor) {
  const names = new Set(["injured", game.i18n.localize("MCC.Injured").toLowerCase()]);
  const existing = actor.items.find(item => item.type === "condition" && names.has(item.name.toLowerCase()));
  if (existing) return existing;

  const packItem = await getInjuredConditionFromPack();
  const data = packItem?.toObject?.() ?? {
    name: game.i18n.localize("MCC.Injured"),
    type: "condition",
    img: "icons/svg/blood.svg",
    system: {
      description: "",
      clear: game.i18n.localize("MCC.InjuredClear"),
      desc: game.i18n.localize("MCC.InjuredDesc"),
      pips: { value: 0, max: 0, html: "" },
      size: { width: 1, height: 1, x: "9em", y: "9em" },
      sheet: { active: false, currentX: 0, currentY: 0, initialX: 0, initialY: 0, xOffset: 0, yOffset: 0 }
    }
  };

  data.name = game.i18n.localize("MCC.Injured");
  const system = data.system ?? data.data ?? {};
  system.desc = game.i18n.localize("MCC.InjuredDesc");
  system.clear = game.i18n.localize("MCC.InjuredClear");
  if (data.system) data.system = system;
  else data.data = system;
  return actor.createEmbeddedDocuments("Item", [data]);
}

async function getInjuredConditionFromPack() {
  const pack = game.packs.get("mausritter.conditions");
  if (!pack) return null;
  const index = await pack.getIndex({ fields: ["name", "type"] });
  const entry = index.find(item => item.type === "condition" && item.name.toLowerCase() === "injured");
  return entry ? pack.getDocument(entry._id) : null;
}

async function postCriticalResult(actor, success) {
  const content = success
    ? game.i18n.format("MCC.CriticalSuccess", { name: actor.name })
    : `${game.i18n.format("MCC.CriticalFailure", { name: actor.name })}<br>${game.i18n.localize("MCC.ItemLossReminder")}`;

  await ChatMessage.create({
    user: game.user.id,
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="mausritter mcc-critical-result">
        <div class="rollcontainer">
          <div class="rollh1">${game.i18n.localize("MCC.StrSave")}</div>
          <p>${content}</p>
        </div>
      </div>
    `
  });
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}
