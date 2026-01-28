# Mesh Editor Module

In-browser 3D mesh editor for modifying building geometry in the Blyth Digital Twin viewer.

## Overview

The mesh editor provides Blender-like 3D editing capabilities directly in the browser, allowing users to:
- Select vertices and faces
- Transform geometry (move, rotate, scale)
- Extrude faces
- Edit materials and textures
- Export to GLB format
- Save custom meshes to the API

## Architecture

```
mesh-editor/
├── index.ts             # Public API and event handling
├── editor-state.ts      # State management with subscriptions
├── editor-ui.ts         # Toolbar, panels, keyboard shortcuts
│
├── tools/
│   ├── select-tool.ts   # Raycaster-based selection
│   ├── transform-tool.ts # TransformControls wrapper
│   └── extrude-tool.ts  # Face extrusion logic
│
├── geometry/
│   └── geometry-utils.ts # BufferGeometry helpers
│
├── materials/
│   ├── material-panel.ts # Material property bindings
│   └── texture-loader.ts # Texture loading utilities
│
└── export/
    └── glb-exporter.ts  # GLTFExporter + API upload
```

## Usage

### Opening the Editor

```typescript
import { openMeshEditor, closeMeshEditor } from './mesh-editor';

// Open editor with a geometry
openMeshEditor(
  scene,           // THREE.Scene
  camera,          // THREE.Camera
  controls,        // OrbitControls (optional)
  geometry,        // THREE.BufferGeometry to edit
  osmId,           // Building OSM ID
  container        // HTMLElement for UI
);

// Close editor
closeMeshEditor();
```

### Checking State

```typescript
import { getEditorState, isEditorOpen } from './mesh-editor';

if (isEditorOpen()) {
  const state = getEditorState();
  console.log('Selected vertices:', state.selectedVertices.size);
}
```

### Animation Loop Integration

```typescript
import { updateEditor } from './mesh-editor';

function animate() {
  requestAnimationFrame(animate);

  // Update editor visuals
  updateEditor();

  renderer.render(scene, camera);
}
```

## State Management

The editor uses a subscription-based state pattern:

```typescript
interface MeshEditorState {
  isOpen: boolean;
  osmId: number | null;
  activeTool: EditorTool;
  selectionMode: SelectionMode;
  selectedVertices: Set<number>;
  selectedFaces: Set<number>;
  undoStack: GeometrySnapshot[];
  redoStack: GeometrySnapshot[];
  isDirty: boolean;
  snapEnabled: boolean;
  snapGridSize: number;
  workingGeometry: THREE.BufferGeometry | null;
  workingMesh: THREE.Mesh | null;
}

// Subscribe to changes
import { subscribeToEditorState } from './editor-state';

const unsubscribe = subscribeToEditorState((state) => {
  console.log('State changed:', state.activeTool);
});

// Unsubscribe when done
unsubscribe();
```

## Tools

### Select Tool

Raycaster-based selection supporting vertices and faces.

```typescript
// Vertex selection: screen-space proximity detection
// Face selection: standard raycaster intersection
// Shift+click for additive selection
```

### Transform Tool

Wrapper around THREE.TransformControls for manipulating selected geometry.

```typescript
import { setTransformMode } from './tools/transform-tool';

setTransformMode('translate'); // or 'rotate', 'scale'
```

Features:
- Operates on selected vertices
- Computes centroid for pivot point
- Recomputes normals after transform
- Supports snap-to-grid

### Extrude Tool

Creates new geometry by extruding selected faces.

```typescript
import { extrudeFaces, insetFaces, deleteFaces } from './tools/extrude-tool';

// Extrude faces by 2 meters along average normal
extrudeFaces(2.0);

// Inset faces by 30%
insetFaces(0.3);

// Delete selected faces
deleteFaces();
```

## Geometry Utilities

```typescript
import {
  getGeometryStats,
  flipNormals,
  recalculateNormals,
  weldVertices,
  centerGeometry
} from './geometry/geometry-utils';

const stats = getGeometryStats();
// { vertexCount: 1234, faceCount: 400, boundingBox: {...} }

flipNormals();           // Reverse face winding
recalculateNormals();    // Recompute vertex normals
weldVertices(0.001);     // Merge close vertices
centerGeometry();        // Center at origin
```

## Material Editing

The material panel provides live editing of MeshStandardMaterial properties:

```typescript
import { setEditingMaterial, getCurrentMaterial } from './materials/material-panel';

// Set material to edit
setEditingMaterial(mesh.material);

// Get current material
const mat = getCurrentMaterial();
```

Properties:
- Color (hex picker)
- Roughness (0-1 slider)
- Metalness (0-1 slider)
- Opacity (0-1 slider)
- Wireframe (checkbox)
- Double-sided (checkbox)
- Texture (drag-drop)
- Tiling (U/V controls)

## Texture Loading

```typescript
import {
  loadTextureFromFile,
  createCheckerTexture,
  createGridTexture
} from './materials/texture-loader';

// Load from file
const { texture, width, height } = await loadTextureFromFile(file);

// Create procedural textures
const checker = createCheckerTexture(0xffffff, 0x888888, 64, 8);
const grid = createGridTexture(0x333333, 0x666666, 64, 2);
```

## Exporting

### Save to API

```typescript
import { saveToAPI } from './export/glb-exporter';

const result = await saveToAPI();
if (result.success) {
  console.log('Saved mesh ID:', result.meshId);
} else {
  console.error('Failed:', result.message);
}
```

### Download as GLB

```typescript
import { downloadAsGLB } from './export/glb-exporter';

await downloadAsGLB(); // Downloads building_{osmId}.glb
```

### Export to Blob

```typescript
import { exportToGLB } from './export/glb-exporter';

const blob = await exportToGLB();
// Use blob for custom handling
```

## Undo/Redo

The editor maintains geometry snapshots for undo/redo:

```typescript
import { saveSnapshot, undo, redo, canUndo, canRedo } from './editor-state';

// Save current state before making changes
saveSnapshot();

// Perform undo/redo
if (canUndo()) undo();
if (canRedo()) redo();
```

Stack limits:
- Maximum 50 undo states
- Redo stack cleared on new action

## Keyboard Shortcuts

Implemented in `editor-ui.ts`:

| Key | Action | Function |
|-----|--------|----------|
| Q | Select tool | `setActiveTool('select')` |
| W | Move tool | `setActiveTool('move')` |
| E | Rotate tool | `setActiveTool('rotate')` |
| R | Scale tool | `setActiveTool('scale')` |
| T | Extrude tool | `setActiveTool('extrude')` |
| Ctrl+Z | Undo | `undo()` |
| Ctrl+Shift+Z | Redo | `redo()` |
| Ctrl+A | Select all | `selectAll()` |
| Escape | Clear selection | `clearSelection()` |
| Delete | Delete faces | `deleteFaces()` |
| Ctrl+S | Save | `saveToAPI()` |

## CSS Classes

The editor uses these CSS classes (define in `style.css`):

```css
.mesh-editor-ui        /* Main container */
.editor-toolbar        /* Top toolbar */
.tool-btn              /* Tool button */
.tool-btn.active       /* Active tool */
.mode-btn              /* Selection mode button */
.editor-status         /* Status bar */
.editor-actions        /* Save/download buttons */
.editor-dialog         /* Extrude distance dialog */
.material-panel        /* Material editor panel */
.texture-dropzone      /* Texture drop area */
```

## Events

The editor dispatches events for external integration:

```typescript
// Listen for mesh changes
container.addEventListener('mesh-changed', (e) => {
  console.log('Geometry modified');
});

// Listen for save
container.addEventListener('mesh-saved', (e) => {
  console.log('Mesh saved:', e.detail.osmId);
});
```

## Performance Considerations

- Selection visualization uses separate Points geometry
- Face highlight uses overlay mesh with depth test disabled
- Transform operations batch vertex updates
- Normals recomputed once per operation, not per-vertex

## Extending the Editor

### Adding a New Tool

1. Create `tools/my-tool.ts`:

```typescript
export function initMyTool(scene: THREE.Scene): void {
  // Setup
}

export function disposeMyTool(scene: THREE.Scene): void {
  // Cleanup
}

export function onMyToolClick(event: MouseEvent): void {
  // Handle interaction
}
```

2. Register in `editor-state.ts`:

```typescript
export type EditorTool = 'select' | 'move' | 'rotate' | 'scale' | 'extrude' | 'mytool';
```

3. Add UI in `editor-ui.ts`:

```typescript
// Add button in createEditorUI()
// Add shortcut in SHORTCUTS map
// Handle tool activation in selectTool()
```

### Custom Geometry Operations

Add operations in `geometry-utils.ts`:

```typescript
export function myOperation(): void {
  const state = getEditorState();
  if (!state.workingGeometry) return;

  saveSnapshot(); // For undo

  const positions = state.workingGeometry.getAttribute('position');
  // Modify positions...

  positions.needsUpdate = true;
  state.workingGeometry.computeVertexNormals();
}
```
