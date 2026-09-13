import { describe, it, expect, beforeEach, vi } from "vitest";

vi.unmock("./prisma");
vi.unmock("@/lib/prisma");

import {
  shouldLogQueries,
  resolveSlowQueryThreshold,
  normalizeQuery,
  createRecentQueryTracker,
  handlePrismaQueryEvent,
  DEFAULT_SLOW_QUERY_THRESHOLD_MS,
  type PrismaQueryEvent,
} from "./prisma";
import type { Logger } from "@/lib/logger";

describe("Prisma Development Query Logging", () => {
  describe("shouldLogQueries", () => {
    it("returns true when NODE_ENV is development", () => {
      expect(shouldLogQueries({ NODE_ENV: "development" })).toBe(true);
    });

    it("returns true when PRISMA_LOG_QUERIES is 'true'", () => {
      expect(shouldLogQueries({ NODE_ENV: "production", PRISMA_LOG_QUERIES: "true" })).toBe(true);
      expect(shouldLogQueries({ NODE_ENV: "test", PRISMA_LOG_QUERIES: "true" })).toBe(true);
    });

    it("returns false in production when PRISMA_LOG_QUERIES is not set", () => {
      expect(shouldLogQueries({ NODE_ENV: "production" })).toBe(false);
    });

    it("returns false in test when PRISMA_LOG_QUERIES is not set", () => {
      expect(shouldLogQueries({ NODE_ENV: "test" })).toBe(false);
    });
  });

  describe("resolveSlowQueryThreshold", () => {
    it("returns default threshold (100ms) when unset", () => {
      expect(resolveSlowQueryThreshold({})).toBe(DEFAULT_SLOW_QUERY_THRESHOLD_MS);
    });

    it("respects SLOW_QUERY_THRESHOLD_MS env override", () => {
      expect(resolveSlowQueryThreshold({ SLOW_QUERY_THRESHOLD_MS: "250" })).toBe(250);
    });

    it("falls back to default when SLOW_QUERY_THRESHOLD_MS is invalid", () => {
      expect(resolveSlowQueryThreshold({ SLOW_QUERY_THRESHOLD_MS: "invalid" })).toBe(
        DEFAULT_SLOW_QUERY_THRESHOLD_MS,
      );
      expect(resolveSlowQueryThreshold({ SLOW_QUERY_THRESHOLD_MS: "-10" })).toBe(
        DEFAULT_SLOW_QUERY_THRESHOLD_MS,
      );
    });
  });

  describe("normalizeQuery", () => {
    it("collapses multi-line whitespace and trims", () => {
      const raw = `
        SELECT id, name
        FROM "User"
        WHERE id = $1
      `;
      expect(normalizeQuery(raw)).toBe('SELECT id, name FROM "User" WHERE id = $1');
    });
  });

  describe("createRecentQueryTracker", () => {
    it("tracks query occurrences within the sliding window", () => {
      const tracker = createRecentQueryTracker({ windowMs: 2000, threshold: 3 });
      const query = 'SELECT * FROM "Repository" WHERE id = $1';

      const t0 = 10000;
      const r1 = tracker.recordQuery(query, t0);
      expect(r1.count).toBe(1);
      expect(r1.isRepeated).toBe(false);

      const r2 = tracker.recordQuery(query, t0 + 500);
      expect(r2.count).toBe(2);
      expect(r2.isRepeated).toBe(false);

      const r3 = tracker.recordQuery(query, t0 + 1000);
      expect(r3.count).toBe(3);
      expect(r3.isRepeated).toBe(true);
    });

    it("evicts timestamps outside the sliding window", () => {
      const tracker = createRecentQueryTracker({ windowMs: 2000, threshold: 3 });
      const query = 'SELECT * FROM "Repository" WHERE id = $1';

      tracker.recordQuery(query, 1000);
      tracker.recordQuery(query, 2000);

      // Query executed at t = 3500ms; t = 1000ms is now > 2000ms ago (3500 - 2000 = 1500)
      const r = tracker.recordQuery(query, 3500);
      expect(r.count).toBe(2); // Only t=2000 and t=3500
      expect(r.isRepeated).toBe(false);
    });

    it("prevents unbounded memory growth by respecting maxEntries", () => {
      const tracker = createRecentQueryTracker({ maxEntries: 2 });
      tracker.recordQuery("query-1", 1000);
      tracker.recordQuery("query-2", 1000);
      expect(tracker.size()).toBe(2);

      tracker.recordQuery("query-3", 1000);
      expect(tracker.size()).toBeLessThanOrEqual(2);
    });
  });

  describe("handlePrismaQueryEvent", () => {
    let tracker: ReturnType<typeof createRecentQueryTracker>;
    let mockLogger: {
      debug: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      tracker = createRecentQueryTracker({ windowMs: 2000, threshold: 3 });
      mockLogger = {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
    });

    it("logs regular fast queries at debug level", () => {
      const event: PrismaQueryEvent = {
        query: 'SELECT * FROM "User" WHERE id = $1',
        duration: 15,
      };

      handlePrismaQueryEvent(
        event,
        {
          slowThresholdMs: 100,
          tracker,
          logger: mockLogger as unknown as Logger,
        },
        1000,
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Prisma query (15ms)",
        expect.objectContaining({
          query: event.query,
          durationMs: 15,
        }),
      );
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("logs slow queries at warn level", () => {
      const event: PrismaQueryEvent = {
        query: 'SELECT * FROM "AuditLog" ORDER BY timestamp DESC',
        duration: 150,
      };

      handlePrismaQueryEvent(
        event,
        {
          slowThresholdMs: 100,
          tracker,
          logger: mockLogger as unknown as Logger,
        },
        1000,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Slow query detected: 150ms (threshold: 100ms)",
        expect.objectContaining({
          query: event.query,
          durationMs: 150,
        }),
      );
      expect(mockLogger.debug).not.toHaveBeenCalled();
    });

    it("logs repeated queries at warn level when threshold is reached", () => {
      const event: PrismaQueryEvent = {
        query: 'SELECT * FROM "Repository" WHERE id = $1',
        duration: 20,
      };

      const ctx = {
        slowThresholdMs: 100,
        tracker,
        logger: mockLogger as unknown as Logger,
      };

      handlePrismaQueryEvent(event, ctx, 1000);
      handlePrismaQueryEvent(event, ctx, 1200);
      expect(mockLogger.warn).not.toHaveBeenCalled();

      // Third execution triggers repeated query warning
      handlePrismaQueryEvent(event, ctx, 1400);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Repeated query detected (3x in 2000ms): 20ms",
        expect.objectContaining({
          query: event.query,
          durationMs: 20,
          repeatedCount: 3,
        }),
      );
    });
  });
});
