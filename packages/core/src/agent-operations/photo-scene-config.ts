/**
 * Central configuration module for the photo-to-3D-room reconstruction pipeline
 * and walkthrough runtime.
 *
 * STANDARD FOR NO HARDCODING:
 * - This module MUST NOT contain any knowledge of what a specific room contains or looks like.
 * - NO sample rooms, default furniture types, default dimensions for specific items,
 *   or lists of object categories/kinds.
 * - ONLY physical tolerances, geometric solver limits, UI/payload limits, and performance budgets
 *   are permitted here, with explicit units and rationales.
 */

// ================================================================================================
// Physical Tolerances & Geometric Solver Parameters
// ================================================================================================

/**
 * Clearance from the inside face of a wall to any placed object, in metres.
 * Accounts for baseboards, wall trims, and measurement uncertainty.
 */
export const WALL_CLEARANCE_METRES = 0.025

/**
 * Maximum depth (in metres) by which two furniture footprints may touch or overlap
 * before being classified as an intersection. In real rooms, objects frequently touch
 * (e.g. nightstand touching a bed frame), and photo-inferred estimates have 2-3 cm uncertainty.
 */
export const OVERLAP_TOLERANCE_METRES = 0.03

/**
 * Extra separation gap (in metres) applied when pushing overlapping objects apart
 * in the layout solver, preventing numerical jitter from re-triggering overlap.
 */
export const SEPARATION_MARGIN_METRES = 0.005

/**
 * Minimum overlap penetration (in metres) that triggers a separation push in the layout solver.
 * Overlaps smaller than this are within expected photo estimation tolerance.
 */
export const SEPARATION_TOLERANCE_METRES = 0.01

/**
 * Maximum inward displacement (in metres) applied automatically to pull a slightly
 * out-of-bounds object inside the room polygon. Beyond this threshold, the observation
 * is geometrically inconsistent rather than merely noisy.
 */
export const MAX_AUTO_FIT_METRES = 0.2

/**
 * Maximum total displacement (in metres) that the layout relaxation solver may move an
 * object from its photo-estimated position. Preserves spatial fidelity to the photographs.
 */
export const MAX_LAYOUT_SHIFT_METRES = 0.8

/**
 * Maximum iterations for the iterative layout relaxation solver.
 */
export const LAYOUT_SOLVER_ITERATIONS = 60

/**
 * Clear floor depth (in metres) required in front of an outward-swinging door landing.
 * Inward-swinging doors use their actual swing width.
 */
export const OUTWARD_DOOR_CLEAR_METRES = 0.35

/**
 * Maximum ratio between the horizontal footprint area of a placed object and the supporting
 * object beneath it when resting on a surface. Prevents large objects from stacking on smaller ones.
 */
export const MAX_STACK_AREA_RATIO = 0.35

/**
 * Tolerance (in metres) when projecting an opening's position onto its declared wall segment.
 */
export const OPENING_POSITION_TOLERANCE_METRES = 0.025

/**
 * Minimum allowable room polygon area in square metres.
 */
export const MIN_POLYGON_AREA_SQ_METRES = 0.01

/**
 * Minimum allowable wall edge length in metres.
 */
export const MIN_EDGE_LENGTH_METRES = 0.01

// ================================================================================================
// Ingestion & UI Limits
// ================================================================================================

/** Maximum number of photos accepted for room reconstruction in a single session. */
export const MAX_INPUT_IMAGES = 6

/** Maximum allowed byte size for an individual uploaded photo file (2 MiB). */
export const MAX_IMAGE_FILE_BYTES = 2 * 1024 * 1024

/** Maximum allowed HTTP request body size for photo inference (18 MiB). */
export const MAX_REQUEST_BODY_BYTES = 18 * 1024 * 1024

/** Target maximum width in pixels when resizing photos before upload. */
export const IMAGE_RESIZE_MAX_WIDTH = 1600

/** Target maximum height in pixels when resizing photos before upload. */
export const IMAGE_RESIZE_MAX_HEIGHT = 1200

/** Initial JPEG compression quality when resizing images. */
export const INITIAL_IMAGE_COMPRESSION_QUALITY = 0.86

/** Compression quality reduction step when retrying image file size reduction. */
export const IMAGE_COMPRESSION_QUALITY_STEP = 0.12

// ================================================================================================
// Walkthrough & Performance Parameters
// ================================================================================================

/**
 * Visual room magnification factor applied to site scale during walkthrough.
 * Expands the subjective interior volume without mutating saved architectural measurements.
 * Value 1.0 disables scaling.
 */
export const WALKTHROUGH_ROOM_SCALE = 1.4

/**
 * Cadence (in frames) for sampling floor and zone labels in the first-person HUD.
 * Prevents running spatial point-in-polygon queries every frame.
 */
export const HUD_LABEL_SAMPLE_INTERVAL_FRAMES = 10

/**
 * Cadence (in frames) for raycasting interactable doors, windows, and mechanisms.
 * Throttles raycasting and matrix updates from running uncapped every animation frame.
 */
export const INTERACTION_SAMPLE_INTERVAL_FRAMES = 4

/**
 * Maximum reach distance (in metres) for the first-person crosshair to interact with objects.
 */
export const INTERACTION_MAX_DISTANCE_METRES = 2.5

/**
 * Maximum wall-clock time (in milliseconds) the Viewer will wait for scene geometry,
 * models, and textures to settle before signaling scene ready.
 */
export const SCENE_READY_MAX_WAIT_MS = 45_000

/**
 * Fallback timeout (in milliseconds) after which the editor shell displays anyway
 * if the Viewer has not settled. Must be strictly greater than SCENE_READY_MAX_WAIT_MS.
 */
export const SCENE_READY_FALLBACK_MS = 60_000

/**
 * Target minimum unique frame rate budget during first-person walkthrough movement (fps).
 */
export const PERF_TARGET_FPS = 45

/**
 * Maximum allowable single frame stall duration during walkthrough movement (milliseconds).
 */
export const PERF_MAX_STALL_MS = 100
