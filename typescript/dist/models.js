"use strict";
// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.BulkServiceData = void 0;
/**
 * Bulk-loaded configs, secrets, and active prompts for all tenants of a service.
 *
 * Returned by {@link HermesVault.preload} for service startup. Can be used
 * for logging or inspection without disturbing the pre-warmed cache.
 */
class BulkServiceData {
    /** Service name. */
    service;
    /** Per-tenant data keyed by tenant_id. */
    tenants;
    constructor(service, tenants) {
        this.service = service;
        this.tenants = tenants;
    }
    /**
     * Return the set of tenant IDs included in the bulk response.
     *
     * Useful for logging how many tenants were pre-warmed at startup.
     */
    tenantIds() {
        return new Set(Object.keys(this.tenants));
    }
}
exports.BulkServiceData = BulkServiceData;
