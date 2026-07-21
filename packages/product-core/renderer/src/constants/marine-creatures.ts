// Why: the canonical list lives in packages/product-core/shared so the main process can use it
// too (auto-rename-from-work eligibility). Re-exported here to keep the
// existing `@/constants/marine-creatures` import path stable.
export { MARINE_CREATURES } from '../../../shared/marine-creatures'
