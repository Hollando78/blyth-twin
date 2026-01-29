/**
 * Mesh upload functionality for custom 3D building models.
 *
 * Provides drag-drop and file selection for uploading GLB files
 * to replace procedurally generated building meshes.
 */

import { uploadMesh, deleteMesh, getMeshMetadata } from "./api-client.ts";
import { getEditState, subscribeToEditState } from "./edit-mode.ts";
import { loadAndApplyCustomMesh } from "./asset-loader.ts";

let dropZoneElement: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * Create the mesh upload UI.
 */
function createMeshUploadUI(): HTMLElement {
  const container = document.createElement("div");
  container.id = "mesh-upload";
  container.className = "hidden";
  container.innerHTML = `
    <div class="mesh-upload-header">
      <h4>Custom 3D Model</h4>
    </div>
    <div id="mesh-status" class="mesh-status hidden">
      <span id="mesh-info"></span>
      <button id="mesh-delete-btn" class="btn-small btn-danger" title="Remove custom mesh">
        Remove
      </button>
    </div>
    <div id="mesh-dropzone" class="mesh-dropzone">
      <div class="dropzone-content">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
        <p>Drag & drop GLB file here</p>
        <p class="dropzone-hint">or click to browse</p>
        <input type="file" id="mesh-file-input" accept=".glb" hidden />
      </div>
    </div>
    <div id="mesh-upload-progress" class="mesh-progress hidden">
      <div class="progress-bar">
        <div class="progress-fill"></div>
      </div>
      <span class="progress-text">Uploading...</span>
    </div>
    <div id="mesh-upload-error" class="mesh-error hidden"></div>
  `;

  return container;
}

/**
 * Handle file drop.
 */
async function handleFileDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();

  dropZoneElement?.classList.remove("dragover");

  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const file = files[0];
  await uploadFile(file);
}

/**
 * Handle file selection.
 */
async function handleFileSelect(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = input.files;
  if (!files || files.length === 0) return;

  const file = files[0];
  await uploadFile(file);

  // Reset input so same file can be selected again
  input.value = "";
}

/**
 * Upload a GLB file.
 */
async function uploadFile(file: File): Promise<void> {
  const state = getEditState();
  if (!state.selectedOsmId || !state.apiAvailable) return;

  // Validate file type
  if (!file.name.toLowerCase().endsWith(".glb")) {
    showError("Only GLB files are supported");
    return;
  }

  // Validate file size (50MB max)
  const maxSize = 50 * 1024 * 1024;
  if (file.size > maxSize) {
    showError("File too large. Maximum size is 50MB");
    return;
  }

  // Show progress
  const progressEl = document.getElementById("mesh-upload-progress");
  const errorEl = document.getElementById("mesh-upload-error");
  if (progressEl) progressEl.classList.remove("hidden");
  if (errorEl) errorEl.classList.add("hidden");

  try {
    const result = await uploadMesh(state.selectedOsmId, file, "user_upload");

    // Hide progress
    if (progressEl) progressEl.classList.add("hidden");

    // Update mesh status UI
    updateMeshStatus(state.selectedOsmId);

    // Load and apply the custom mesh to the main scene
    const applied = await loadAndApplyCustomMesh(state.selectedOsmId);
    if (applied) {
      console.log("Custom mesh applied to scene");
    }

    console.log("Mesh uploaded:", result);
  } catch (error) {
    if (progressEl) progressEl.classList.add("hidden");
    showError(error instanceof Error ? error.message : "Upload failed");
  }
}

/**
 * Show an error message.
 */
function showError(message: string): void {
  const errorEl = document.getElementById("mesh-upload-error");
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }
}

/**
 * Update the mesh status display.
 */
async function updateMeshStatus(osmId: number): Promise<void> {
  const statusEl = document.getElementById("mesh-status");
  const infoEl = document.getElementById("mesh-info");
  const dropzoneEl = document.getElementById("mesh-dropzone");

  if (!statusEl || !infoEl) return;

  const metadata = await getMeshMetadata(osmId);

  if (metadata) {
    // Show status, hide dropzone
    statusEl.classList.remove("hidden");
    if (dropzoneEl) dropzoneEl.classList.add("hidden");

    let info = "Custom mesh uploaded";
    if (metadata.vertex_count) {
      info += ` (${metadata.vertex_count.toLocaleString()} vertices)`;
    }
    infoEl.textContent = info;
  } else {
    // No custom mesh
    statusEl.classList.add("hidden");
    if (dropzoneEl) dropzoneEl.classList.remove("hidden");
  }
}

/**
 * Check if a building has a custom mesh.
 */
export async function hasCustomMesh(osmId: number): Promise<boolean> {
  const metadata = await getMeshMetadata(osmId);
  return metadata !== null;
}

/**
 * Handle mesh delete.
 */
async function handleDeleteMesh(): Promise<void> {
  const state = getEditState();
  if (!state.selectedOsmId) return;

  const confirmed = confirm("Remove the custom 3D model for this building?");
  if (!confirmed) return;

  try {
    await deleteMesh(state.selectedOsmId);

    // Update UI
    const statusEl = document.getElementById("mesh-status");
    const dropzoneEl = document.getElementById("mesh-dropzone");
    if (statusEl) statusEl.classList.add("hidden");
    if (dropzoneEl) dropzoneEl.classList.remove("hidden");
  } catch (error) {
    showError(error instanceof Error ? error.message : "Delete failed");
  }
}

/**
 * Update the mesh upload UI based on edit state.
 */
function updateUI(): void {
  const state = getEditState();
  const container = document.getElementById("mesh-upload");

  if (!container) return;

  const shouldShow = state.enabled && state.selectedOsmId !== null && state.apiAvailable;
  container.classList.toggle("hidden", !shouldShow);

  if (shouldShow && state.selectedOsmId) {
    updateMeshStatus(state.selectedOsmId);
  }
}

/**
 * Initialize the mesh upload UI.
 */
export function initMeshUpload(): void {
  // Create UI
  const container = createMeshUploadUI();

  // Add to edit panel (if it exists) or to main UI
  const editPanel = document.getElementById("edit-panel");
  if (editPanel) {
    editPanel.appendChild(container);
  } else {
    document.getElementById("ui")?.appendChild(container);
  }

  // Set up drop zone
  dropZoneElement = document.getElementById("mesh-dropzone");
  const fileInput = document.getElementById("mesh-file-input") as HTMLInputElement | null;

  if (dropZoneElement) {
    // Drag events
    dropZoneElement.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZoneElement?.classList.add("dragover");
    });

    dropZoneElement.addEventListener("dragleave", () => {
      dropZoneElement?.classList.remove("dragover");
    });

    dropZoneElement.addEventListener("drop", handleFileDrop);

    // Click to browse
    dropZoneElement.addEventListener("click", () => {
      fileInput?.click();
    });
  }

  // File input change
  fileInput?.addEventListener("change", handleFileSelect);

  // Delete button
  document.getElementById("mesh-delete-btn")?.addEventListener("click", handleDeleteMesh);

  // Subscribe to edit state changes
  unsubscribe = subscribeToEditState(updateUI);

  // Initial update
  updateUI();
}

/**
 * Clean up the mesh upload UI.
 */
export function destroyMeshUpload(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  const container = document.getElementById("mesh-upload");
  if (container) {
    container.remove();
  }

  dropZoneElement = null;
}
