/**
 * Mesh Preview Window
 *
 * A pop-out window that displays a single building mesh in isolation.
 * Features:
 * - Draggable/resizable window
 * - OrbitControls for rotation
 * - Auto-centers and fits the building
 * - Persistent (stays open when clicking elsewhere)
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { ViewerState } from "./state.ts";
import {
  openMeshEditor,
  closeMeshEditor,
  updateEditor,
  getEditorState,
} from "./mesh-editor/index.ts";

interface PreviewState {
  container: HTMLElement | null;
  canvas: HTMLCanvasElement | null;
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.PerspectiveCamera | null;
  controls: OrbitControls | null;
  buildingMesh: THREE.Object3D | null;
  buildingGeometry: THREE.BufferGeometry | null;
  buildingMaterial: THREE.Material | null; // Store the building's material for editor
  animationId: number | null;
  isOpen: boolean;
  isEditMode: boolean;
  currentOsmId: number | null;
  currentGlobalId: number | null;
  isDragging: boolean;
  dragOffset: { x: number; y: number };
  // Original building position for placing custom mesh back in world
  originalCenter: THREE.Vector3 | null;
  originalBaseZ: number;
  // Reference to main viewer state
  mainViewerState: ViewerState | null;
  // Chunk info for hiding original faces
  buildingChunkInfo: { chunkId: string; startFace: number; endFace: number } | null;
}

const previewState: PreviewState = {
  container: null,
  canvas: null,
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  buildingMesh: null,
  buildingGeometry: null,
  buildingMaterial: null,
  animationId: null,
  isOpen: false,
  isEditMode: false,
  currentOsmId: null,
  currentGlobalId: null,
  isDragging: false,
  dragOffset: { x: 0, y: 0 },
  originalCenter: null,
  originalBaseZ: 0,
  mainViewerState: null,
  buildingChunkInfo: null,
};

/**
 * Create the preview window DOM structure.
 */
function createPreviewWindow(): HTMLElement {
  const container = document.createElement("div");
  container.id = "mesh-preview-window";
  container.className = "preview-window";
  container.innerHTML = `
    <div class="preview-header">
      <span class="preview-title">Building Preview</span>
      <div class="preview-controls">
        <button id="preview-edit-btn" class="preview-edit-btn" title="Edit Mesh">✎</button>
        <button id="preview-reset-btn" title="Reset view">↺</button>
        <button id="preview-close-btn" title="Close">&times;</button>
      </div>
    </div>
    <div class="preview-content">
      <canvas id="preview-canvas"></canvas>
    </div>
    <div class="preview-info">
      <span id="preview-osm-id"></span>
    </div>
    <div class="preview-resize-handle"></div>
  `;
  return container;
}

/**
 * Initialize the Three.js scene for the preview.
 */
function initPreviewScene(): void {
  if (!previewState.canvas) return;

  // Renderer - with iOS Safari compatibility options
  previewState.renderer = new THREE.WebGLRenderer({
    canvas: previewState.canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true, // Required for iOS Safari
    powerPreference: "default",  // Let system decide (avoid high-performance on mobile)
  });
  previewState.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  previewState.renderer.setClearColor(0x1a1a2e, 1);

  // Check WebGL context
  const gl = previewState.renderer.getContext();
  if (!gl) {
    console.error("WebGL context creation failed");
    return;
  }
  console.log("Preview WebGL initialized:", {
    renderer: gl.getParameter(gl.RENDERER),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  });

  // Scene
  previewState.scene = new THREE.Scene();

  // Camera
  previewState.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  previewState.camera.position.set(50, 50, 50);

  // Controls - Z is up
  previewState.camera.up.set(0, 0, 1);
  previewState.controls = new OrbitControls(previewState.camera, previewState.canvas);
  previewState.controls.enableDamping = true;
  previewState.controls.dampingFactor = 0.1;
  previewState.controls.enablePan = true;
  previewState.controls.enableZoom = true;

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  previewState.scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(50, 100, 50);
  previewState.scene.add(directionalLight);

  const backLight = new THREE.DirectionalLight(0xffffff, 0.3);
  backLight.position.set(-50, 50, -50);
  previewState.scene.add(backLight);

  // Grid helper
  const gridHelper = new THREE.GridHelper(100, 20, 0x444444, 0x333333);
  gridHelper.rotation.x = Math.PI / 2; // Rotate to XY plane (Z-up)
  previewState.scene.add(gridHelper);

  // Initial resize
  resizePreview();

  console.log("Preview scene initialized:", {
    hasRenderer: !!previewState.renderer,
    hasScene: !!previewState.scene,
    hasCamera: !!previewState.camera,
    sceneChildren: previewState.scene.children.length,
  });
}

/**
 * Resize the preview renderer to match container size.
 */
function resizePreview(): void {
  if (!previewState.container || !previewState.renderer || !previewState.camera) return;

  const content = previewState.container.querySelector(".preview-content") as HTMLElement;
  if (!content) return;

  const width = content.clientWidth;
  const height = content.clientHeight;

  // Guard against zero dimensions (can happen if container not fully laid out)
  if (width <= 0 || height <= 0) {
    console.warn("Preview resize: invalid dimensions", { width, height });
    // Retry on next frame
    requestAnimationFrame(resizePreview);
    return;
  }

  previewState.camera.aspect = width / height;
  previewState.camera.updateProjectionMatrix();
  previewState.renderer.setSize(width, height);
}

let renderDebugLogged = false;

/**
 * Animation loop for the preview.
 */
function animatePreview(): void {
  if (!previewState.isOpen) return;

  previewState.animationId = requestAnimationFrame(animatePreview);

  if (previewState.controls) {
    previewState.controls.update();
  }

  // Update mesh editor if active
  if (previewState.isEditMode) {
    updateEditor();
  }

  if (previewState.renderer && previewState.scene && previewState.camera) {
    // Log render state once for debugging
    if (!renderDebugLogged && previewState.buildingMesh) {
      renderDebugLogged = true;
      const info = previewState.renderer.info;
      console.log("Preview render state:", {
        sceneChildren: previewState.scene.children.length,
        hasBuildingMesh: !!previewState.buildingMesh,
        canvasSize: `${previewState.renderer.domElement.width}x${previewState.renderer.domElement.height}`,
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
      });
    }
    previewState.renderer.render(previewState.scene, previewState.camera);
  }
}


/**
 * Load and display the building mesh in the preview window.
 */
export async function loadBuildingPreview(
  viewerState: ViewerState,
  osmId: number,
  globalId: number
): Promise<void> {
  if (!previewState.scene) return;

  // Clear existing mesh
  if (previewState.buildingMesh) {
    previewState.scene.remove(previewState.buildingMesh);
    previewState.buildingMesh = null;
  }

  previewState.currentOsmId = osmId;
  previewState.currentGlobalId = globalId;

  // Update info display
  const osmIdEl = document.getElementById("preview-osm-id");
  if (osmIdEl) {
    osmIdEl.textContent = `OSM ID: ${osmId}`;
  }

  let foundGeometry: THREE.BufferGeometry | null = null;

  console.log(`loadBuildingPreview: osmId=${osmId}, globalId=${globalId}`);
  console.log(`  buildingMetadata available: ${!!viewerState.buildingMetadata}`);
  console.log(`  buildingMeshes count: ${viewerState.buildingMeshes.size}`);
  console.log(`  customMeshes count: ${viewerState.customMeshes.size}`);

  // First check if there's a custom mesh for this building
  const customMesh = viewerState.customMeshes.get(osmId);
  let customMaterial: THREE.Material | null = null;

  if (customMesh) {
    console.log(`  Using custom mesh for building ${osmId}`);

    // Clone the custom mesh geometry
    const originalGeometry = customMesh.geometry as THREE.BufferGeometry;
    foundGeometry = originalGeometry.clone();

    // Clone the custom mesh material to preserve color/roughness/etc
    const origMaterial = customMesh.material;
    if (Array.isArray(origMaterial)) {
      customMaterial = origMaterial[0]?.clone() || null;
    } else if (origMaterial) {
      customMaterial = origMaterial.clone();
    }
    if (customMaterial) {
      console.log(`  Custom mesh material cloned:`, {
        type: customMaterial.type,
        color: (customMaterial as THREE.MeshStandardMaterial).color?.getHexString?.() || 'N/A',
      });
    }

    // The custom mesh is already in world coordinates, we need to center it
    foundGeometry.computeBoundingBox();
    const bbox = foundGeometry.boundingBox!;
    const center = new THREE.Vector3();
    bbox.getCenter(center);

    // Store original position for placing edited mesh back in world
    previewState.originalCenter = center.clone();
    previewState.originalBaseZ = bbox.min.z;
    previewState.buildingChunkInfo = null; // No chunk info for custom meshes

    // Translate geometry: center in X/Y, place base on Z=0 plane
    const positions = foundGeometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) {
      positions.setX(i, positions.getX(i) - center.x);
      positions.setY(i, positions.getY(i) - center.y);
      positions.setZ(i, positions.getZ(i) - bbox.min.z);
    }
    positions.needsUpdate = true;
    foundGeometry.computeBoundingBox();
    foundGeometry.computeVertexNormals();
    foundGeometry.computeBoundingSphere();

    console.log(`  Custom mesh geometry: ${foundGeometry.getAttribute("position").count} vertices`);
  }

  // Search through building metadata to find the building's face range
  // (only if we don't already have geometry from a custom mesh)
  if (!foundGeometry && viewerState.buildingMetadata) {
    for (const [chunkId, entries] of Object.entries(viewerState.buildingMetadata.chunks)) {
      for (const entry of entries) {
        if (entry.global_id === globalId) {
          console.log(`  Found building in chunk ${chunkId}, entry:`, entry);
          // Found the building entry
          const meshList = viewerState.buildingMeshes.get(chunkId);
          if (meshList && meshList.length > 0) {
            // Get the combined mesh for this chunk
            const chunkMesh = meshList[0];
            const geometry = chunkMesh.geometry as THREE.BufferGeometry;

            const startFace = entry.start_face;
            const endFace = entry.end_face;
            const faceCount = endFace - startFace;

            console.log(`Extracting building ${osmId}: faces ${startFace}-${endFace} (${faceCount} faces)`);

            // Store chunk info for hiding original faces later
            previewState.buildingChunkInfo = { chunkId, startFace, endFace };

            const positions = geometry.getAttribute("position");
            const normals = geometry.getAttribute("normal");
            const uvs = geometry.getAttribute("uv");
            const index = geometry.index;

            console.log(`  Geometry info: positions=${positions?.count}, normals=${normals?.count}, uvs=${uvs?.count}, indexed=${!!index}`);
            console.log(`  Face range: ${startFace} to ${endFace} (${faceCount} faces)`);

            const newPositions: number[] = [];
            const newNormals: number[] = [];
            const newUvs: number[] = [];

            if (index) {
              // Indexed geometry
              const newIndices: number[] = [];
              const vertexMap = new Map<number, number>();

              for (let f = startFace; f < endFace; f++) {
                for (let v = 0; v < 3; v++) {
                  const oldIndex = index.getX(f * 3 + v);

                  if (!vertexMap.has(oldIndex)) {
                    const newIndex = newPositions.length / 3;
                    vertexMap.set(oldIndex, newIndex);

                    newPositions.push(
                      positions.getX(oldIndex),
                      positions.getY(oldIndex),
                      positions.getZ(oldIndex)
                    );

                    if (normals) {
                      newNormals.push(
                        normals.getX(oldIndex),
                        normals.getY(oldIndex),
                        normals.getZ(oldIndex)
                      );
                    }

                    if (uvs) {
                      newUvs.push(uvs.getX(oldIndex), uvs.getY(oldIndex));
                    }
                  }

                  newIndices.push(vertexMap.get(oldIndex)!);
                }
              }

              if (newPositions.length > 0) {
                foundGeometry = new THREE.BufferGeometry();
                foundGeometry.setAttribute("position", new THREE.Float32BufferAttribute(newPositions, 3));
                if (newNormals.length > 0) {
                  foundGeometry.setAttribute("normal", new THREE.Float32BufferAttribute(newNormals, 3));
                }
                if (newUvs.length > 0) {
                  foundGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(newUvs, 2));
                }
                foundGeometry.setIndex(newIndices);
              }
            } else {
              // Non-indexed geometry - each face is 3 consecutive vertices
              const startVertex = startFace * 3;
              const endVertex = endFace * 3;

              for (let i = startVertex; i < endVertex; i++) {
                newPositions.push(
                  positions.getX(i),
                  positions.getY(i),
                  positions.getZ(i)
                );

                if (normals) {
                  newNormals.push(
                    normals.getX(i),
                    normals.getY(i),
                    normals.getZ(i)
                  );
                }

                if (uvs) {
                  newUvs.push(uvs.getX(i), uvs.getY(i));
                }
              }

              if (newPositions.length > 0) {
                foundGeometry = new THREE.BufferGeometry();
                foundGeometry.setAttribute("position", new THREE.Float32BufferAttribute(newPositions, 3));
                if (newNormals.length > 0) {
                  foundGeometry.setAttribute("normal", new THREE.Float32BufferAttribute(newNormals, 3));
                }
                if (newUvs.length > 0) {
                  foundGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(newUvs, 2));
                }
              }
            }

            console.log(`  Extracted: ${newPositions.length / 3} vertices`);

            if (foundGeometry) {
              foundGeometry.computeVertexNormals();
              foundGeometry.computeBoundingSphere();

              // Log first few vertex positions for debugging
              const pos = foundGeometry.getAttribute("position");
              if (pos && pos.count > 0) {
                console.log(`  First vertex: (${pos.getX(0).toFixed(2)}, ${pos.getY(0).toFixed(2)}, ${pos.getZ(0).toFixed(2)})`);
                console.log(`  BoundingSphere radius: ${foundGeometry.boundingSphere?.radius.toFixed(2)}`);
              }
              console.log(`Extracted geometry: ${foundGeometry.getAttribute("position").count} vertices`);
            } else {
              console.warn(`  Failed to create geometry from ${newPositions.length / 3} vertices`);
            }
          }
          break;
        }
      }
      if (foundGeometry) break;
    }
  }

  if (foundGeometry && foundGeometry.getAttribute("position").count > 0) {
    // Use custom material if we have one (preserves color from saved GLB)
    // Otherwise, use MeshStandardMaterial for lighting support in editor
    let material: THREE.Material;
    if (customMaterial) {
      // Ensure it's double-sided for the preview
      (customMaterial as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
      material = customMaterial;
      console.log(`  Using custom material with color: ${(customMaterial as THREE.MeshStandardMaterial).color?.getHexString?.()}`);
    } else {
      material = new THREE.MeshStandardMaterial({
        color: 0x8b7355,
        roughness: 0.8,
        metalness: 0.1,
        side: THREE.DoubleSide,
      });
    }

    // Store material for editor
    previewState.buildingMaterial = material;

    // Create mesh
    const mesh = new THREE.Mesh(foundGeometry, material);

    console.log(`  Created mesh with ${foundGeometry.getAttribute("position").count} vertices`);

    // Only center/transform if this is chunk geometry (not custom mesh which is already centered)
    if (!customMesh) {
      // Compute bounding box
      foundGeometry.computeBoundingBox();
      const bbox = foundGeometry.boundingBox!;
      const center = new THREE.Vector3();
      bbox.getCenter(center);

      // Store original position for placing edited mesh back in world
      previewState.originalCenter = center.clone();
      previewState.originalBaseZ = bbox.min.z;

      // Translate geometry: center in X/Y, place base on Z=0 plane
      const positions = foundGeometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < positions.count; i++) {
        positions.setX(i, positions.getX(i) - center.x);
        positions.setY(i, positions.getY(i) - center.y);
        positions.setZ(i, positions.getZ(i) - bbox.min.z); // Base at Z=0
      }
      positions.needsUpdate = true;
      foundGeometry.computeBoundingBox();
      foundGeometry.computeBoundingSphere(); // Critical: update bounding sphere for frustum culling
    }

    // Disable frustum culling to ensure mesh is always rendered
    mesh.frustumCulled = false;

    // Add wireframe overlay
    const wireframeMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      wireframe: true,
      transparent: true,
      opacity: 0.15,
    });
    const wireframe = new THREE.Mesh(foundGeometry, wireframeMaterial);
    wireframe.frustumCulled = false;

    // Group mesh and wireframe
    const group = new THREE.Group();
    group.add(mesh);
    group.add(wireframe);

    previewState.buildingMesh = group;
    previewState.scene.add(group);

    console.log(`  Mesh created and added to scene`);
    console.log(`  Group children: ${group.children.length}`);
    console.log(`  Mesh visible: ${mesh.visible}, geometry vertices: ${mesh.geometry.getAttribute("position")?.count}`);

    // Debug: verify bounding box after centering
    foundGeometry.computeBoundingBox();
    const debugBbox = foundGeometry.boundingBox!;
    console.log(`  After centering - BBox min: (${debugBbox.min.x.toFixed(1)}, ${debugBbox.min.y.toFixed(1)}, ${debugBbox.min.z.toFixed(1)})`);
    console.log(`  After centering - BBox max: (${debugBbox.max.x.toFixed(1)}, ${debugBbox.max.y.toFixed(1)}, ${debugBbox.max.z.toFixed(1)})`);

    // Fit camera to building
    const size = new THREE.Vector3();
    foundGeometry.boundingBox!.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = previewState.camera!.fov * (Math.PI / 180);
    const cameraDistance = Math.max(maxDim / (2 * Math.tan(fov / 2)) * 1.8, 20);

    // Position camera to view building from front-right, looking at center height
    const buildingCenterZ = size.z / 2;
    previewState.camera!.position.set(cameraDistance * 0.7, -cameraDistance * 0.7, buildingCenterZ + cameraDistance * 0.4);
    previewState.controls!.target.set(0, 0, buildingCenterZ);
    previewState.controls!.update();

    // Store geometry for editor
    previewState.buildingGeometry = foundGeometry;

    console.log(`Preview loaded: ${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}m`);
    console.log(`  Camera at: (${previewState.camera!.position.x.toFixed(1)}, ${previewState.camera!.position.y.toFixed(1)}, ${previewState.camera!.position.z.toFixed(1)})`);
    console.log(`  Looking at: (${previewState.controls!.target.x.toFixed(1)}, ${previewState.controls!.target.y.toFixed(1)}, ${previewState.controls!.target.z.toFixed(1)})`);
    console.log(`  Scene children: ${previewState.scene.children.length}`);
  } else {
    console.warn("Could not extract building geometry, showing placeholder");
    console.log(`  buildingMetadata available: ${!!viewerState.buildingMetadata}`);
    console.log(`  globalId: ${globalId}, osmId: ${osmId}`);
    console.log(`  customMeshes count: ${viewerState.customMeshes.size}`);
    console.log(`  buildingMeshes chunks: ${viewerState.buildingMeshes.size}`);

    // List available chunks for debugging
    if (viewerState.buildingMetadata) {
      const chunkIds = Object.keys(viewerState.buildingMetadata.chunks);
      console.log(`  Available chunks: ${chunkIds.join(", ")}`);
    }

    // Fallback: create a bright placeholder box (use BasicMaterial for max visibility)
    const geometry = new THREE.BoxGeometry(10, 10, 20);
    const material = new THREE.MeshBasicMaterial({ color: 0xff0000 }); // Bright red
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = 10;
    previewState.buildingMesh = mesh;
    previewState.scene.add(mesh);

    console.log(`  Added red placeholder box at position (0, 0, 10)`);

    previewState.camera!.position.set(30, 30, 30);
    previewState.controls!.target.set(0, 0, 10);
    previewState.controls!.update();
  }
}

/**
 * Toggle edit mode for the current building.
 */
function toggleEditMode(): void {
  if (!previewState.scene || !previewState.camera || !previewState.container) {
    return;
  }

  if (previewState.isEditMode) {
    // Exit edit mode
    closeMeshEditor();
    previewState.isEditMode = false;

    // Update UI
    const editBtn = document.getElementById("preview-edit-btn");
    if (editBtn) {
      editBtn.classList.remove("active");
      editBtn.title = "Edit Mesh";
    }

    const title = previewState.container.querySelector(".preview-title");
    if (title) {
      title.textContent = "Building Preview";
    }

    console.log("Exited mesh edit mode");
  } else {
    // Enter edit mode
    if (!previewState.buildingGeometry || !previewState.currentOsmId) {
      console.warn("No geometry available for editing");
      return;
    }

    // Get the preview content element for the editor UI
    const content = previewState.container.querySelector(".preview-content") as HTMLElement;
    if (!content) return;

    openMeshEditor(
      previewState.scene,
      previewState.camera,
      previewState.controls,
      previewState.buildingGeometry,
      previewState.currentOsmId,
      content,
      previewState.buildingMaterial // Pass the stored material
    );

    previewState.isEditMode = true;

    // Update UI
    const editBtn = document.getElementById("preview-edit-btn");
    if (editBtn) {
      editBtn.classList.add("active");
      editBtn.title = "Exit Edit Mode";
    }

    const title = previewState.container.querySelector(".preview-title");
    if (title) {
      title.textContent = "Building Preview - Edit Mode";
    }

    // Remove the preview mesh (editor has its own)
    if (previewState.buildingMesh) {
      previewState.scene.remove(previewState.buildingMesh);
      previewState.buildingMesh = null;
    }

    console.log("Entered mesh edit mode");
  }
}

/**
 * Reset the camera to default view.
 */
function resetView(): void {
  if (!previewState.camera || !previewState.controls || !previewState.buildingMesh) return;

  const bbox = new THREE.Box3().setFromObject(previewState.buildingMesh);
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = previewState.camera.fov * (Math.PI / 180);
  const cameraDistance = Math.max(maxDim / (2 * Math.tan(fov / 2)) * 1.8, 20);

  // Building is centered at X=0, Y=0 with base at Z=0
  const buildingCenterZ = size.z / 2;
  previewState.camera.position.set(cameraDistance * 0.7, -cameraDistance * 0.7, buildingCenterZ + cameraDistance * 0.4);
  previewState.controls.target.set(0, 0, buildingCenterZ);
  previewState.controls.update();
}

/**
 * Set up drag functionality for the window.
 */
function setupDragging(): void {
  const header = previewState.container?.querySelector(".preview-header") as HTMLElement;
  if (!header || !previewState.container) return;

  header.addEventListener("mousedown", (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === "BUTTON") return;

    previewState.isDragging = true;
    const rect = previewState.container!.getBoundingClientRect();
    previewState.dragOffset = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
    header.style.cursor = "grabbing";
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!previewState.isDragging || !previewState.container) return;

    const x = e.clientX - previewState.dragOffset.x;
    const y = e.clientY - previewState.dragOffset.y;

    previewState.container.style.left = `${x}px`;
    previewState.container.style.top = `${y}px`;
    previewState.container.style.right = "auto";
    previewState.container.style.bottom = "auto";
  });

  document.addEventListener("mouseup", () => {
    previewState.isDragging = false;
    if (header) header.style.cursor = "grab";
  });
}

/**
 * Set up resize functionality.
 */
function setupResizing(): void {
  const handle = previewState.container?.querySelector(".preview-resize-handle") as HTMLElement;
  if (!handle || !previewState.container) return;

  let isResizing = false;

  handle.addEventListener("mousedown", (e: MouseEvent) => {
    isResizing = true;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!isResizing || !previewState.container) return;

    const rect = previewState.container.getBoundingClientRect();
    const width = e.clientX - rect.left;
    const height = e.clientY - rect.top;

    previewState.container.style.width = `${Math.max(250, width)}px`;
    previewState.container.style.height = `${Math.max(200, height)}px`;

    resizePreview();
  });

  document.addEventListener("mouseup", () => {
    isResizing = false;
  });
}

/**
 * Open the preview window.
 */
export function openPreviewWindow(viewerState: ViewerState, osmId: number, globalId: number): void {
  const isFirstOpen = !previewState.container;

  if (isFirstOpen) {
    // Create window
    previewState.container = createPreviewWindow();
    document.getElementById("ui")?.appendChild(previewState.container);

    previewState.canvas = document.getElementById("preview-canvas") as HTMLCanvasElement;

    // Set up event listeners
    document.getElementById("preview-close-btn")?.addEventListener("click", closePreviewWindow);
    document.getElementById("preview-reset-btn")?.addEventListener("click", resetView);
    document.getElementById("preview-edit-btn")?.addEventListener("click", toggleEditMode);

    setupDragging();
    setupResizing();
  }

  // IMPORTANT: Show container BEFORE initializing Three.js scene
  // This ensures the canvas has proper dimensions (not 0x0)
  previewState.container!.classList.remove("hidden");
  previewState.isOpen = true;

  // Store reference to main viewer state
  previewState.mainViewerState = viewerState;

  // Initialize Three.js AFTER container is visible (first open only)
  if (isFirstOpen) {
    // Use requestAnimationFrame to ensure layout is complete
    requestAnimationFrame(() => {
      initPreviewScene();
      animatePreview();
      loadBuildingPreview(viewerState, osmId, globalId);
    });
  } else {
    // Start animation loop
    animatePreview();

    // Load the building
    loadBuildingPreview(viewerState, osmId, globalId);

    // Resize after showing (use rAF for reliable timing on mobile)
    requestAnimationFrame(resizePreview);
  }
}

/**
 * Close the preview window.
 */
export function closePreviewWindow(): void {
  // Close mesh editor if open
  if (previewState.isEditMode) {
    closeMeshEditor();
    previewState.isEditMode = false;
  }

  previewState.isOpen = false;

  if (previewState.animationId) {
    cancelAnimationFrame(previewState.animationId);
    previewState.animationId = null;
  }

  previewState.container?.classList.add("hidden");
}

/**
 * Check if preview window is open.
 */
export function isPreviewOpen(): boolean {
  return previewState.isOpen;
}

/**
 * Get current preview OSM ID.
 */
export function getPreviewOsmId(): number | null {
  return previewState.currentOsmId;
}

/**
 * Apply the edited mesh to the main scene, replacing the procedural building.
 * Called after saving a custom mesh.
 */
export function applyCustomMeshToMainScene(): boolean {
  const state = previewState.mainViewerState;
  const osmId = previewState.currentOsmId;

  if (!state || !osmId) {
    console.warn("Cannot apply custom mesh: missing viewer state or OSM ID");
    return false;
  }

  // Get the edited geometry from the editor
  const editorState = getEditorState();
  if (!editorState.workingGeometry) {
    console.warn("Cannot apply custom mesh: no edited geometry");
    return false;
  }

  // Get original position info
  const originalCenter = previewState.originalCenter;
  const originalBaseZ = previewState.originalBaseZ;

  if (!originalCenter) {
    console.warn("Cannot apply custom mesh: missing original position");
    return false;
  }

  // Clone the edited geometry
  const customGeometry = editorState.workingGeometry.clone();

  // Transform back to world coordinates
  const positions = customGeometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i++) {
    positions.setX(i, positions.getX(i) + originalCenter.x);
    positions.setY(i, positions.getY(i) + originalCenter.y);
    positions.setZ(i, positions.getZ(i) + originalBaseZ);
  }
  positions.needsUpdate = true;
  customGeometry.computeBoundingBox();
  customGeometry.computeBoundingSphere();
  customGeometry.computeVertexNormals();

  // Get material from editor or create new one
  const editorMaterial = editorState.workingMesh?.material as THREE.MeshStandardMaterial | undefined;
  const customMaterial = editorMaterial
    ? editorMaterial.clone()
    : new THREE.MeshStandardMaterial({
        color: 0x8b7355,
        roughness: 0.8,
        metalness: 0.1,
        side: THREE.DoubleSide,
      });

  // Create the custom mesh
  const customMesh = new THREE.Mesh(customGeometry, customMaterial);
  customMesh.name = `custom_building_${osmId}`;
  customMesh.userData.osmId = osmId;
  customMesh.userData.isCustomMesh = true;
  customMesh.castShadow = true;
  customMesh.receiveShadow = true;

  // Remove any existing custom mesh for this building
  const existingMesh = state.customMeshes.get(osmId);
  if (existingMesh) {
    state.scene.remove(existingMesh);
    existingMesh.geometry.dispose();
    if (Array.isArray(existingMesh.material)) {
      existingMesh.material.forEach(m => m.dispose());
    } else if (existingMesh.material instanceof THREE.Material) {
      existingMesh.material.dispose();
    }
  }

  // Add to scene and track
  state.scene.add(customMesh);
  state.customMeshes.set(osmId, customMesh);

  // Hide original building faces in the chunk mesh
  hideOriginalBuildingFaces(state, osmId);

  console.log(`Applied custom mesh for building ${osmId} to main scene`);
  return true;
}

/**
 * Hide the original building faces in the chunk mesh by moving them to a degenerate position.
 */
function hideOriginalBuildingFaces(state: ViewerState, osmId: number): void {
  const chunkInfo = previewState.buildingChunkInfo;
  if (!chunkInfo) {
    console.warn("No chunk info available for hiding original faces");
    return;
  }

  const { chunkId, startFace, endFace } = chunkInfo;
  const meshList = state.buildingMeshes.get(chunkId);

  if (!meshList || meshList.length === 0) {
    console.warn(`Chunk ${chunkId} not found in building meshes`);
    return;
  }

  const chunkMesh = meshList[0];
  const geometry = chunkMesh.geometry as THREE.BufferGeometry;
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.index;

  // Store the hiding info for potential restoration
  state.hiddenBuildingFaces.set(osmId, chunkInfo);

  if (index) {
    // Indexed geometry: move vertices to 0,0,0 (degenerate triangles)
    const verticesToHide = new Set<number>();
    for (let f = startFace; f < endFace; f++) {
      for (let v = 0; v < 3; v++) {
        verticesToHide.add(index.getX(f * 3 + v));
      }
    }

    // Note: This is destructive - ideally we'd store original positions
    // For now, we just move them far away (below terrain)
    for (const vertexIndex of verticesToHide) {
      positions.setZ(vertexIndex, -10000);
    }
  } else {
    // Non-indexed geometry
    const startVertex = startFace * 3;
    const endVertex = endFace * 3;
    for (let i = startVertex; i < endVertex; i++) {
      positions.setZ(i, -10000);
    }
  }

  positions.needsUpdate = true;
  console.log(`Hidden ${endFace - startFace} faces for building ${osmId} in chunk ${chunkId}`);
}

/**
 * Get the original building position for external use.
 */
export function getOriginalBuildingPosition(): { center: THREE.Vector3; baseZ: number } | null {
  if (!previewState.originalCenter) return null;
  return {
    center: previewState.originalCenter.clone(),
    baseZ: previewState.originalBaseZ,
  };
}
