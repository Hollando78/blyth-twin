/**
 * Mesh Editor UI
 *
 * Main UI controller for the mesh editor.
 * Features:
 * - Toolbar with tool buttons
 * - Selection mode toggle
 * - Status bar with selection info
 * - Keyboard shortcuts
 */

import {
  getEditorState,
  subscribeToEditorState,
  setActiveTool,
  setSelectionMode,
  clearSelection,
  selectAll,
  undo,
  redo,
  toggleSnap,
  hasUnsavedChanges,
  EditorTool,
  SelectionMode,
} from "./editor-state.ts";

import { updateSelectionVisualization } from "./tools/select-tool.ts";
import {
  setTransformMode,
  setTransformEnabled,
  updateTransformPosition,
} from "./tools/transform-tool.ts";
import { extrudeFaces, deleteFaces } from "./tools/extrude-tool.ts";
import { getGeometryStats, flipNormals } from "./geometry/geometry-utils.ts";
import { downloadAsGLB, saveToAPI } from "./export/glb-exporter.ts";

let editorUIElement: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * Toggle select all - if anything selected, deselect all; otherwise select all.
 */
function toggleSelectAll(): void {
  const state = getEditorState();
  if (state.selectedVertices.size > 0 || state.selectedFaces.size > 0) {
    clearSelection();
  } else {
    selectAll();
  }
  updateSelectionVisualization();
}

// Keyboard shortcut map - Blender-like controls
const SHORTCUTS: Record<string, () => void> = {
  // Transform tools (Blender-style)
  g: () => selectTool("move"),      // G = Grab/Move
  r: () => selectTool("rotate"),    // R = Rotate
  s: () => selectTool("scale"),     // S = Scale
  e: () => selectTool("extrude"),   // E = Extrude

  // Selection
  a: () => toggleSelectAll(),       // A = Toggle select all
  Escape: () => {                   // Escape = Cancel/deselect
    clearSelection();
    selectTool("select");           // Return to select tool
  },
  Delete: () => handleDelete(),     // Delete = Delete selected
  x: () => handleDelete(),          // X = Delete (Blender alt)

  // Selection modes (1/2/3 like Blender)
  "1": () => { setSelectionMode("vertex"); updateModeButtons(); },
  "2": () => { setSelectionMode("face"); updateModeButtons(); },
  "3": () => { setSelectionMode("object"); updateModeButtons(); },
};

/**
 * Create the editor UI.
 */
function createEditorUI(): HTMLElement {
  const container = document.createElement("div");
  container.id = "mesh-editor-ui";
  container.className = "mesh-editor-ui";
  container.innerHTML = `
    <div class="editor-toolbar">
      <div class="toolbar-section">
        <span class="toolbar-label">Tools</span>
        <div class="toolbar-buttons">
          <button id="tool-select" class="tool-btn active" title="Select (Esc to return)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 2l5 12 2-4 4-2L2 2z"/>
            </svg>
          </button>
          <button id="tool-move" class="tool-btn" title="Grab/Move (G)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1l3 3H9v3h3V5l3 3-3 3v-2H9v3h2l-3 3-3-3h2V9H4v2l-3-3 3-3v2h3V4H5l3-3z"/>
            </svg>
          </button>
          <button id="tool-rotate" class="tool-btn" title="Rotate (R)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a7 7 0 106.32 4H12a5 5 0 11-4-3V0l4 2.5L8 5V1z"/>
            </svg>
          </button>
          <button id="tool-scale" class="tool-btn" title="Scale (S)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 1h5v2H3v3H1V1zm14 0v5h-2V3h-3V1h5zM1 15v-5h2v3h3v2H1zm14 0h-5v-2h3v-3h2v5z"/>
            </svg>
          </button>
          <button id="tool-extrude" class="tool-btn" title="Extrude (E)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0l6 4v8l-6 4-6-4V4l6-4zm0 2L4 4.5V11l4 2.5 4-2.5V4.5L8 2z"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="toolbar-divider"></div>

      <div class="toolbar-section">
        <span class="toolbar-label">Mode</span>
        <div class="toolbar-buttons mode-buttons">
          <button id="mode-vertex" class="mode-btn active" title="Vertex mode (1)">V</button>
          <button id="mode-face" class="mode-btn" title="Face mode (2)">F</button>
          <button id="mode-object" class="mode-btn" title="Object mode (3)">O</button>
        </div>
      </div>

      <div class="toolbar-divider"></div>

      <div class="toolbar-section">
        <span class="toolbar-label">Edit</span>
        <div class="toolbar-buttons">
          <button id="btn-undo" class="tool-btn" title="Undo (Ctrl+Z)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 8l4-4v3h4a4 4 0 010 8H7v-2h5a2 2 0 000-4H8v3L4 8z"/>
            </svg>
          </button>
          <button id="btn-redo" class="tool-btn" title="Redo (Ctrl+Shift+Z)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M12 8l-4-4v3H4a4 4 0 000 8h5v-2H4a2 2 0 010-4h4v3l4-4z"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="toolbar-divider"></div>

      <div class="toolbar-section">
        <span class="toolbar-label">Geometry</span>
        <div class="toolbar-buttons">
          <button id="btn-flip-normals" class="tool-btn" title="Flip Normals">↻</button>
          <button id="btn-delete" class="tool-btn" title="Delete (X or Del)">✕</button>
        </div>
      </div>

      <div class="toolbar-section toolbar-snap">
        <label class="snap-toggle">
          <input type="checkbox" id="snap-toggle" />
          <span>Snap</span>
        </label>
      </div>
    </div>

    <div class="editor-status">
      <span id="selection-info">No selection</span>
      <span class="status-divider">|</span>
      <span id="geometry-info">0 verts, 0 faces</span>
    </div>

    <div class="editor-actions">
      <button id="btn-save-api" class="btn-primary">Save to API</button>
      <button id="btn-download" class="btn-secondary">Download GLB</button>
    </div>

    <div id="extrude-dialog" class="editor-dialog hidden">
      <div class="dialog-content">
        <h4>Extrude Faces</h4>
        <div class="dialog-field">
          <label for="extrude-distance">Distance (m)</label>
          <input type="number" id="extrude-distance" value="1" step="0.1" />
        </div>
        <div class="dialog-actions">
          <button id="extrude-cancel" class="btn-secondary">Cancel</button>
          <button id="extrude-apply" class="btn-primary">Apply</button>
        </div>
      </div>
    </div>
  `;

  return container;
}

/**
 * Initialize the editor UI.
 */
export function initEditorUI(container: HTMLElement): void {
  editorUIElement = createEditorUI();
  container.appendChild(editorUIElement);

  // Set up tool buttons
  setupToolButtons();
  setupModeButtons();
  setupEditButtons();
  setupExportButtons();
  setupExtrudeDialog();
  setupKeyboardShortcuts();

  // Subscribe to state changes
  unsubscribe = subscribeToEditorState(updateUI);

  // Initial update
  updateUI();
}

/**
 * Set up tool selection buttons.
 */
function setupToolButtons(): void {
  const tools: EditorTool[] = ["select", "move", "rotate", "scale", "extrude"];

  for (const tool of tools) {
    const btn = document.getElementById(`tool-${tool}`);
    if (btn) {
      btn.addEventListener("click", () => selectTool(tool));
    }
  }
}

/**
 * Set up mode selection buttons.
 */
function setupModeButtons(): void {
  const modes: Array<{ id: string; mode: SelectionMode }> = [
    { id: "mode-vertex", mode: "vertex" },
    { id: "mode-face", mode: "face" },
    { id: "mode-object", mode: "object" },
  ];

  for (const { id, mode } of modes) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener("click", () => {
        setSelectionMode(mode);
        updateModeButtons();
      });
    }
  }
}

/**
 * Set up edit buttons.
 */
function setupEditButtons(): void {
  document.getElementById("btn-undo")?.addEventListener("click", handleUndo);
  document.getElementById("btn-redo")?.addEventListener("click", handleRedo);
  document.getElementById("btn-flip-normals")?.addEventListener("click", () => {
    flipNormals();
    updateGeometryInfo();
  });
  document.getElementById("btn-delete")?.addEventListener("click", handleDelete);

  // Snap toggle
  const snapToggle = document.getElementById("snap-toggle") as HTMLInputElement;
  if (snapToggle) {
    snapToggle.addEventListener("change", () => {
      toggleSnap();
    });
  }
}

/**
 * Set up export buttons.
 */
function setupExportButtons(): void {
  document.getElementById("btn-save-api")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-api") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Saving...";

    const result = await saveToAPI();

    btn.disabled = false;
    btn.textContent = "Save to API";

    if (result.success) {
      showStatusMessage("Saved!", "success");
    } else {
      showStatusMessage(`Error: ${result.message}`, "error");
    }
  });

  document.getElementById("btn-download")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-download") as HTMLButtonElement;
    btn.disabled = true;

    await downloadAsGLB();

    btn.disabled = false;
  });
}

/**
 * Set up extrude dialog.
 */
function setupExtrudeDialog(): void {
  const dialog = document.getElementById("extrude-dialog");
  const distanceInput = document.getElementById("extrude-distance") as HTMLInputElement;

  document.getElementById("extrude-cancel")?.addEventListener("click", () => {
    dialog?.classList.add("hidden");
  });

  document.getElementById("extrude-apply")?.addEventListener("click", () => {
    const distance = parseFloat(distanceInput?.value || "1");
    if (extrudeFaces(distance)) {
      updateSelectionVisualization();
      updateGeometryInfo();
    }
    dialog?.classList.add("hidden");
  });
}

/**
 * Set up keyboard shortcuts.
 */
function setupKeyboardShortcuts(): void {
  document.addEventListener("keydown", (e) => {
    const state = getEditorState();
    if (!state.isOpen) return;

    // Ignore if typing in an input
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    ) {
      return;
    }

    // Handle Ctrl/Cmd shortcuts
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if (e.key === "y") {
        e.preventDefault();
        handleRedo();
      } else if (e.key === "a") {
        e.preventDefault();
        selectAll();
        updateSelectionVisualization();
      } else if (e.key === "s") {
        e.preventDefault();
        handleSave();
      }
      return;
    }

    // Regular shortcuts
    const shortcut = SHORTCUTS[e.key];
    if (shortcut) {
      e.preventDefault();
      shortcut();
    }
  });
}

/**
 * Select a tool.
 */
function selectTool(tool: EditorTool): void {
  const state = getEditorState();

  // Show extrude dialog if extrude tool selected with faces
  if (tool === "extrude" && state.selectedFaces.size > 0) {
    const dialog = document.getElementById("extrude-dialog");
    dialog?.classList.remove("hidden");
    return;
  }

  setActiveTool(tool);
  updateToolButtons();

  // Update transform mode
  if (tool === "move") {
    setTransformMode("translate");
    setTransformEnabled(true);
  } else if (tool === "rotate") {
    setTransformMode("rotate");
    setTransformEnabled(true);
  } else if (tool === "scale") {
    setTransformMode("scale");
    setTransformEnabled(true);
  } else {
    setTransformEnabled(false);
  }

  updateTransformPosition();
}

/**
 * Update tool button states.
 */
function updateToolButtons(): void {
  const state = getEditorState();
  const tools: EditorTool[] = ["select", "move", "rotate", "scale", "extrude"];

  for (const tool of tools) {
    const btn = document.getElementById(`tool-${tool}`);
    if (btn) {
      btn.classList.toggle("active", state.activeTool === tool);
    }
  }
}

/**
 * Update mode button states.
 */
function updateModeButtons(): void {
  const state = getEditorState();
  const modes: Array<{ id: string; mode: SelectionMode }> = [
    { id: "mode-vertex", mode: "vertex" },
    { id: "mode-face", mode: "face" },
    { id: "mode-object", mode: "object" },
  ];

  for (const { id, mode } of modes) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.classList.toggle("active", state.selectionMode === mode);
    }
  }
}

/**
 * Update the UI based on current state.
 */
function updateUI(): void {
  const state = getEditorState();

  // Update tool/mode buttons
  updateToolButtons();
  updateModeButtons();

  // Update selection info
  const selectionInfo = document.getElementById("selection-info");
  if (selectionInfo) {
    const vertCount = state.selectedVertices.size;
    const faceCount = state.selectedFaces.size;

    if (vertCount === 0 && faceCount === 0) {
      selectionInfo.textContent = "No selection";
    } else if (state.selectionMode === "vertex") {
      selectionInfo.textContent = `${vertCount} vertices selected`;
    } else if (state.selectionMode === "face") {
      selectionInfo.textContent = `${faceCount} faces (${vertCount} verts)`;
    } else {
      selectionInfo.textContent = `${vertCount} vertices`;
    }
  }

  // Update undo/redo buttons
  const undoBtn = document.getElementById("btn-undo") as HTMLButtonElement;
  const redoBtn = document.getElementById("btn-redo") as HTMLButtonElement;
  if (undoBtn) {
    undoBtn.disabled = state.undoStack.length <= 1;
  }
  if (redoBtn) {
    redoBtn.disabled = state.redoStack.length === 0;
  }

  // Update snap toggle
  const snapToggle = document.getElementById("snap-toggle") as HTMLInputElement;
  if (snapToggle) {
    snapToggle.checked = state.snapEnabled;
  }

  updateGeometryInfo();
}

/**
 * Update geometry info display.
 */
function updateGeometryInfo(): void {
  const stats = getGeometryStats();
  const geometryInfo = document.getElementById("geometry-info");

  if (geometryInfo) {
    geometryInfo.textContent = `${stats.vertexCount} verts, ${stats.faceCount} faces`;
  }
}

/**
 * Handle undo.
 */
function handleUndo(): void {
  if (undo()) {
    updateSelectionVisualization();
    updateUI();
  }
}

/**
 * Handle redo.
 */
function handleRedo(): void {
  if (redo()) {
    updateSelectionVisualization();
    updateUI();
  }
}

/**
 * Handle delete.
 */
function handleDelete(): void {
  const state = getEditorState();
  if (state.selectedFaces.size > 0 && state.selectionMode === "face") {
    if (deleteFaces()) {
      clearSelection();
      updateSelectionVisualization();
      updateUI();
    }
  }
}

/**
 * Handle save.
 */
async function handleSave(): Promise<void> {
  const btn = document.getElementById("btn-save-api") as HTMLButtonElement;
  if (btn) {
    btn.click();
  }
}

/**
 * Show a status message.
 */
function showStatusMessage(message: string, type: "success" | "error" = "success"): void {
  const selectionInfo = document.getElementById("selection-info");
  if (selectionInfo) {
    const originalText = selectionInfo.textContent;
    selectionInfo.textContent = message;
    selectionInfo.style.color = type === "success" ? "#4CAF50" : "#F44336";

    setTimeout(() => {
      selectionInfo.textContent = originalText;
      selectionInfo.style.color = "";
    }, 2000);
  }
}

/**
 * Dispose of the editor UI.
 */
export function disposeEditorUI(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  if (editorUIElement) {
    editorUIElement.remove();
    editorUIElement = null;
  }
}

/**
 * Check for unsaved changes and confirm close.
 */
export function confirmClose(): boolean {
  if (hasUnsavedChanges()) {
    return confirm("You have unsaved changes. Close anyway?");
  }
  return true;
}
