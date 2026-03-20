/**
 * Proxy Cache Manager - Persistent proxy caching for domain-specific proxy selection
 *
 * Purpose:
 * - Cache domain -> working proxy mappings to avoid retry on every request
 * - Support auto mode: base proxy first, then upgrade to stealth on failure
 * - Support proxy-level failures: skip failed proxies within the same tier
 * - Persistent storage via Redis
 *
 * Use Cases:
 * 1. base mode: Multiple base proxies configured, rotate on failure, cache the working one
 * 2. stealth mode: Multiple stealth proxies, cache the working one
 * 3. auto mode: Start with base, upgrade to stealth on failure, cache the result
 *
 * Cache TTL Rationale:
 * - Domain cache: PERMANENT - proxy restrictions and working proxies are stable
 * - Proxy failures: 7 days - specific proxy failures may recover over time
 *
 * Update Policy:
 * - Record BOTH failures AND successes
 * - Success updates the "working proxy" for the domain
 * - Failure marks proxy as failed for 7 days
 */

import { log } from "@anycrawl/libs";
import type { ResolvedProxyMode } from "@anycrawl/libs";
import { Utils } from "../Utils.js";

export type { ResolvedProxyMode };

export type FailureReason =
  | 'cloudflare_challenge'
  | 'http_error'
  | 'timeout'
  | 'blocked'
  | 'proxy_error';

type CacheProxyModeInput = ResolvedProxyMode | 'auto';

/**
 * Domain-level cache entry
 * Stores the working proxy for a specific domain
 *
 * Structure:
 * - mode: 'base' | 'stealth' (recommended mode for this domain)
 * - workingProxyUrl: last successful proxy URL (for quick lookup)
 * - baseWorkingProxy: last successful base proxy (if mode=base)
 * - stealthWorkingProxy: last successful stealth proxy (if mode=stealth)
 */
export interface DomainCacheEntry {
  /** Current recommended proxy mode */
  mode: ResolvedProxyMode;

  /** Last working proxy URL for this domain (any mode) */
  workingProxyUrl?: string;

  /** Last working base proxy URL (cached separately) */
  baseWorkingProxy?: string;

  /** Last working stealth proxy URL (cached separately) */
  stealthWorkingProxy?: string;

  /** Last failure timestamp */
  lastFailureAt?: number;

  /** Last failure reason */
  lastFailureReason?: FailureReason;

  /** Total failure count */
  totalFailures: number;

  /** Last success timestamp */
  lastSuccessAt?: number;

  /** Expiration timestamp (ms) - 0 means permanent */
  expiresAt: number;

  /** Creation timestamp */
  createdAt: number;

  /** Update timestamp */
  updatedAt: number;

  /** First upgrade to stealth timestamp */
  firstStealthAt?: number;
}

/**
 * Proxy-level cache entry
 * Stores failure info for a specific (domain, proxyUrl) pair
 */
export interface ProxyCacheEntry {
  /** Failed proxy URL */
  proxyUrl: string;

  /** Last failure timestamp */
  lastFailureAt: number;

  /** Last failure reason */
  lastFailureReason: FailureReason;

  /** Failure count */
  failureCount: number;

  /** Expiration timestamp */
  expiresAt: number;
}

export interface ProxyCacheManagerOptions {
  /** Domain cache: permanent (no TTL) - proxy restrictions are permanent */
  domainTTL?: number;

  /** Proxy cache TTL in ms, default 7 days - specific proxy failures may vary */
  proxyTTL?: number;

  /** Failure threshold to upgrade to stealth, default 1 */
  failureThreshold?: number;

  /** Downshift test interval in ms, default 7 days */
  downshiftInterval?: number;

  /** Redis key prefix */
  redisKeyPrefix?: string;
}

const DEFAULT_OPTIONS: Required<ProxyCacheManagerOptions> = {
  domainTTL: 0, // permanent (no expiration) - proxy restrictions are permanent
  proxyTTL: 7 * 24 * 60 * 60 * 1000, // 7 days - specific proxy failures may vary
  failureThreshold: 1,
  downshiftInterval: 7 * 24 * 60 * 60 * 1000, // 7 days before testing downgrade to base
  redisKeyPrefix: 'anycrawl:proxy:cache:',
};

export class ProxyCacheManager {
  private static instance: ProxyCacheManager | null = null;

  private options: Required<ProxyCacheManagerOptions>;

  private constructor(options: ProxyCacheManagerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  static getInstance(options?: ProxyCacheManagerOptions): ProxyCacheManager {
    if (!this.instance) {
      this.instance = new ProxyCacheManager(options);
    }
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = null;
  }

  private generateDomainKey(domain: string): string {
    return `${this.options.redisKeyPrefix}domain:${domain}`;
  }

  private generateProxyKey(domain: string, proxyUrl: string): string {
    const proxyHash = Buffer.from(proxyUrl).toString('base64url');
    return `${this.options.redisKeyPrefix}proxy:${domain}:${proxyHash}`;
  }

  extractDomain(url: string): string | null {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return null;
    }
  }

  // ==================== Domain-level Operations ====================

  /**
   * Get cached working proxy for a specific mode (base or stealth) from Redis
   */
  async getWorkingProxyForMode(domain: string, mode: 'base' | 'stealth'): Promise<string | undefined> {
    const key = this.generateDomainKey(domain);
    const entry = await this.getDomainEntry(key);
    if (!entry) return undefined;
    return mode === 'base' ? entry.baseWorkingProxy : entry.stealthWorkingProxy;
  }

  /**
   * Get domain cache entry from Redis
   */
  async getDomainCacheEntry(domain: string): Promise<DomainCacheEntry | null> {
    const key = this.generateDomainKey(domain);
    return this.getDomainEntry(key);
  }

  /**
   * Record domain failure and potentially upgrade to stealth
   * Called for ALL proxy modes (base, stealth, auto)
   */
  async recordDomainFailure(
    domain: string,
    currentMode: CacheProxyModeInput,
    reason: FailureReason
  ): Promise<void> {
    if (currentMode === 'custom') return;

    const key = this.generateDomainKey(domain);
    const now = Date.now();
    const existing = await this.getDomainEntry(key);
    const newMode = this.computeNewMode(existing, currentMode, reason);

    const entry: DomainCacheEntry = {
      mode: newMode,
      lastFailureAt: now,
      lastFailureReason: reason,
      totalFailures: (existing?.totalFailures || 0) + 1,
      lastSuccessAt: existing?.lastSuccessAt,
      expiresAt: 0, // permanent - no expiration
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      firstStealthAt: existing?.firstStealthAt || (newMode === 'stealth' ? now : undefined),
    };

    // Persist to Redis (permanent, no TTL)
    await this.setDomainEntry(key, entry, 0);

    log.info(
      `[ProxyCache] Domain failure: ${domain} mode=${currentMode} ${reason}${existing && existing.mode !== newMode ? ` (${existing.mode} -> ${newMode})` : ''}, totalFailures=${entry.totalFailures}`
    );
  }

  /**
   * Record domain success - updates the working proxy for this domain
   * Called after a successful request to cache the working proxy
   *
   * Caches separately for base and stealth modes:
   * - If currentMode is 'base', updates baseWorkingProxy
   * - If currentMode is 'stealth', updates stealthWorkingProxy
   */
  async recordDomainSuccess(
    domain: string,
    proxyUrl: string,
    currentMode: ResolvedProxyMode
  ): Promise<void> {
    const key = this.generateDomainKey(domain);
    const now = Date.now();

    const existing = await this.getDomainEntry(key);

    const entry: DomainCacheEntry = {
      mode: currentMode,
      workingProxyUrl: proxyUrl,
      // Cache separately for each mode
      baseWorkingProxy: currentMode === 'base' ? proxyUrl : existing?.baseWorkingProxy,
      stealthWorkingProxy: currentMode === 'stealth' ? proxyUrl : existing?.stealthWorkingProxy,
      lastFailureAt: existing?.lastFailureAt,
      lastFailureReason: existing?.lastFailureReason,
      totalFailures: 0,
      lastSuccessAt: now,
      expiresAt: 0, // permanent
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      firstStealthAt: existing?.firstStealthAt || (currentMode === 'stealth' ? now : undefined),
    };

    // Persist to Redis (permanent, no TTL)
    await this.setDomainEntry(key, entry, 0);

    log.debug(`[ProxyCache] Domain success: ${domain} proxy=${proxyUrl} mode=${currentMode}`);
  }

  // ==================== Proxy-level Operations ====================

  /**
   * Record proxy failure (persist to Redis)
   */
  async recordProxyFailure(
    domain: string,
    proxyUrl: string,
    reason: FailureReason
  ): Promise<void> {
    const now = Date.now();
    const expiresAt = now + this.options.proxyTTL;

    // Persist to Redis
    const key = this.generateProxyKey(domain, proxyUrl);
    const entry: ProxyCacheEntry = {
      proxyUrl,
      lastFailureAt: now,
      lastFailureReason: reason,
      failureCount: 1,
      expiresAt,
    };

    try {
      const redis = Utils.getInstance().getRedisConnection();
      const ttlSeconds = Math.ceil((expiresAt - now) / 1000);
      await (redis as any).set(key, JSON.stringify(entry), 'EX', ttlSeconds);
    } catch (error) {
      log.warning(`[ProxyCache] Failed to persist proxy failure: ${error instanceof Error ? error.message : String(error)}`);
    }

    log.info(`[ProxyCache] Proxy failure: ${domain}@${proxyUrl} (${reason})`);
  }

  /**
   * Check whether a proxy is still in failure cooldown window
   */
  async isProxyFailureActive(domain: string, proxyUrl: string): Promise<boolean> {
    const key = this.generateProxyKey(domain, proxyUrl);

    try {
      const redis = Utils.getInstance().getRedisConnection();
      const data = await (redis as any).get(key);
      if (!data) return false;

      const entry: ProxyCacheEntry = JSON.parse(data);
      const expiresAt = Number(entry?.expiresAt);
      if (!Number.isFinite(expiresAt)) {
        return false;
      }

      const active = Date.now() < expiresAt;
      if (!active) {
        await this.delKey(key);
      }
      return active;
    } catch (error) {
      log.warning(`[ProxyCache] Failed to read proxy failure entry: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  clearProxyFailure(domain: string, proxyUrl: string): void {
    const key = this.generateProxyKey(domain, proxyUrl);
    Utils.getInstance().getRedisConnection()
      .del(key)
      .catch(() => { /* ignore */ });
  }

  // ==================== Utility Methods ====================

  async clear(domain: string): Promise<void> {
    const domainKey = this.generateDomainKey(domain);
    const proxyPattern = `${this.options.redisKeyPrefix}proxy:${domain}:*`;

    try {
      const redis = Utils.getInstance().getRedisConnection();
      await (redis as any).del(domainKey);

      const proxyKeys = await (redis as any).keys(proxyPattern);
      if (proxyKeys.length > 0) {
        await (redis as any).del(...proxyKeys);
      }

      log.info(`[ProxyCache] Cleared all cache for ${domain}`);
    } catch (error) {
      log.warning(`[ProxyCache] Failed to clear cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getStats(): Promise<{
    domainCount: number;
    stealthCount: number;
    baseCount: number;
    proxyFailureCount: number;
  }> {
    try {
      const redis = Utils.getInstance().getRedisConnection();

      const domainPattern = `${this.options.redisKeyPrefix}domain:*`;
      const domainKeys = await (redis as any).keys(domainPattern);

      let stealthCount = 0;
      let baseCount = 0;

      for (const key of domainKeys) {
        const data = await (redis as any).get(key);
        if (data) {
          const entry: DomainCacheEntry = JSON.parse(data);
          if (entry.mode === 'stealth') stealthCount++;
          else if (entry.mode === 'base') baseCount++;
        }
      }

      const proxyPattern = `${this.options.redisKeyPrefix}proxy:*`;
      const proxyKeys = await (redis as any).keys(proxyPattern);
      let proxyFailureCount = 0;
      const now = Date.now();

      for (const key of proxyKeys) {
        const data = await (redis as any).get(key);
        if (data) {
          const entry: ProxyCacheEntry = JSON.parse(data);
          if (now < entry.expiresAt) {
            proxyFailureCount++;
          }
        }
      }

      return { domainCount: domainKeys.length, stealthCount, baseCount, proxyFailureCount };
    } catch (error) {
      log.warning(`[ProxyCache] Failed to get stats: ${error instanceof Error ? error.message : String(error)}`);
      return { domainCount: 0, stealthCount: 0, baseCount: 0, proxyFailureCount: 0 };
    }
  }

  // ==================== Private Helper Methods ====================

  private async getDomainEntry(key: string): Promise<DomainCacheEntry | null> {
    try {
      const redis = Utils.getInstance().getRedisConnection();
      const data = await (redis as any).get(key);
      if (data) return JSON.parse(data);
    } catch (error) {
      log.warning(`[ProxyCache] Failed to read domain entry: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }

  private async setDomainEntry(key: string, entry: DomainCacheEntry, ttlSeconds?: number): Promise<void> {
    try {
      const redis = Utils.getInstance().getRedisConnection();
      if (ttlSeconds === 0) {
        // Permanent storage - no expiration
        await (redis as any).set(key, JSON.stringify(entry));
      } else {
        const actualTtl = ttlSeconds ?? Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
        if (actualTtl > 0) {
          await (redis as any).set(key, JSON.stringify(entry), 'EX', actualTtl);
        } else if (actualTtl === 0) {
          await (redis as any).set(key, JSON.stringify(entry));
        }
      }
    } catch (error) {
      log.warning(`[ProxyCache] Failed to write domain entry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async delKey(key: string): Promise<void> {
    try {
      const redis = Utils.getInstance().getRedisConnection();
      await (redis as any).del(key);
    } catch (error) {
      log.warning(`[ProxyCache] Failed to delete key: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private computeNewMode(
    existing: DomainCacheEntry | null,
    currentMode: CacheProxyModeInput,
    reason: FailureReason
  ): ResolvedProxyMode {
    // If already stealth, keep it
    if (existing?.mode === 'stealth') return 'stealth';

    // Auto mode: upgrade to stealth on first failure (don't continue trying base)
    if (currentMode === 'auto') {
      return 'stealth';
    }

    // Base mode: only upgrade on cloudflare/blocked
    if (currentMode === 'base') {
      if (reason === 'cloudflare_challenge' || reason === 'blocked') {
        return 'stealth';
      }
      // For other errors, stay on base but may switch proxy within tier
      return 'base';
    }

    // Stealth mode: stay on stealth
    return 'stealth';
  }
}
