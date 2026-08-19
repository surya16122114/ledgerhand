/**
 * Re-export of the artifact types.
 *
 * Exists so modules that need only the types do not pull in the zod schemas (and
 * therefore zod itself) at runtime. Small thing, but it keeps the surface and
 * replay layers importable from a context that has no validation dependency.
 */
export type {
  BusinessOutcomeDecl,
  Capability,
  CapabilityPolicy,
  ExtractTransform,
  Handler,
  HandlerAction,
  InputParam,
  Lifecycle,
  OutputField,
  Overlay,
  Provenance,
  Sensitivity,
  Step,
  StepAction,
  ValueSource,
} from './schema.js';
export type { Condition, RiskClass, SurfaceKind, TargetDescriptor, TargetStrategy } from '../surface/types.js';
