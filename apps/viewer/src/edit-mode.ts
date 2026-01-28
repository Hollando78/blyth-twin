/**
 * Edit mode state management for the Blyth Digital Twin viewer.
 *
 * Handles toggling edit mode, tracking unsaved changes, and coordinating
 * between the edit panel and the main viewer.
 */

import type { BuildingProperties } from "./types.ts";
import { checkApiHealth } from "./api-client.ts";

export interface EditModeState {
  enabled: boolean;
  apiAvailable: boolean;
  selectedOsmId: number | null;
  originalData: BuildingProperties | null;
  pendingChanges: Partial<BuildingProperties>;
  isDirty: boolean;
  isSaving: boolean;
  lastError: string | null;
}

// Global edit mode state
let editState: EditModeState = {
  enabled: false,
  apiAvailable: false,
  selectedOsmId: null,
  originalData: null,
  pendingChanges: {},
  isDirty: false,
  isSaving: false,
  lastError: null,
};

// Listeners for state changes
const listeners: Set<(state: EditModeState) => void> = new Set();

/**
 * Get the current edit mode state.
 */
export function getEditState(): EditModeState {
  return { ...editState };
}

/**
 * Subscribe to edit state changes.
 */
export function subscribeToEditState(callback: (state: EditModeState) => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Update the edit state and notify listeners.
 */
function updateEditState(updates: Partial<EditModeState>): void {
  editState = { ...editState, ...updates };
  listeners.forEach((cb) => cb(editState));
}

/**
 * Toggle edit mode on/off.
 */
export async function toggleEditMode(): Promise<void> {
  if (editState.enabled) {
    // Turning off - check for unsaved changes
    if (editState.isDirty) {
      const confirmed = confirm("You have unsaved changes. Discard them?");
      if (!confirmed) return;
    }
    updateEditState({
      enabled: false,
      pendingChanges: {},
      isDirty: false,
      lastError: null,
    });
  } else {
    // Turning on - check API availability
    const apiAvailable = await checkApiHealth();
    updateEditState({
      enabled: true,
      apiAvailable,
      lastError: apiAvailable ? null : "API not available. Edits will not be saved.",
    });
  }
}

/**
 * Set the building being edited.
 */
export function setEditingBuilding(osmId: number | null, properties: BuildingProperties | null): void {
  if (editState.isDirty && editState.selectedOsmId !== osmId) {
    const confirmed = confirm("You have unsaved changes. Discard them?");
    if (!confirmed) return;
  }

  updateEditState({
    selectedOsmId: osmId,
    originalData: properties,
    pendingChanges: {},
    isDirty: false,
    lastError: null,
  });
}

/**
 * Update a field value (stages the change, doesn't save).
 */
export function updateField(field: keyof BuildingProperties, value: string | number | null): void {
  const newChanges = { ...editState.pendingChanges, [field]: value };

  // Check if the value is different from original
  const isDirty = Object.entries(newChanges).some(([key, val]) => {
    const orig = editState.originalData?.[key as keyof BuildingProperties];
    return val !== orig && !(val === "" && orig === null);
  });

  updateEditState({
    pendingChanges: newChanges,
    isDirty,
  });
}

/**
 * Get the current value for a field (pending change or original).
 */
export function getFieldValue(field: keyof BuildingProperties): string | number | null {
  if (field in editState.pendingChanges) {
    return editState.pendingChanges[field] ?? null;
  }
  return editState.originalData?.[field] ?? null;
}

/**
 * Clear all pending changes.
 */
export function discardChanges(): void {
  updateEditState({
    pendingChanges: {},
    isDirty: false,
    lastError: null,
  });
}

/**
 * Mark that we're saving.
 */
export function setSaving(isSaving: boolean): void {
  updateEditState({ isSaving });
}

/**
 * Mark save as complete and update original data.
 */
export function saveComplete(newData: BuildingProperties): void {
  updateEditState({
    originalData: newData,
    pendingChanges: {},
    isDirty: false,
    isSaving: false,
    lastError: null,
  });
}

/**
 * Mark save as failed.
 */
export function saveFailed(error: string): void {
  updateEditState({
    isSaving: false,
    lastError: error,
  });
}

/**
 * Get the changes to be saved (non-empty values only).
 */
export function getChangesToSave(): Partial<BuildingProperties> {
  const changes: Partial<BuildingProperties> = {};

  for (const [key, value] of Object.entries(editState.pendingChanges)) {
    if (value !== null && value !== "") {
      (changes as Record<string, unknown>)[key] = value;
    }
  }

  return changes;
}

/**
 * Check if edit mode is enabled.
 */
export function isEditModeEnabled(): boolean {
  return editState.enabled;
}
