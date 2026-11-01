# Implementation Plan: Faithful Photo-to-3D-Room Reconstruction and Smooth Walkthrough

## 1. Principles and "No Hardcoding" Standard
- Zero baked-in knowledge about room contents: no closed category enums, no compatibility regex tables, no asset-id-specific colors or slots, no hardcoded dimension bounds (e.g. 20x10x20m limits or example numbers in prompts), no lists of "standard sized" objects.
- All physical tolerances, performance budgets, and UI limits live strictly in a single module: `packages/core/src/agent-operations/photo-scene-config.ts`.
- Everything about the room comes from the images and user measurements. Everything about assets comes from the catalog's own metadata.

## 2. Workstream Breakdown

### Workstream E (Foundation): Centralized Configuration & Guardrails
1. Create `packages/core/src/agent-operations/photo-scene-config.ts` defining:
   - Physical tolerances (wall clearances, overlap tolerance, separation margins, max shift, iteration counts).
   - UI limits (max photos, max upload size, dimensions).
   - Walkthrough performance budgets and constants (interaction reach, room scale, frame budget).
2. Create anti-hardcoding test `packages/core/src/agent-operations/photo-scene-no-hardcoding.test.ts`:
   - Scans photo pipeline source files to ensure no hardcoded asset IDs, closed category lists, regex tables, or room-type heuristics are introduced.

### Workstream A: Verifiable Multi-Stage Vision Pipeline
1. Redesign `photo-scene-plan.ts` schema:
   - Replace closed `PHOTO_OBJECT_CATEGORIES` with open-vocabulary string `name`/`objectType`.
   - Add `mounting: 'floor' | 'wall' | 'ceiling' | 'on-surface'`.
   - Add `restsOn?: string` referencing supporting object ID.
   - Per-object visible evidence: bounding box, visible materials, colors, textures/patterns.
   - Backward compatibility: Migrate legacy category-based plans gracefully.
2. Multi-stage analyzer pipeline:
   - Stage 1: Per-image observation (bounding boxes, open vocabulary, visible materials/colors, facing, surface contact).
   - Stage 2: Cross-view association (merging sightings across photos with evidence trails).
   - Stage 3: Room geometry recovery (simple polygon, wall heights, openings).
   - Stage 4: Scale estimation (user measurement preferred, or robust median from matched references with uncertainty).
   - Stage 5: Appearance extraction (color extraction from bounding box pixel samples, not hallucinated hex codes).
   - Stage 6: Self-check pass (plan verification against observations).
3. Update `gemini-photo-vision-provider.ts` and `photo-scene-vision-adapter.ts` to implement structured multi-pass inference with catalog manifest.

### Workstream B: Data-Driven Catalog Mapping & Stand-ins
1. Compact catalog manifest generation at request time from `CATALOG_ITEMS`:
   - Extracts id, name, category, tags, dimensions, attachTo, surface, and material slot metadata.
2. Data-driven asset ranking:
   - Token overlap with TF-IDF weights over catalog tags/names + footprint/aspect similarity.
   - Zero regex tables, zero asset-id-specific code.
3. Appearance transfer:
   - Dynamic slot assignment using discovered asset slots or native material inputs.
4. Procedural stand-ins:
   - When no catalog item fits, generate a native procedural node (`procedural-item`, `block`, `shelf`, `cabinet`) with observed dimensions, colors, and textures.
   - Report clearly in UI as stand-in and record catalog gap.

### Workstream C: Evidence-Driven Placement & Layout
1. Facing & orientation:
   - Convert observed facing to yaw using explicit tested conventions.
   - Add comprehensive unit tests for all wall orientations and rotation cases.
2. Contact-based wall snapping:
   - Only snap flush if wall contact was observed.
3. Layout solver:
   - Drive stacking from `restsOn` and `mounting: 'on-surface'`.
   - Drive clearances from door swing directions (inward vs outward).
   - Update `photo-object-fit.ts` and `photo-scene-executor.ts` to use config tolerances.

### Workstream D: Walkthrough Performance & Stability
1. Optimization of `first-person-controls.tsx`:
   - Throttle/memoize `resolveInteractableTarget`.
   - Eliminate per-frame matrix allocations (`new Matrix4()`, etc.).
   - Coalesce and debounce `rebuildColliderWorld`.
   - Remove per-frame `Object.values(nodes)` allocations in `setRoomScale`.
   - Guard `useFirstPersonHud.getState().setHud` with shallow comparison to avoid per-frame state writes.
2. WebGPU stability & Error Recovery:
   - Fix `SiteRenderer` cleanup: safely dispose geometries without triggering unhandled WebGPU buffer destroy errors.
   - Add device lost recovery in `packages/viewer/src/components/viewer/index.tsx`.
   - Provide clean fallback to WebGL if WebGPU is lost or unavailable.
   - Adjust SSGI/denoise parameters to eliminate wall blotch artifacts.
   - Provide `disablePostFx` option in walkthrough.
   - Honor `sceneReadyMaxWaitMs` and `SCENE_READY_FALLBACK_MS`.
3. 3D Labels:
   - Ensure 3D measurement labels are gated off via `SHOW_3D_MEASUREMENTS`.
4. Performance overlay:
   - Ensure `?perf` overlay measures frame times (p50/p95/p99), draw calls, and collider rebuild times.

### Workstream F: Verification & Testing
1. Unit tests for pure functions (geometry, layout, ranking, config guardrails).
2. Fixture room test cases with expected plan fidelity.
3. Type-check, Biome lint, and production build verification.
