// @ts-check

/**
 * Dynamic UI Generator for Voice.Assembly.FM Parameter Controls
 * Generates parameter controls from schemas to eliminate repetitive HTML
 */

/**
 * Parameter type definitions for schema-driven generation
 */
export const PARAMETER_TYPES = {
  HRG: "hrg", // Harmonic Ratio Generator (frequency, vibratoRate)
  NORMALIZED: "normalized", // Normalized 0-1 parameters (vowelX, vowelY, etc.)
  CONSTANT: "constant", // Simple constant values (amplitude, whiteNoise)
};

/**
 * Parameter schema definitions
 */
export const PARAMETER_SCHEMAS = {
  frequency: {
    type: PARAMETER_TYPES.HRG,
    label: "freq",
    baseInput: {
      type: "number",
      value: "220",
      min: "16",
      max: "16384",
      step: "1",
      placeholder: "Hz",
    },
  },

  vibratoRate: {
    type: PARAMETER_TYPES.HRG,
    label: "vib rate",
    baseInput: {
      type: "number",
      value: "5",
      min: "0.1",
      max: "1000",
      step: "0.1",
      placeholder: "Hz",
    },
  },

  vowelX: {
    type: PARAMETER_TYPES.NORMALIZED,
    label: "vowel x",
    defaultValue: "0.5",
    placeholder: "0.5 or 0.2-0.8",
  },

  vowelY: {
    type: PARAMETER_TYPES.NORMALIZED,
    label: "vowel y",
    defaultValue: "0.5",
    placeholder: "0.5 or 0.2-0.8",
  },

  zingAmount: {
    type: PARAMETER_TYPES.NORMALIZED,
    label: "zing amt",
    defaultValue: "0",
    placeholder: "0 or 0-0.5",
  },

  zingMorph: {
    type: PARAMETER_TYPES.NORMALIZED,
    label: "z morph",
    defaultValue: "0.5",
    placeholder: "0.5 or 0.2-0.8",
  },

  symmetry: {
    type: PARAMETER_TYPES.NORMALIZED,
    label: "symmetry",
    defaultValue: "0.5",
    placeholder: "0.5 or 0.2-0.8",
  },

  amplitude: {
    type: PARAMETER_TYPES.NORMALIZED,
    label: "amp",
    defaultValue: "0.8",
    placeholder: "0.8 or 0.5-1",
  },

  whiteNoise: {
    type: PARAMETER_TYPES.NORMALIZED,
    label: "noise",
    defaultValue: "0",
    placeholder: "0 or 0-0.3",
  },

  vibratoWidth: {
    type: PARAMETER_TYPES.NORMALIZED,
    label: "vib width",
    defaultValue: "0",
    placeholder: "0 or 0-0.1",
  },
};

/**
 * Generate HRG behavior select options
 */
function createHrgBehaviorOptions() {
  return `
    <option value="static">stat</option>
    <option value="ascending">asc</option>
    <option value="descending">desc</option>
    <option value="random">rand</option>
    <option value="shuffle">shuf</option>
  `;
}

/**
 * Generate RBG behavior select options
 */
function createRbgBehaviorOptions() {
  return `
    <option value="static">stat</option>
    <option value="random">rand</option>
  `;
}

/**
 * Generate interpolation select options
 */
function createInterpolationOptions() {
  return `
    <option value="step">step</option>
    <option value="disc">disc</option>
    <option value="cont">cont</option>
  `;
}

/**
 * Generate HRG parameter control (frequency, vibratoRate)
 */
function generateHrgParameterControl(paramName, schema) {
  return `
    <div class="param-control compact-control">
      <div class="param-line">
        <span class="param-label">${schema.label}</span>
        <input
          type="${schema.baseInput.type}"
          class="text-input"
          id="${paramName}-base"
          value="${schema.baseInput.value}"
          min="${schema.baseInput.min}"
          max="${schema.baseInput.max}"
          step="${schema.baseInput.step}"
          placeholder="${schema.baseInput.placeholder}"
        >
        <select
          class="interp-select"
          id="${paramName}-interpolation"
        >
          ${createInterpolationOptions()}
        </select>
        <span
          class="hrg-fraction"
          id="${paramName}-start-hrg"
        >
          <input
            type="text"
            class="text-input"
            id="${paramName}-start-numerators"
            value="1"
            placeholder="1-6"
            autocomplete="off"
          >
          <select
            class="hrg-behavior"
            id="${paramName}-start-numerators-behavior"
          >
            ${createHrgBehaviorOptions()}
          </select>
          <span class="hrg-slash">/</span>
          <input
            type="text"
            class="text-input"
            id="${paramName}-start-denominators"
            value="1"
            placeholder="1"
            autocomplete="off"
          >
          <select
            class="hrg-behavior"
            id="${paramName}-start-denominators-behavior"
          >
            ${createHrgBehaviorOptions()}
          </select>
        </span>
        <span
          class="hrg-arrow"
          id="${paramName}-hrg-arrow"
          style="display: none"
        >→</span>
        <span
          class="hrg-fraction"
          id="${paramName}-end-hrg"
          style="display: none"
        >
          <input
            type="text"
            class="text-input"
            id="${paramName}-end-numerators"
            value="1"
            placeholder="1-6"
            autocomplete="off"
          >
          <select
            class="hrg-behavior"
            id="${paramName}-end-numerators-behavior"
          >
            ${createHrgBehaviorOptions()}
          </select>
          <span class="hrg-slash">/</span>
          <input
            type="text"
            class="text-input"
            id="${paramName}-end-denominators"
            value="1"
            placeholder="1"
            autocomplete="off"
          >
          <select
            class="hrg-behavior"
            id="${paramName}-end-denominators-behavior"
          >
            ${createHrgBehaviorOptions()}
          </select>
        </span>
      </div>
    </div>
  `;
}

/**
 * Generate normalized parameter control (vowelX, vowelY, etc.)
 */
function generateNormalizedParameterControl(paramName, schema) {
  return `
    <div class="param-control compact-control">
      <div class="param-line">
        <span class="param-label">${schema.label}</span>
        <input
          type="text"
          class="text-input"
          id="${paramName}-value"
          value="${schema.defaultValue}"
          placeholder="${schema.placeholder}"
        >
        <select
          class="hrg-behavior"
          id="${paramName}-start-rbg-behavior"
          title="Start RBG behavior"
          style="display: none"
        >
          ${createRbgBehaviorOptions()}
        </select>
        <select
          class="interp-select"
          id="${paramName}-interpolation"
        >
          ${createInterpolationOptions()}
        </select>
        <input
          type="text"
          class="end-value-input"
          id="${paramName}-end-value"
          value="${schema.defaultValue}"
          placeholder="${schema.placeholder}"
          title="End value"
        >
        <select
          class="hrg-behavior"
          id="${paramName}-end-rbg-behavior"
          title="End RBG behavior"
          style="display: none"
        >
          ${createRbgBehaviorOptions()}
        </select>
      </div>
    </div>
  `;
}

/**
 * Generate parameter control based on schema type
 */
export function generateParameterControl(paramName, schema) {
  switch (schema.type) {
    case PARAMETER_TYPES.HRG:
      return generateHrgParameterControl(paramName, schema);
    case PARAMETER_TYPES.NORMALIZED:
      return generateNormalizedParameterControl(paramName, schema);
    default:
      console.warn(`Unknown parameter type: ${schema.type} for ${paramName}`);
      return "";
  }
}

/**
 * Generate all parameter controls and inject into container
 */
export function generateAllParameterControls(
  containerId = "generated-parameters",
) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.error(`Container element with id '${containerId}' not found`);
    return;
  }

  let html = "";

  // Generate controls in a specific order
  const parameterOrder = [
    "frequency",
    "vibratoRate",
    "vowelX",
    "vowelY",
    "zingAmount",
    "zingMorph",
    "symmetry",
    "amplitude",
    "whiteNoise",
    "vibratoWidth",
  ];

  for (const paramName of parameterOrder) {
    const schema = PARAMETER_SCHEMAS[paramName];
    if (schema) {
      html += generateParameterControl(paramName, schema);
    }
  }

  container.innerHTML = html;
  console.log("✅ Generated all parameter controls dynamically");
}

/**
 * Replace specific parameter controls in existing HTML
 * This allows for gradual migration from static to dynamic controls
 */
export function replaceParameterControl(paramName) {
  const schema = PARAMETER_SCHEMAS[paramName];
  if (!schema) {
    console.warn(`No schema found for parameter: ${paramName}`);
    return false;
  }

  // Find existing parameter control
  const existingControl =
    document.querySelector(`[data-param="${paramName}"]`) ||
    document.querySelector(`#${paramName}-value, #${paramName}-base`)?.closest(
      ".param-control",
    );

  if (existingControl) {
    const newControlHtml = generateParameterControl(paramName, schema);
    existingControl.outerHTML = newControlHtml;
    console.log(`✅ Replaced parameter control for ${paramName}`);
    return true;
  } else {
    console.warn(`Could not find existing control for parameter: ${paramName}`);
    return false;
  }
}

/**
 * Initialize schema-driven parameter generation
 * This is the main entry point for dynamic UI generation
 */
export function initializeSchemaBasedUI() {
  console.log("🎛️ Initializing schema-based parameter UI generation...");

  // Check if we should use full generation or gradual replacement
  const generatedContainer = document.getElementById("generated-parameters");

  if (generatedContainer) {
    // Full schema-driven generation
    generateAllParameterControls();
  } else {
    // Gradual replacement of existing controls
    console.log("📝 Using gradual replacement mode for existing controls");
    Object.keys(PARAMETER_SCHEMAS).forEach((paramName) => {
      replaceParameterControl(paramName);
    });
  }
}
