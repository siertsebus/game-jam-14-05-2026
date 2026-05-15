import { AntSimulation } from "./sim/AntSimulation.js";
import { SIM_CONFIG } from "./config.js";

const SETTINGS_CACHE_KEY = "lazy-queen-settings-v2";

const canvas = document.querySelector("#game-canvas");
const statusElement = document.querySelector("#status");
const timeScaleInput = document.querySelector("#target-time-scale");
const timeScaleValue = document.querySelector("#time-scale-value");
const resetButton = document.querySelector("#reset-button");
const startOverButton = document.querySelector("#start-over-button");
const copySettingsButton = document.querySelector("#copy-settings-button");
const defaultSettingsButton = document.querySelector("#default-settings-button");
const defaultRenderLayersButton = document.querySelector("#default-render-layers-button");
const editorButton = document.querySelector("#editor-button");
const editorPanel = document.querySelector("#editor-panel");
const tuningPanel = document.querySelector("#tuning-panel");
const brushSizeInput = document.querySelector("#brush-size");
const clearSprayButton = document.querySelector("#clear-spray-button");
const clearFoodButton = document.querySelector("#clear-food-button");
const downloadMapButton = document.querySelector("#download-map-button");
const paintTargetButtons = document.querySelectorAll("[data-paint-target]");
const renderIntensityInputs = document.querySelectorAll("[data-render-intensity]");
const renderSoloButtons = document.querySelectorAll("[data-render-solo]");
const topicTabs = document.querySelectorAll("[data-topic-tab]");
const topicPanels = document.querySelectorAll("[data-topic-panel]");
const configInputs = document.querySelectorAll("[data-config-key]");

const CONFIG_SLIDER_CURVES = {
  trailDeposit: 2,
  trailAttractionStrength: 2,
  trailDiffusion: 2,
  trailDecay: 2,
  crowdDeposit: 2,
  crowdAvoidStrength: 2,
  crowdDiffusion: 2,
  crowdDecay: 2,
  deathDeposit: 2,
  deathAvoidStrength: 2,
  deathDiffusion: 2,
  deathDecay: 2,
  homePullStrength: 2,
  foodTrailDeposit: 2,
  foodTrailDecay: 2,
  foodTrailDiffusion: 2,
  clearOtherTrails: 2,
  foodTrailCarryFalloff: 2,
  foodTrailMinCarryDepositRatio: 2,
  foodTrailFollowStrength: 2,
};

function loadCachedSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_CACHE_KEY)) ?? {};
  } catch (error) {
    console.warn("Could not restore cached settings.", error);
    return {};
  }
}

function saveSettings() {
  const config = {};
  const render = {};
  const activePaintTarget = [...paintTargetButtons].find(
    (button) => button.getAttribute("aria-pressed") === "true",
  );

  for (const input of configInputs) {
    config[input.dataset.configKey] = getConfigInputValue(input);
  }

  for (const input of renderIntensityInputs) {
    render[input.dataset.renderIntensity] = Number(input.value);
  }

  try {
    localStorage.setItem(
      SETTINGS_CACHE_KEY,
      JSON.stringify({
        brushSize: Number(brushSizeInput.value),
        paintTarget: activePaintTarget?.dataset.paintTarget ?? "poison",
        targetTimeScale: Number(timeScaleInput.value),
        config,
        render,
      }),
    );
  } catch (error) {
    console.warn("Could not cache settings.", error);
  }
}

function setPaintTargetButtons(target) {
  for (const button of paintTargetButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.paintTarget === target));
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getConfigSliderCurve(input) {
  return CONFIG_SLIDER_CURVES[input.dataset.configKey] ?? 1;
}

function getConfigInputValue(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const rawValue = Number(input.value);
  const curve = getConfigSliderCurve(input);

  if (curve === 1 || !Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return rawValue;
  }

  const normalized = clamp((rawValue - min) / (max - min), 0, 1);
  return Number((min + (max - min) * normalized ** curve).toFixed(6));
}

function getSliderValueForConfig(input, configValue) {
  const min = Number(input.min);
  const max = Number(input.max);
  const curve = getConfigSliderCurve(input);

  if (curve === 1 || !Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return configValue;
  }

  const normalized = clamp((configValue - min) / (max - min), 0, 1);
  return min + (max - min) * normalized ** (1 / curve);
}

function setupConfigSliderDefaults() {
  for (const input of configInputs) {
    const defaultValue = SIM_CONFIG[input.dataset.configKey];

    if (!Number.isFinite(defaultValue)) {
      continue;
    }

    input.value = String(getSliderValueForConfig(input, defaultValue));
    input.defaultValue = input.value;
  }
}

function formatConfigValue(input) {
  const value = getConfigInputValue(input);

  if (!Number.isFinite(value)) {
    return input.value;
  }

  const decimalPlaces = input.step.includes(".") ? input.step.split(".")[1].length : 0;
  return value.toFixed(decimalPlaces).replace(/\.?0+$/, "");
}

function updateConfigValueDisplay(input) {
  const valueElement = input.closest("label")?.querySelector(".setting-value");

  if (valueElement) {
    valueElement.textContent = formatConfigValue(input);
  }
}

function setupConfigValueDisplays() {
  for (const input of configInputs) {
    const heading = input.closest("label")?.querySelector(".setting-heading");

    if (!heading || heading.querySelector(".setting-value")) {
      updateConfigValueDisplay(input);
      continue;
    }

    const titleNode = [...heading.childNodes].find(
      (node) => node.nodeType === 3 && node.textContent.trim(),
    );

    if (!titleNode) {
      continue;
    }

    const title = document.createElement("span");
    const value = document.createElement("span");
    title.className = "setting-title";
    value.className = "setting-value";
    title.textContent = titleNode.textContent.trim();
    title.append(" ", value);
    heading.insertBefore(title, titleNode);
    titleNode.remove();

    updateConfigValueDisplay(input);
  }
}

function formatTimeScale(value) {
  return `${Number(value).toFixed(2).replace(/\.?0+$/, "")}x`;
}

function updateTimeScaleDisplay() {
  timeScaleValue.textContent = formatTimeScale(timeScaleInput.value);
}

function setRenderIntensityInput(simulation, input, value) {
  input.value = String(value);
  simulation.setRenderIntensity(input.dataset.renderIntensity, Number(input.value));
}

function restoreDefaultRenderLayers(simulation) {
  for (const input of renderIntensityInputs) {
    setRenderIntensityInput(simulation, input, input.defaultValue);
  }

  saveSettings();
}

function soloRenderLayer(simulation, key) {
  for (const input of renderIntensityInputs) {
    const value = input.dataset.renderIntensity === key ? input.defaultValue : "0";
    setRenderIntensityInput(simulation, input, value);
  }

  saveSettings();
}

function createConfigSource() {
  const values = { ...SIM_CONFIG };

  for (const input of configInputs) {
    values[input.dataset.configKey] = getConfigInputValue(input);
  }

  const lines = Object.entries(values).map(([key, value]) => `  ${key}: ${value},`);
  return `export const SIM_CONFIG = {\n${lines.join("\n")}\n};\n`;
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();
  document.execCommand("copy");
  textArea.remove();
}

async function copyCurrentSettings() {
  const originalText = copySettingsButton.textContent;

  try {
    await copyTextToClipboard(createConfigSource());
    copySettingsButton.textContent = "Copied";
  } catch (error) {
    console.warn("Could not copy settings.", error);
    copySettingsButton.textContent = "Copy failed";
  } finally {
    window.setTimeout(() => {
      copySettingsButton.textContent = originalText;
    }, 1400);
  }
}

async function downloadCurrentMap(simulation) {
  const blob = await simulation.createLevelPngBlob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "DefaultMap.png";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function applySettings(simulation, settings) {
  if (Number.isFinite(settings.brushSize)) {
    brushSizeInput.value = String(settings.brushSize);
    simulation.setBrushSize(settings.brushSize);
  }

  if (Number.isFinite(settings.targetTimeScale)) {
    timeScaleInput.value = String(settings.targetTimeScale);
    simulation.setTargetTimeScale(settings.targetTimeScale);
    updateTimeScaleDisplay();
  }

  const paintTarget = simulation.setEditorPaintTarget(settings.paintTarget ?? "poison");
  setPaintTargetButtons(paintTarget);

  for (const input of configInputs) {
    const value = settings.config?.[input.dataset.configKey];
    if (!Number.isFinite(value)) {
      continue;
    }

    input.value = String(getSliderValueForConfig(input, value));
    simulation.setConfigValue(input.dataset.configKey, getConfigInputValue(input));
    updateConfigValueDisplay(input);
  }

  for (const input of renderIntensityInputs) {
    const value = settings.render?.[input.dataset.renderIntensity];
    if (!Number.isFinite(value)) {
      continue;
    }

    setRenderIntensityInput(simulation, input, value);
  }
}

function restoreDefaultSettings(simulation) {
  timeScaleInput.value = timeScaleInput.defaultValue;
  simulation.setTargetTimeScale(Number(timeScaleInput.value));
  updateTimeScaleDisplay();

  brushSizeInput.value = brushSizeInput.defaultValue;
  simulation.setBrushSize(Number(brushSizeInput.value));

  const paintTarget = simulation.setEditorPaintTarget("poison");
  setPaintTargetButtons(paintTarget);

  for (const input of configInputs) {
    input.value = input.defaultValue;
    simulation.setConfigValue(input.dataset.configKey, getConfigInputValue(input));
    updateConfigValueDisplay(input);
  }

  restoreDefaultRenderLayers(simulation);

  saveSettings();
}

async function boot() {
  setupConfigSliderDefaults();
  setupConfigValueDisplays();
  updateTimeScaleDisplay();

  const simulation = new AntSimulation(canvas, statusElement);
  resetButton.addEventListener("click", () => simulation.reset());
  startOverButton.addEventListener("click", () => {
    restoreDefaultSettings(simulation);
    simulation.reset();
  });
  copySettingsButton.addEventListener("click", copyCurrentSettings);
  defaultSettingsButton.addEventListener("click", () => restoreDefaultSettings(simulation));
  defaultRenderLayersButton.addEventListener("click", () => restoreDefaultRenderLayers(simulation));
  editorButton.addEventListener("click", () => {
    const isEditing = simulation.setEditorEnabled(!simulation.editorEnabled);
    editorButton.setAttribute("aria-pressed", String(isEditing));
    editorButton.textContent = isEditing ? "Resume simulation" : "Level editor";
    editorPanel.hidden = !isEditing;
    tuningPanel.hidden = isEditing;
  });
  brushSizeInput.addEventListener("input", () => {
    simulation.setBrushSize(Number(brushSizeInput.value));
    saveSettings();
  });
  timeScaleInput.addEventListener("input", () => {
    simulation.setTargetTimeScale(Number(timeScaleInput.value));
    updateTimeScaleDisplay();
    saveSettings();
  });
  clearSprayButton.addEventListener("click", () => simulation.clearDeathSpray());
  clearFoodButton.addEventListener("click", () => simulation.clearFood());
  downloadMapButton.addEventListener("click", async () => {
    const originalText = downloadMapButton.textContent;

    try {
      downloadMapButton.disabled = true;
      downloadMapButton.textContent = "Downloading";
      await downloadCurrentMap(simulation);
      downloadMapButton.textContent = "Downloaded";
    } catch (error) {
      console.warn("Could not download map.", error);
      downloadMapButton.textContent = "Download failed";
    } finally {
      window.setTimeout(() => {
        downloadMapButton.disabled = false;
        downloadMapButton.textContent = originalText;
      }, 1400);
    }
  });
  for (const button of paintTargetButtons) {
    button.addEventListener("click", () => {
      const target = simulation.setEditorPaintTarget(button.dataset.paintTarget);
      setPaintTargetButtons(target);
      saveSettings();
    });
  }
  for (const input of renderIntensityInputs) {
    input.addEventListener("input", () => {
      simulation.setRenderIntensity(input.dataset.renderIntensity, Number(input.value));
      saveSettings();
    });
  }
  for (const button of renderSoloButtons) {
    button.addEventListener("click", () => soloRenderLayer(simulation, button.dataset.renderSolo));
  }
  for (const tab of topicTabs) {
    tab.addEventListener("click", () => {
      const topic = tab.dataset.topicTab;

      for (const currentTab of topicTabs) {
        currentTab.setAttribute("aria-selected", String(currentTab === tab));
      }

      for (const panel of topicPanels) {
        panel.hidden = panel.dataset.topicPanel !== topic;
      }
    });
  }
  for (const input of configInputs) {
    input.addEventListener("input", () => {
      simulation.setConfigValue(input.dataset.configKey, getConfigInputValue(input));
      updateConfigValueDisplay(input);
      saveSettings();
    });
  }

  try {
    applySettings(simulation, loadCachedSettings());
    await simulation.init();
  } catch (error) {
    console.error(error);
    statusElement.textContent =
      "WebGPU could not start. Try a current Chrome or Edge build with hardware acceleration enabled.";
    resetButton.disabled = true;
    startOverButton.disabled = true;
    copySettingsButton.disabled = true;
    defaultSettingsButton.disabled = true;
    defaultRenderLayersButton.disabled = true;
    editorButton.disabled = true;
    clearSprayButton.disabled = true;
    clearFoodButton.disabled = true;
    downloadMapButton.disabled = true;
    for (const button of paintTargetButtons) {
      button.disabled = true;
    }
    for (const input of renderIntensityInputs) {
      input.disabled = true;
    }
    for (const button of renderSoloButtons) {
      button.disabled = true;
    }
  }
}

boot();
