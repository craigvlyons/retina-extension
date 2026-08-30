export const EXTENSION_DISTRIBUTION_FILE = "extension-distribution.json";
export const EXTENSION_DISTRIBUTION_CONTRACT_VERSION = 1;

export function createExtensionDistribution({ extensionId, extensionVersion }) {
  if (typeof extensionId !== "string" || !/^[a-p]{32}$/.test(extensionId)) {
    throw new Error("Extension distribution requires a valid fixed extension ID");
  }
  if (typeof extensionVersion !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(extensionVersion)) {
    throw new Error("Extension distribution requires a valid Chrome extension version");
  }

  return {
    contractVersion: EXTENSION_DISTRIBUTION_CONTRACT_VERSION,
    extensionId,
    extensionVersion,
    releaseStage: "preview",
    currentChannel: "manual_unpacked",
    artifactPathContract: "immutable_versioned_directory",
    silentInstallSupported: false,
    requiresUserInteraction: true,
    browsers: [
      {
        browser: "chrome",
        supported: true,
        setupUrl: "chrome://extensions/",
        loadAction: "load_unpacked"
      },
      {
        browser: "edge",
        supported: true,
        setupUrl: "edge://extensions/",
        loadAction: "load_unpacked"
      }
    ],
    channels: {
      manualUnpacked: {
        available: true,
        supported: true
      },
      chromeWebStore: {
        available: false,
        published: false,
        url: null
      },
      edgeAddons: {
        available: false,
        published: false,
        url: null
      },
      enterprisePolicy: {
        available: false,
        policyArtifact: null
      }
    },
    onboardingActions: [
      {
        order: 1,
        code: "open_extensions_page",
        browserSetupUrls: {
          chrome: "chrome://extensions/",
          edge: "edge://extensions/"
        }
      },
      {
        order: 2,
        code: "enable_developer_mode"
      },
      {
        order: 3,
        code: "load_unpacked"
      },
      {
        order: 4,
        code: "select_extension_artifact_directory",
        pathContract: "artifact_root"
      },
      {
        order: 5,
        code: "verify_extension_id",
        expectedExtensionId: extensionId
      }
    ],
    statusContract: {
      states: [
        "not_loaded",
        "loaded",
        "disabled",
        "version_mismatch",
        "artifact_missing"
      ],
      nextActions: {
        not_loaded: "load_unpacked",
        loaded: "none",
        disabled: "enable_extension",
        version_mismatch: "reload_extension",
        artifact_missing: "locate_extension_artifact"
      }
    }
  };
}

export function validateExtensionDistribution(distribution, {
  expectedExtensionId,
  expectedExtensionVersion
} = {}) {
  if (!distribution || typeof distribution !== "object" || Array.isArray(distribution)) {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} must contain a JSON object`);
  }
  if (distribution.contractVersion !== EXTENSION_DISTRIBUTION_CONTRACT_VERSION) {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} must use contractVersion 1`);
  }
  if (distribution.extensionId !== expectedExtensionId) {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} extensionId does not match manifest.json`);
  }
  if (distribution.extensionVersion !== expectedExtensionVersion) {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} extensionVersion does not match manifest.json`);
  }
  if (distribution.releaseStage !== "preview") {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} must honestly declare the current preview release stage`);
  }
  if (distribution.currentChannel !== "manual_unpacked") {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} currentChannel must be manual_unpacked`);
  }
  if (distribution.artifactPathContract !== "immutable_versioned_directory") {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} must use the immutable versioned directory contract`);
  }
  if (distribution.silentInstallSupported !== false || distribution.requiresUserInteraction !== true) {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} must declare interactive, non-silent loading`);
  }

  const expectedBrowsers = [
    ["chrome", "chrome://extensions/"],
    ["edge", "edge://extensions/"]
  ];
  if (!Array.isArray(distribution.browsers) || distribution.browsers.length !== expectedBrowsers.length) {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} must declare Chrome and Edge setup contracts`);
  }
  for (const [index, [browser, setupUrl]] of expectedBrowsers.entries()) {
    const entry = distribution.browsers[index];
    if (entry?.browser !== browser || entry?.supported !== true
      || entry?.setupUrl !== setupUrl || entry?.loadAction !== "load_unpacked") {
      throw new Error(`${EXTENSION_DISTRIBUTION_FILE} contains an invalid ${browser} setup contract`);
    }
  }

  const channels = distribution.channels;
  if (channels?.manualUnpacked?.available !== true || channels?.manualUnpacked?.supported !== true) {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} must make manual unpacked loading available`);
  }
  if (channels?.chromeWebStore?.available !== false
    || channels?.chromeWebStore?.published !== false
    || channels?.chromeWebStore?.url !== null
    || channels?.edgeAddons?.available !== false
    || channels?.edgeAddons?.published !== false
    || channels?.edgeAddons?.url !== null
    || channels?.enterprisePolicy?.available !== false
    || channels?.enterprisePolicy?.policyArtifact !== null) {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} must not claim unavailable store or policy assets`);
  }

  const expectedActionCodes = [
    "open_extensions_page",
    "enable_developer_mode",
    "load_unpacked",
    "select_extension_artifact_directory",
    "verify_extension_id"
  ];
  if (!Array.isArray(distribution.onboardingActions)
    || distribution.onboardingActions.length !== expectedActionCodes.length) {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} must contain the complete onboarding sequence`);
  }
  distribution.onboardingActions.forEach((action, index) => {
    if (action?.order !== index + 1 || action?.code !== expectedActionCodes[index]) {
      throw new Error(`${EXTENSION_DISTRIBUTION_FILE} onboarding actions must be complete and ordered`);
    }
  });
  if (distribution.onboardingActions[0]?.browserSetupUrls?.chrome !== "chrome://extensions/"
    || distribution.onboardingActions[0]?.browserSetupUrls?.edge !== "edge://extensions/"
    || distribution.onboardingActions[3]?.pathContract !== "artifact_root"
    || distribution.onboardingActions[4]?.expectedExtensionId !== expectedExtensionId) {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} onboarding action parameters are invalid`);
  }

  const expectedStates = [
    "not_loaded",
    "loaded",
    "disabled",
    "version_mismatch",
    "artifact_missing"
  ];
  const expectedNextActions = {
    not_loaded: "load_unpacked",
    loaded: "none",
    disabled: "enable_extension",
    version_mismatch: "reload_extension",
    artifact_missing: "locate_extension_artifact"
  };
  if (JSON.stringify(distribution.statusContract?.states) !== JSON.stringify(expectedStates)
    || JSON.stringify(distribution.statusContract?.nextActions) !== JSON.stringify(expectedNextActions)) {
    throw new Error(`${EXTENSION_DISTRIBUTION_FILE} status and next-action contract is invalid`);
  }

  return distribution;
}
