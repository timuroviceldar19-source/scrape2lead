import type { Lead } from "../types.js";
import type { IEnrichmentAdapter, EnrichmentRawResult } from "./adapters/EnrichmentAdapter.js";
import { validatePhone, validateAddress, validateWebsite } from "./validator.js";
import { calculateConfidenceScore } from "./scoring.js";
import type { Storage } from "../storage/storage.js";
import { logger } from "../logger.js";
import type { ProxyRotator } from "../proxy/proxyRotator.js";

export type EnrichmentMode = 'plan' | 'no-write' | 'write';

export interface EnrichmentDecision {
  crm_status: "Ready to contact" | "Needs manual review" | "Not enough data" | "Ready to call" | "Needs enrichment";
  next_action: string;
  enrichment_status: "enriched" | "manual_review" | "not_found" | "failed" | "pending";
  confidence_score: number;
  confidence_level: "high" | "medium" | "low";
  updated_lead: Partial<Lead>;
  isCaptchaOrBlocked?: boolean;
  // Preview fields for --no-write mode
  found_name?: string;
  phone_raw?: string | null;
  phone_normalized?: string | null;
  address_status?: "valid" | "invalid" | "empty";
  website_status?: "valid" | "invalid" | "empty";
  enrichment_error?: string;
}

export class EnrichmentProcessor {
  constructor(
    private readonly adapter: IEnrichmentAdapter,
    private readonly storage: Storage,
    private readonly proxyRotator?: ProxyRotator
  ) {}

  async processLead(lead: Lead, mode: EnrichmentMode = 'write'): Promise<EnrichmentDecision> {
    if (mode === 'plan') {
      logger.info("[PLAN] Would process lead", { company: lead.company_name, city: lead.city, lead_id: lead.lead_id || `${lead.source.toUpperCase()}-${lead.external_id}` });
      return {
        crm_status: (lead.crm_status as any) || "Needs enrichment",
        next_action: "Pending (Plan Mode)",
        enrichment_status: "pending",
        confidence_score: 0,
        confidence_level: "low",
        updated_lead: {}
      };
    }

    logger.info(mode === 'no-write' ? "[NO-WRITE] Starting enrichment for lead" : "Starting enrichment for lead", {
      company: lead.company_name,
      city: lead.city
    });

    try {
      // 1. Fetch raw data
      const rawResult = await this.adapter.enrich(lead);

      // 2. Handle failure states early
      if (rawResult.status === "unsupported_city" || rawResult.status === "failed" || rawResult.status === "captcha_or_blocked") {
        logger.warn(mode === 'no-write' ? "[NO-WRITE] Would mark as failed/blocked" : "Enrichment failed or blocked", { status: rawResult.status, error: rawResult.error_message });
        const decision = this.handleFailure(lead, rawResult);
        decision.found_name = rawResult.found_name;
        decision.phone_raw = rawResult.phone_raw;
        decision.enrichment_error = rawResult.error_message;
        if (mode === 'write') await this.persistDecision(lead, decision, rawResult);
        else this.logPreview(lead, decision);
        return decision;
      }

      if (rawResult.status === "not_found") {
        logger.info(mode === 'no-write' ? "[NO-WRITE] Would mark as not found" : "Enrichment not found", { company: lead.company_name });
        const decision = this.handleNotFound(lead);
        decision.found_name = rawResult.found_name;
        if (mode === 'write') await this.persistDecision(lead, decision, rawResult);
        else this.logPreview(lead, decision);
        return decision;
      }

      // 3. Validate
      const phoneValidation = validatePhone(rawResult.phone_raw);
      const addressValidation = validateAddress(rawResult.address_raw);
      const websiteValidation = validateWebsite(rawResult.website_raw);

      const hasValidSignal = phoneValidation.status === "valid" || websiteValidation.status === "valid";

      // 4. Score
      const metadata = (rawResult.raw_match_metadata as { category?: string; city?: string }) || {};
      const score = calculateConfidenceScore(
        lead.company_name,
        rawResult.found_name || "",
        lead.city,
        metadata.city || lead.city,
        lead.category || "",
        metadata.category || "",
        hasValidSignal
      );

      logger.info("Enrichment score calculated", { score: score.total, level: score.confidence_level, found_name: rawResult.found_name });

      // 5. Decide
      const decision = this.makeDecision(score, phoneValidation, addressValidation, websiteValidation, rawResult);

      // Attach preview fields
      decision.found_name = rawResult.found_name;
      decision.phone_raw = rawResult.phone_raw;
      decision.phone_normalized = phoneValidation.normalized;
      decision.address_status = addressValidation.status;
      decision.website_status = websiteValidation.status;

      // 6. Update DB or Log Preview
      if (mode === 'write') {
        await this.persistDecision(lead, decision, rawResult);
      } else {
        this.logPreview(lead, decision);
      }

      return decision;
    } finally {
      // 7. Tick the proxy rotator in `finally` so it fires for EVERY lead,
      //    including failed/throttled/not_found paths. Browser restarts
      //    (proxy swap) must not interrupt in-flight requests, so we tick
      //    after the per-lead work is done. The rotator is a no-op when
      //    neither `proxyApiUrl` nor `proxy` is configured.
      if (this.proxyRotator) {
        try {
          await this.proxyRotator.tick();
        } catch (error) {
          logger.warn("proxy rotator tick failed", {
            lead_id: lead.lead_id,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  }

  private logPreview(lead: Lead, decision: EnrichmentDecision): void {
    logger.info("[NO-WRITE] Decision preview", {
      lead_id: lead.lead_id || `${lead.source.toUpperCase()}-${lead.external_id}`,
      original_company: lead.company_name,
      found_name: decision.found_name,
      phone_raw: decision.phone_raw,
      phone_normalized: decision.phone_normalized,
      address_status: decision.address_status,
      website_status: decision.website_status,
      confidence_score: decision.confidence_score,
      decision: decision.crm_status,
      enrichment_status: decision.enrichment_status,
      enrichment_error: decision.enrichment_error
    });
  }

  private async persistDecision(lead: Lead, decision: EnrichmentDecision, rawResult: EnrichmentRawResult): Promise<void> {
    const leadId = lead.lead_id || `${lead.source.toUpperCase()}-${lead.external_id}`;
    
    // Extract validated fields
    const phoneValidation = validatePhone(rawResult.phone_raw);
    const addressValidation = validateAddress(rawResult.address_raw);
    const websiteValidation = validateWebsite(rawResult.website_raw);

    await this.storage.updateLeadEnrichment(leadId, {
      enrichment_source: rawResult.source,
      enrichment_url: rawResult.enrichment_url,
      confidence_score: decision.confidence_score,
      enrichment_status: decision.enrichment_status,
      enrichment_attempted_at: new Date().toISOString(),
      enrichment_error: decision.updated_lead.enrichment_error,
      phone_normalized: phoneValidation.normalized || undefined,
      phone_status: phoneValidation.status,
      address_clean: addressValidation.clean || undefined,
      address_status: addressValidation.status,
      real_website: websiteValidation.clean || undefined,
      website_status: websiteValidation.status,
      crm_status: decision.crm_status,
      next_action: decision.next_action
    });
  }

  private makeDecision(
    score: ReturnType<typeof calculateConfidenceScore>,
    _phone: ReturnType<typeof validatePhone>,
    _address: ReturnType<typeof validateAddress>,
    _website: ReturnType<typeof validateWebsite>,
    _raw: EnrichmentRawResult
  ): EnrichmentDecision {
    // Note: The decision logic strictly follows the confidence level,
    // as requested. The validated fields are applied via the DB update.
    let crm_status: EnrichmentDecision["crm_status"];
    let next_action: string;
    let enrichment_status: EnrichmentDecision["enrichment_status"];

    if (score.confidence_level === "high") {
      crm_status = "Ready to contact";
      next_action = "Позвонить";
      enrichment_status = "enriched";
    } else if (score.confidence_level === "medium") {
      crm_status = "Needs manual review";
      next_action = "Проверить совпадение компании вручную";
      enrichment_status = "manual_review";
    } else {
      crm_status = "Not enough data";
      next_action = "Поиск через Google или Instagram";
      enrichment_status = "not_found";
    }

    return {
      crm_status,
      next_action,
      enrichment_status,
      confidence_score: score.total,
      confidence_level: score.confidence_level,
      updated_lead: {} // Actual updates are handled directly in updateLeadEnrichment
    };
  }

  private handleFailure(lead: Lead, raw: EnrichmentRawResult): EnrichmentDecision {
    return {
      crm_status: (lead.crm_status as any) || "Needs enrichment",
      next_action: "Повторить попытку позже или использовать другой источник",
      enrichment_status: "failed",
      confidence_score: 0,
      confidence_level: "low",
      isCaptchaOrBlocked: raw.status === "captcha_or_blocked",
      updated_lead: {
        enrichment_status: "failed",
        enrichment_error: raw.error_message,
        enrichment_attempted_at: new Date().toISOString()
      }
    };
  }

  private handleNotFound(lead: Lead): EnrichmentDecision {
    return {
      crm_status: "Not enough data",
      next_action: "Поиск через Google или Instagram",
      enrichment_status: "not_found",
      confidence_score: 0,
      confidence_level: "low",
      updated_lead: {
        enrichment_status: "not_found",
        enrichment_attempted_at: new Date().toISOString()
      }
    };
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }
}
