/**
 * Material Panel
 *
 * UI bindings for material property editing.
 * Features:
 * - Color picker
 * - Roughness/metalness sliders
 * - Texture controls
 */

import * as THREE from "three";

import { saveSnapshot } from "../editor-state.ts";

let materialPanelElement: HTMLElement | null = null;
let currentMaterial: THREE.MeshStandardMaterial | null = null;

/**
 * Create the material panel UI.
 */
export function createMaterialPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.id = "material-panel";
  panel.className = "material-panel";
  panel.innerHTML = `
    <div class="material-panel-header">
      <h4>Material</h4>
      <button id="material-panel-toggle" class="panel-toggle">▼</button>
    </div>
    <div class="material-panel-content">
      <div class="material-field">
        <label for="mat-color">Color</label>
        <input type="color" id="mat-color" value="#8b7355" />
      </div>
      <div class="material-field">
        <label for="mat-roughness">Roughness</label>
        <input type="range" id="mat-roughness" min="0" max="1" step="0.01" value="0.8" />
        <span id="mat-roughness-value">0.8</span>
      </div>
      <div class="material-field">
        <label for="mat-metalness">Metalness</label>
        <input type="range" id="mat-metalness" min="0" max="1" step="0.01" value="0.1" />
        <span id="mat-metalness-value">0.1</span>
      </div>
      <div class="material-field">
        <label for="mat-opacity">Opacity</label>
        <input type="range" id="mat-opacity" min="0" max="1" step="0.01" value="1" />
        <span id="mat-opacity-value">1.0</span>
      </div>
      <div class="material-field material-checkbox">
        <input type="checkbox" id="mat-wireframe" />
        <label for="mat-wireframe">Wireframe</label>
      </div>
      <div class="material-field material-checkbox">
        <input type="checkbox" id="mat-double-sided" checked />
        <label for="mat-double-sided">Double Sided</label>
      </div>
      <div class="material-divider"></div>
      <div class="material-field">
        <label>Texture</label>
        <div id="texture-dropzone" class="texture-dropzone">
          <span>Drop image here</span>
        </div>
        <button id="clear-texture-btn" class="btn-small btn-secondary hidden">
          Clear Texture
        </button>
      </div>
      <div class="material-field" id="texture-tiling-container" style="display: none;">
        <label for="mat-tile-x">Tile U</label>
        <input type="number" id="mat-tile-x" min="0.1" step="0.1" value="1" />
        <label for="mat-tile-y">Tile V</label>
        <input type="number" id="mat-tile-y" min="0.1" step="0.1" value="1" />
      </div>
    </div>
  `;

  return panel;
}

/**
 * Initialize the material panel.
 */
export function initMaterialPanel(container: HTMLElement): void {
  materialPanelElement = createMaterialPanel();
  container.appendChild(materialPanelElement);

  // Set up event listeners
  setupColorPicker();
  setupSliders();
  setupCheckboxes();
  setupTextureDropzone();
  setupPanelToggle();
}

/**
 * Set the material to edit.
 */
export function setEditingMaterial(material: THREE.MeshStandardMaterial): void {
  currentMaterial = material;
  updatePanelFromMaterial();
}

/**
 * Update panel controls to reflect current material.
 */
function updatePanelFromMaterial(): void {
  if (!currentMaterial || !materialPanelElement) return;

  // Color
  const colorInput = materialPanelElement.querySelector("#mat-color") as HTMLInputElement;
  if (colorInput) {
    colorInput.value = "#" + currentMaterial.color.getHexString();
  }

  // Roughness
  const roughnessInput = materialPanelElement.querySelector("#mat-roughness") as HTMLInputElement;
  const roughnessValue = materialPanelElement.querySelector("#mat-roughness-value");
  if (roughnessInput && roughnessValue) {
    roughnessInput.value = String(currentMaterial.roughness);
    roughnessValue.textContent = currentMaterial.roughness.toFixed(2);
  }

  // Metalness
  const metalnessInput = materialPanelElement.querySelector("#mat-metalness") as HTMLInputElement;
  const metalnessValue = materialPanelElement.querySelector("#mat-metalness-value");
  if (metalnessInput && metalnessValue) {
    metalnessInput.value = String(currentMaterial.metalness);
    metalnessValue.textContent = currentMaterial.metalness.toFixed(2);
  }

  // Opacity
  const opacityInput = materialPanelElement.querySelector("#mat-opacity") as HTMLInputElement;
  const opacityValue = materialPanelElement.querySelector("#mat-opacity-value");
  if (opacityInput && opacityValue) {
    opacityInput.value = String(currentMaterial.opacity);
    opacityValue.textContent = currentMaterial.opacity.toFixed(2);
  }

  // Wireframe
  const wireframeInput = materialPanelElement.querySelector("#mat-wireframe") as HTMLInputElement;
  if (wireframeInput) {
    wireframeInput.checked = currentMaterial.wireframe;
  }

  // Double sided
  const doubleSidedInput = materialPanelElement.querySelector("#mat-double-sided") as HTMLInputElement;
  if (doubleSidedInput) {
    doubleSidedInput.checked = currentMaterial.side === THREE.DoubleSide;
  }

  // Texture tiling
  const tilingContainer = materialPanelElement.querySelector("#texture-tiling-container") as HTMLElement;
  const clearBtn = materialPanelElement.querySelector("#clear-texture-btn") as HTMLElement;
  if (tilingContainer && clearBtn) {
    const hasTexture = currentMaterial.map !== null;
    tilingContainer.style.display = hasTexture ? "block" : "none";
    clearBtn.classList.toggle("hidden", !hasTexture);

    if (hasTexture && currentMaterial.map) {
      const tileXInput = materialPanelElement.querySelector("#mat-tile-x") as HTMLInputElement;
      const tileYInput = materialPanelElement.querySelector("#mat-tile-y") as HTMLInputElement;
      if (tileXInput && tileYInput) {
        tileXInput.value = String(currentMaterial.map.repeat.x);
        tileYInput.value = String(currentMaterial.map.repeat.y);
      }
    }
  }
}

/**
 * Set up color picker.
 */
function setupColorPicker(): void {
  const colorInput = materialPanelElement?.querySelector("#mat-color") as HTMLInputElement;
  if (!colorInput) return;

  colorInput.addEventListener("input", () => {
    if (!currentMaterial) return;
    currentMaterial.color.set(colorInput.value);
    currentMaterial.needsUpdate = true;
  });

  colorInput.addEventListener("change", () => {
    // Save snapshot on color change complete
    saveSnapshot();
  });
}

/**
 * Set up slider controls.
 */
function setupSliders(): void {
  // Roughness
  const roughnessInput = materialPanelElement?.querySelector("#mat-roughness") as HTMLInputElement;
  const roughnessValue = materialPanelElement?.querySelector("#mat-roughness-value");
  if (roughnessInput && roughnessValue) {
    roughnessInput.addEventListener("input", () => {
      if (!currentMaterial) return;
      const value = parseFloat(roughnessInput.value);
      currentMaterial.roughness = value;
      roughnessValue.textContent = value.toFixed(2);
    });

    roughnessInput.addEventListener("change", () => {
      saveSnapshot();
    });
  }

  // Metalness
  const metalnessInput = materialPanelElement?.querySelector("#mat-metalness") as HTMLInputElement;
  const metalnessValue = materialPanelElement?.querySelector("#mat-metalness-value");
  if (metalnessInput && metalnessValue) {
    metalnessInput.addEventListener("input", () => {
      if (!currentMaterial) return;
      const value = parseFloat(metalnessInput.value);
      currentMaterial.metalness = value;
      metalnessValue.textContent = value.toFixed(2);
    });

    metalnessInput.addEventListener("change", () => {
      saveSnapshot();
    });
  }

  // Opacity
  const opacityInput = materialPanelElement?.querySelector("#mat-opacity") as HTMLInputElement;
  const opacityValue = materialPanelElement?.querySelector("#mat-opacity-value");
  if (opacityInput && opacityValue) {
    opacityInput.addEventListener("input", () => {
      if (!currentMaterial) return;
      const value = parseFloat(opacityInput.value);
      currentMaterial.opacity = value;
      currentMaterial.transparent = value < 1;
      opacityValue.textContent = value.toFixed(2);
    });

    opacityInput.addEventListener("change", () => {
      saveSnapshot();
    });
  }

  // Texture tiling
  const tileXInput = materialPanelElement?.querySelector("#mat-tile-x") as HTMLInputElement;
  const tileYInput = materialPanelElement?.querySelector("#mat-tile-y") as HTMLInputElement;
  if (tileXInput && tileYInput) {
    const updateTiling = () => {
      if (!currentMaterial?.map) return;
      currentMaterial.map.repeat.set(
        parseFloat(tileXInput.value) || 1,
        parseFloat(tileYInput.value) || 1
      );
      currentMaterial.map.needsUpdate = true;
    };

    tileXInput.addEventListener("input", updateTiling);
    tileYInput.addEventListener("input", updateTiling);
  }
}

/**
 * Set up checkbox controls.
 */
function setupCheckboxes(): void {
  // Wireframe
  const wireframeInput = materialPanelElement?.querySelector("#mat-wireframe") as HTMLInputElement;
  if (wireframeInput) {
    wireframeInput.addEventListener("change", () => {
      if (!currentMaterial) return;
      currentMaterial.wireframe = wireframeInput.checked;
    });
  }

  // Double sided
  const doubleSidedInput = materialPanelElement?.querySelector("#mat-double-sided") as HTMLInputElement;
  if (doubleSidedInput) {
    doubleSidedInput.addEventListener("change", () => {
      if (!currentMaterial) return;
      currentMaterial.side = doubleSidedInput.checked
        ? THREE.DoubleSide
        : THREE.FrontSide;
      currentMaterial.needsUpdate = true;
    });
  }
}

/**
 * Set up texture dropzone.
 */
function setupTextureDropzone(): void {
  const dropzone = materialPanelElement?.querySelector("#texture-dropzone") as HTMLElement;
  const clearBtn = materialPanelElement?.querySelector("#clear-texture-btn") as HTMLElement;

  if (!dropzone) return;

  // Drag events
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    loadTextureFromFile(file);
  });

  // Click to browse
  dropzone.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
      if (input.files && input.files.length > 0) {
        loadTextureFromFile(input.files[0]);
      }
    });
    input.click();
  });

  // Clear texture button
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearTexture();
    });
  }
}

/**
 * Load a texture from a file.
 */
function loadTextureFromFile(file: File): void {
  if (!currentMaterial) return;

  // Validate file type
  if (!file.type.startsWith("image/")) {
    console.error("Invalid file type. Please use an image file.");
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target?.result as string;
    if (!dataUrl) return;

    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
      dataUrl,
      (texture) => {
        // Set texture properties
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(1, 1);

        // Apply to material
        if (currentMaterial) {
          if (currentMaterial.map) {
            currentMaterial.map.dispose();
          }
          currentMaterial.map = texture;
          currentMaterial.needsUpdate = true;

          // Update panel
          updatePanelFromMaterial();
        }

        console.log("Texture loaded:", file.name);
      },
      undefined,
      (error) => {
        console.error("Error loading texture:", error);
      }
    );
  };
  reader.readAsDataURL(file);
}

/**
 * Clear the current texture.
 */
function clearTexture(): void {
  if (!currentMaterial) return;

  if (currentMaterial.map) {
    currentMaterial.map.dispose();
    currentMaterial.map = null;
    currentMaterial.needsUpdate = true;

    // Update panel
    updatePanelFromMaterial();
  }
}

/**
 * Set up panel collapse toggle.
 */
function setupPanelToggle(): void {
  const toggleBtn = materialPanelElement?.querySelector("#material-panel-toggle") as HTMLElement;
  const content = materialPanelElement?.querySelector(".material-panel-content") as HTMLElement;

  if (!toggleBtn || !content) return;

  toggleBtn.addEventListener("click", () => {
    const isCollapsed = content.classList.toggle("collapsed");
    toggleBtn.textContent = isCollapsed ? "▶" : "▼";
  });
}

/**
 * Get the current material being edited.
 */
export function getCurrentMaterial(): THREE.MeshStandardMaterial | null {
  return currentMaterial;
}

/**
 * Dispose of the material panel.
 */
export function disposeMaterialPanel(): void {
  if (materialPanelElement) {
    materialPanelElement.remove();
    materialPanelElement = null;
  }
  currentMaterial = null;
}
