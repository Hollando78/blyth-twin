# Blyth Digital Twin Viewer

A Three.js-based 3D viewer for the Blyth Digital Twin project.

## Features

- **3D Terrain & Buildings** - LiDAR-derived terrain with 17k+ procedurally generated buildings
- **Infrastructure Layers** - Roads, railways, water bodies with toggleable visibility
- **Building Selection** - Click any building to view metadata and properties
- **Building Preview** - Isolated 3D preview window for selected buildings
- **Mesh Editor** - Full in-browser 3D geometry editing
- **Property Editing** - Edit building metadata via API
- **Custom Mesh Support** - Upload or create custom 3D models for buildings

## Quick Start

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Type check
pnpm tsc --noEmit
```

## Project Structure

```
src/
├── main.ts              # Application entry point
├── state.ts             # Global viewer state
├── types.ts             # TypeScript interfaces
├── scene-setup.ts       # Three.js scene, camera, lights
├── asset-loader.ts      # GLB mesh and texture loading
├── layers.ts            # Layer visibility management
├── selection.ts         # Building raycasting and selection
├── shaders.ts           # Custom water/material shaders
├── style.css            # UI styles
│
├── mesh-preview.ts      # Building preview window
├── mesh-upload.ts       # GLB upload UI
│
├── edit-mode.ts         # Edit mode state management
├── edit-panel.ts        # Property edit form UI
├── api-client.ts        # API client for backend
│
├── mesh-editor/         # In-browser 3D mesh editor
│   ├── index.ts             # Public API
│   ├── editor-state.ts      # Editor state management
│   ├── editor-ui.ts         # Toolbar and status bar
│   │
│   ├── tools/
│   │   ├── select-tool.ts   # Vertex/face selection
│   │   ├── transform-tool.ts # Move/rotate/scale
│   │   └── extrude-tool.ts  # Face extrusion
│   │
│   ├── geometry/
│   │   └── geometry-utils.ts # BufferGeometry helpers
│   │
│   ├── materials/
│   │   ├── material-panel.ts # Material property UI
│   │   └── texture-loader.ts # Texture loading/creation
│   │
│   └── export/
│       └── glb-exporter.ts  # GLTFExporter wrapper
│
└── textures/            # Procedural texture generators
```

## Viewer Controls

### Navigation
| Action | Control |
|--------|---------|
| Orbit camera | Left mouse drag |
| Pan camera | Right mouse drag |
| Zoom | Mouse wheel |
| Select building | Left click |

### UI
| Element | Description |
|---------|-------------|
| Info Panel | Shows selected building metadata |
| Layer Panel | Toggle visibility of terrain, buildings, roads, etc. |
| Edit Button | Enable property editing mode |
| Preview Button | Open isolated 3D preview window |

## Mesh Editor

The mesh editor provides in-browser 3D geometry editing capabilities.

### Tools

| Tool | Shortcut | Description |
|------|----------|-------------|
| Select | Q | Click to select vertices or faces |
| Move | W | Translate selected geometry |
| Rotate | E | Rotate selected geometry |
| Scale | R | Scale selected geometry |
| Extrude | T | Extrude selected faces |

### Selection Modes

| Mode | Description |
|------|-------------|
| Vertex | Select individual vertices |
| Face | Select triangular faces |
| Object | Select entire mesh |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+Z | Undo |
| Ctrl+Shift+Z / Ctrl+Y | Redo |
| Ctrl+A | Select all |
| Escape | Clear selection |
| Delete | Delete selected faces |
| Ctrl+S | Save to API |

### Material Panel

- **Color** - Base color picker
- **Roughness** - Surface roughness (0-1)
- **Metalness** - Metallic appearance (0-1)
- **Opacity** - Transparency (0-1)
- **Wireframe** - Toggle wireframe display
- **Double Sided** - Render both sides of faces
- **Texture** - Drag and drop image textures
- **Tile U/V** - Texture tiling controls

### Workflow

1. Select a building in the main viewer
2. Click "Preview" to open the preview window
3. Click the edit button (✎) in the preview header
4. Use tools to modify geometry
5. Edit material properties in the side panel
6. Click "Save to API" to upload the modified mesh

## API Integration

The viewer communicates with the FastAPI backend for:

- **Building data** - Fetch building properties and overrides
- **Property edits** - Save building metadata changes
- **Custom meshes** - Upload/download modified 3D geometry

### Configuration

Create `.env` file:

```env
VITE_API_URL=http://localhost:8000/api
VITE_API_KEY=dev-api-key
```

## Asset Loading

Assets are loaded from `/manifest.json` which lists:

- `terrain` - Ground mesh (GLB)
- `buildings` - Building chunks (GLB, chunked by location)
- `roads` - Road network mesh (GLB)
- `railways` - Railway lines mesh (GLB)
- `water` - Water bodies mesh (GLB)
- `sea` - Sea/coastal mesh (GLB)
- `footprints` - Building selection mesh (GLB)

Building metadata is loaded from:
- `/footprints_metadata.json` - Building face-to-ID mapping
- `/buildings_metadata.json` - Chunk-level building data

## Performance

- **Chunked buildings** - Buildings split into spatial chunks for efficient culling
- **Face mapping** - GPU-based building selection via face indices
- **LOD support** - Distance-based detail culling (configurable)
- **Procedural textures** - Runtime-generated building facades

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

Requires WebGL 2.0 support.

## Development

### Adding New Tools

1. Create tool file in `src/mesh-editor/tools/`
2. Implement tool interface (init, dispose, event handlers)
3. Register in `editor-ui.ts` toolbar
4. Add keyboard shortcut mapping

### Custom Materials

Materials use Three.js `MeshStandardMaterial` with PBR properties.
Custom shaders can be added via `shaders.ts`.

### State Management

- `state.ts` - Main viewer state (camera, meshes, selection)
- `editor-state.ts` - Mesh editor state (tools, selection, undo stack)
- `edit-mode.ts` - Property edit mode state
