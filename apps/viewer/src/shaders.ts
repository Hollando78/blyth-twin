import * as THREE from "three";

// GPU highlight shader for footprints
export const footprintVertexShader = `
  attribute float _osm_id;
  varying float vOsmId;
  varying vec3 vColor;

  void main() {
    vOsmId = _osm_id;
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const footprintFragmentShader = `
  precision highp float;

  uniform float selectedOsmId;
  uniform float hoveredOsmId;
  uniform vec3 selectedColor;
  uniform vec3 hoveredColor;
  uniform float selectedOpacity;
  uniform float hoveredOpacity;
  uniform bool showZoneColors;
  uniform float zoneOpacity;

  varying float vOsmId;
  varying vec3 vColor;

  void main() {
    // Use relative comparison for large OSM IDs (float precision issue)
    // Two floats from same source should have same precision loss
    bool isSelected = selectedOsmId > 0.0 && abs(vOsmId - selectedOsmId) < 1.0;
    bool isHovered = hoveredOsmId > 0.0 && abs(vOsmId - hoveredOsmId) < 1.0;

    if (isSelected) {
      gl_FragColor = vec4(selectedColor, selectedOpacity);
    } else if (isHovered) {
      gl_FragColor = vec4(hoveredColor, hoveredOpacity);
    } else if (showZoneColors) {
      gl_FragColor = vec4(vColor, zoneOpacity);
    } else {
      discard;  // Invisible when not selected/hovered and zones off
    }
  }
`;

// Building shader with selection tint/emissive
// Uses building_index (small int per chunk) instead of osm_id (too large for float32)
export const buildingVertexShader = `
  attribute float _building_id;
  varying float vBuildingId;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;

  void main() {
    vBuildingId = _building_id;
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const buildingFragmentShader = `
  precision highp float;

  uniform sampler2D map;
  uniform bool hasMap;
  uniform vec3 baseColor;
  uniform float selectedBuildingId;
  uniform float hoveredBuildingId;
  uniform vec3 emissiveColor;
  uniform float time;

  varying float vBuildingId;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;

  void main() {
    // Base color from texture or solid color
    vec4 texColor = hasMap ? texture2D(map, vUv) : vec4(baseColor, 1.0);

    // Simple directional lighting
    vec3 lightDir = normalize(vec3(0.5, -0.5, 1.0));
    float diffuse = max(dot(vNormal, lightDir), 0.0);
    float ambient = 0.4;
    float lighting = ambient + diffuse * 0.6;

    vec3 finalColor = texColor.rgb * lighting;

    // Check for selection/hover (building IDs are small ints, use exact comparison)
    bool isSelected = selectedBuildingId >= 0.0 && abs(vBuildingId - selectedBuildingId) < 0.5;
    bool isHovered = hoveredBuildingId >= 0.0 && abs(vBuildingId - hoveredBuildingId) < 0.5;

    if (isSelected) {
      // Pulsing emissive glow for selected building
      float pulse = 0.5 + 0.5 * sin(time * 3.0);
      vec3 emissive = emissiveColor * pulse * 0.8;
      finalColor = finalColor + emissive;
      // Also tint slightly
      finalColor = mix(finalColor, emissiveColor, 0.2);
    } else if (isHovered) {
      // Subtle tint for hovered building
      finalColor = mix(finalColor, emissiveColor, 0.15);
    }

    gl_FragColor = vec4(finalColor, texColor.a);
  }
`;

// Uniform interfaces (index signature required by THREE.ShaderMaterial)
export interface FootprintUniforms {
  [uniform: string]: THREE.IUniform;
  selectedOsmId: { value: number };
  hoveredOsmId: { value: number };
  selectedColor: { value: THREE.Color };
  hoveredColor: { value: THREE.Color };
  selectedOpacity: { value: number };
  hoveredOpacity: { value: number };
  showZoneColors: { value: boolean };
  zoneOpacity: { value: number };
}

export interface BuildingShaderUniforms {
  [uniform: string]: THREE.IUniform;
  map: { value: THREE.Texture | null };
  hasMap: { value: boolean };
  baseColor: { value: THREE.Color };
  selectedBuildingId: { value: number };
  hoveredBuildingId: { value: number };
  emissiveColor: { value: THREE.Color };
  time: { value: number };
}

// Factory functions - create shared uniform instances
export function createFootprintUniforms(): FootprintUniforms {
  return {
    selectedOsmId: { value: 0.0 },
    hoveredOsmId: { value: 0.0 },
    selectedColor: { value: new THREE.Color(0x00ff00) },
    hoveredColor: { value: new THREE.Color(0xffff00) },
    selectedOpacity: { value: 0.6 },
    hoveredOpacity: { value: 0.4 },
    showZoneColors: { value: false },
    zoneOpacity: { value: 0.7 },
  };
}

export function createBuildingShaderUniforms(): BuildingShaderUniforms {
  return {
    map: { value: null },
    hasMap: { value: false },
    baseColor: { value: new THREE.Color(0x8b7355) },
    selectedBuildingId: { value: -1.0 },
    hoveredBuildingId: { value: -1.0 },
    emissiveColor: { value: new THREE.Color(0x00ffff) },
    time: { value: 0.0 },
  };
}
