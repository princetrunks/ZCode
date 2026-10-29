// Sando build switch `phonehome` (RD-2828, 2026-10-29). Runtime side: packages/shared/src/phonehome.ts.
// SANDO_PHONEHOME=upstream at build time reproduces upstream behaviour; anything else (or unset) is "none".

const VENDOR_HOST_SUFFIXES = ["z.ai", "bigmodel.cn"];

/** @param {Record<string, string | undefined>} [env] */
export function resolveSandoPhonehome(env = process.env) {
  return env.SANDO_PHONEHOME?.trim().toLowerCase() === "upstream" ? "upstream" : "none";
}

/** Bundler define so the gated branches are compiled out. @param {Record<string, string | undefined>} [env] */
export function sandoPhonehomeDefine(env = process.env) {
  return { __SANDO_PHONEHOME__: JSON.stringify(resolveSandoPhonehome(env)) };
}

function isVendorUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return VENDOR_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function isVendorRule(rule) {
  const config = rule?.config ?? {};
  return (
    String(config.access?.type ?? "").startsWith("zhipu-") ||
    isVendorUrl(config.api?.baseUrl) ||
    isVendorUrl(config.access?.apiKeyManagementUrl)
  );
}

/**
 * Local Built-in catalogue for phonehome=none: drops the Z.ai / BigModel account providers
 * (OAuth login, coding/start/idle plans) and Z.ai / BigModel templates, plus the model rules
 * that point at them. Every other template stays (they need a user-entered key to do anything).
 * @param {string} content Built-in release JSON text
 * @returns {string}
 */
export function stripVendorBuiltinProviders(content) {
  const release = JSON.parse(content);
  const rules = release.config?.providerConfigRules;
  const models = release.config?.modelConfigRules;
  if (!rules) return content;
  const droppedTemplates = new Set();
  const droppedProviders = new Set();
  rules.templateRules = (rules.templateRules ?? []).filter((rule) => {
    if (!isVendorRule(rule)) return true;
    droppedTemplates.add(rule.templateId);
    return false;
  });
  rules.providerRules = (rules.providerRules ?? []).filter((rule) => {
    if (!isVendorRule(rule)) return true;
    droppedProviders.add(rule.providerId);
    return false;
  });
  if (models) {
    models.templateModelRules = (models.templateModelRules ?? []).filter(
      (rule) => !droppedTemplates.has(rule.templateId),
    );
    models.builtinProviderModelRules = (models.builtinProviderModelRules ?? []).filter(
      (rule) => !droppedProviders.has(rule.providerId),
    );
  }
  return `${JSON.stringify(release, null, 2)}\n`;
}
