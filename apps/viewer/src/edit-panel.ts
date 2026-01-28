/**
 * Edit panel UI for building property editing.
 *
 * Creates and manages the edit form shown when a building is selected
 * in edit mode.
 */

import type { BuildingProperties } from "./types.ts";
import {
  getEditState,
  subscribeToEditState,
  updateField,
  getFieldValue,
  discardChanges,
  setSaving,
  saveComplete,
  saveFailed,
  getChangesToSave,
  setEditingBuilding,
} from "./edit-mode.ts";
import { updateBuilding, deleteOverride, getBuilding } from "./api-client.ts";

// Editable fields configuration
const EDITABLE_FIELDS: Array<{
  key: keyof BuildingProperties;
  label: string;
  type: "text" | "number";
  placeholder?: string;
}> = [
  { key: "name", label: "Name", type: "text", placeholder: "Building name" },
  { key: "height", label: "Height (m)", type: "number", placeholder: "e.g., 12.5" },
  { key: "building", label: "Type", type: "text", placeholder: "e.g., house, retail" },
  { key: "addr_housenumber", label: "House Number", type: "text", placeholder: "e.g., 42" },
  { key: "addr_street", label: "Street", type: "text", placeholder: "e.g., High Street" },
  { key: "addr_postcode", label: "Postcode", type: "text", placeholder: "e.g., NE24 1AB" },
  { key: "addr_city", label: "City", type: "text", placeholder: "e.g., Blyth" },
];

let panelElement: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * Create the edit panel DOM structure.
 */
function createEditPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.id = "edit-panel";
  panel.className = "hidden";
  panel.innerHTML = `
    <div class="edit-panel-header">
      <h3>Edit Building</h3>
      <button id="edit-close-btn" title="Close">&times;</button>
    </div>
    <div id="edit-error" class="edit-error hidden"></div>
    <form id="edit-form">
      <div id="edit-fields"></div>
      <div class="edit-note-field">
        <label for="edit-note">Edit Note (optional)</label>
        <textarea id="edit-note" placeholder="Describe your changes..."></textarea>
      </div>
      <div class="edit-actions">
        <button type="button" id="edit-discard-btn" class="btn-secondary">Discard</button>
        <button type="submit" id="edit-save-btn" class="btn-primary" disabled>Save</button>
      </div>
    </form>
    <div class="edit-override-actions">
      <button type="button" id="edit-revert-btn" class="btn-danger hidden">
        Revert to OSM Data
      </button>
    </div>
  `;

  return panel;
}

/**
 * Create an input field element.
 */
function createFieldElement(field: typeof EDITABLE_FIELDS[0]): HTMLElement {
  const div = document.createElement("div");
  div.className = "edit-field";
  div.innerHTML = `
    <label for="edit-${field.key}">${field.label}</label>
    <input
      type="${field.type}"
      id="edit-${field.key}"
      data-field="${field.key}"
      placeholder="${field.placeholder || ""}"
      ${field.type === "number" ? 'step="0.1" min="0"' : ""}
    />
  `;
  return div;
}

/**
 * Render the edit fields for the current building.
 */
function renderFields(): void {
  const fieldsContainer = document.getElementById("edit-fields");
  if (!fieldsContainer) return;

  fieldsContainer.innerHTML = "";

  for (const field of EDITABLE_FIELDS) {
    const fieldEl = createFieldElement(field);
    fieldsContainer.appendChild(fieldEl);

    // Set current value
    const input = fieldEl.querySelector("input") as HTMLInputElement;
    const value = getFieldValue(field.key);
    input.value = value !== null ? String(value) : "";

    // Add change listener
    input.addEventListener("input", () => {
      const newValue = field.type === "number" && input.value
        ? parseFloat(input.value)
        : input.value || null;
      updateField(field.key, newValue);
    });
  }
}

/**
 * Update the panel based on the current edit state.
 */
function updatePanel(): void {
  const state = getEditState();

  if (!panelElement) return;

  // Show/hide panel based on edit mode and selection
  const shouldShow = state.enabled && state.selectedOsmId !== null;
  panelElement.classList.toggle("hidden", !shouldShow);

  if (!shouldShow) return;

  // Update error message
  const errorEl = document.getElementById("edit-error");
  if (errorEl) {
    errorEl.textContent = state.lastError || "";
    errorEl.classList.toggle("hidden", !state.lastError);
  }

  // Update save button
  const saveBtn = document.getElementById("edit-save-btn") as HTMLButtonElement | null;
  if (saveBtn) {
    saveBtn.disabled = !state.isDirty || state.isSaving || !state.apiAvailable;
    saveBtn.textContent = state.isSaving ? "Saving..." : "Save";
  }

  // Update discard button
  const discardBtn = document.getElementById("edit-discard-btn") as HTMLButtonElement | null;
  if (discardBtn) {
    discardBtn.disabled = !state.isDirty || state.isSaving;
  }

  // Update revert button (only show if building has override)
  const revertBtn = document.getElementById("edit-revert-btn") as HTMLButtonElement | null;
  if (revertBtn) {
    // TODO: Check if building has override from API response
    // For now, always show it
    revertBtn.classList.toggle("hidden", !state.apiAvailable);
    revertBtn.disabled = state.isSaving;
  }

  // Update field values if not dirty (external update)
  if (!state.isDirty) {
    for (const field of EDITABLE_FIELDS) {
      const input = document.getElementById(`edit-${field.key}`) as HTMLInputElement | null;
      if (input) {
        const value = getFieldValue(field.key);
        input.value = value !== null ? String(value) : "";
      }
    }
  }
}

/**
 * Handle save button click.
 */
async function handleSave(event: Event): Promise<void> {
  event.preventDefault();

  const state = getEditState();
  if (!state.selectedOsmId || !state.apiAvailable) return;

  const changes = getChangesToSave();
  if (Object.keys(changes).length === 0) return;

  // Add edit note if provided
  const noteInput = document.getElementById("edit-note") as HTMLTextAreaElement | null;
  const editNote = noteInput?.value.trim();
  if (editNote) {
    (changes as Record<string, unknown>).edit_note = editNote;
  }

  setSaving(true);

  try {
    await updateBuilding(state.selectedOsmId, changes);

    // Fetch updated data
    const updated = await getBuilding(state.selectedOsmId);
    saveComplete(updated.properties as unknown as BuildingProperties);

    // Clear edit note
    if (noteInput) noteInput.value = "";

    // Show success message briefly
    const errorEl = document.getElementById("edit-error");
    if (errorEl) {
      errorEl.textContent = "Saved successfully!";
      errorEl.classList.remove("hidden");
      errorEl.style.color = "#4CAF50";
      setTimeout(() => {
        errorEl.classList.add("hidden");
        errorEl.style.color = "";
      }, 2000);
    }
  } catch (error) {
    saveFailed(error instanceof Error ? error.message : "Save failed");
  }
}

/**
 * Handle discard button click.
 */
function handleDiscard(): void {
  discardChanges();
  renderFields();
}

/**
 * Handle revert button click.
 */
async function handleRevert(): Promise<void> {
  const state = getEditState();
  if (!state.selectedOsmId) return;

  const confirmed = confirm(
    "This will remove all your edits and revert to the original OSM data. Continue?"
  );
  if (!confirmed) return;

  setSaving(true);

  try {
    await deleteOverride(state.selectedOsmId);

    // Fetch original data
    const updated = await getBuilding(state.selectedOsmId);
    saveComplete(updated.properties as unknown as BuildingProperties);
    renderFields();
  } catch (error) {
    saveFailed(error instanceof Error ? error.message : "Revert failed");
  }
}

/**
 * Initialize the edit panel.
 */
export function initEditPanel(): void {
  // Create panel element
  panelElement = createEditPanel();
  document.getElementById("ui")?.appendChild(panelElement);

  // Add event listeners
  document.getElementById("edit-close-btn")?.addEventListener("click", () => {
    setEditingBuilding(null, null);
  });

  document.getElementById("edit-form")?.addEventListener("submit", handleSave);
  document.getElementById("edit-discard-btn")?.addEventListener("click", handleDiscard);
  document.getElementById("edit-revert-btn")?.addEventListener("click", handleRevert);

  // Subscribe to state changes
  unsubscribe = subscribeToEditState(() => {
    updatePanel();
  });

  // Initial render
  renderFields();
  updatePanel();
}

/**
 * Clean up the edit panel.
 */
export function destroyEditPanel(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  if (panelElement) {
    panelElement.remove();
    panelElement = null;
  }
}

/**
 * Show the edit panel for a building.
 */
export function showEditPanel(osmId: number, properties: BuildingProperties): void {
  setEditingBuilding(osmId, properties);
  renderFields();
  updatePanel();
}

/**
 * Hide the edit panel.
 */
export function hideEditPanel(): void {
  setEditingBuilding(null, null);
  updatePanel();
}
