import { beforeEach, describe, expect, it, vi } from "vitest";
import { budgetService } from "../services/budgets.ts";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

type SelectResult = unknown[];

function createDbStub(selectResults: SelectResult[]) {
  const pendingSelects = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectThen = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pendingSelects.shift() ?? [])));
  const selectOrderBy = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectFrom = vi.fn(() => ({
    where: selectWhere,
    then: selectThen,
    orderBy: selectOrderBy,
  }));
  const select = vi.fn(() => ({
    from: selectFrom,
  }));

  const insertValues = vi.fn();
  const insertReturning = vi.fn(async () => pendingInserts.shift() ?? []);
  const insert = vi.fn(() => ({
    values: insertValues.mockImplementation(() => ({
      returning: insertReturning,
    })),
  }));

  const updateSet = vi.fn();
  const updateWhere = vi.fn(async () => pendingUpdates.shift() ?? []);
  const update = vi.fn(() => ({
    set: updateSet.mockImplementation(() => ({
      where: updateWhere,
    })),
  }));

  const pendingInserts: unknown[][] = [];
  const pendingUpdates: unknown[][] = [];

  return {
    db: {
      select,
      insert,
      update,
    },
    queueInsert: (rows: unknown[]) => {
      pendingInserts.push(rows);
    },
    queueUpdate: (rows: unknown[] = []) => {
      pendingUpdates.push(rows);
    },
    selectWhere,
    insertValues,
    updateSet,
  };
}

describe("budgetService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a hard-stop incident and pauses an agent when spend exceeds a budget", async () => {
    const policy = {
      id: "policy-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const dbStub = createDbStub([
      [policy],
      [{ total: 150 }],
      [],
      [{
        companyId: "company-1",
        name: "Budget Agent",
        status: "running",
        pauseReason: null,
      }],
    ]);

    dbStub.queueInsert([{
      id: "approval-1",
      companyId: "company-1",
      status: "pending",
    }]);
    dbStub.queueInsert([{
      id: "incident-1",
      companyId: "company-1",
      policyId: "policy-1",
      approvalId: "approval-1",
    }]);
    dbStub.queueUpdate([]);
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);

    const service = budgetService(dbStub.db as any, { cancelWorkForScope });
    await service.evaluateCostEvent({
      companyId: "company-1",
      agentId: "agent-1",
      projectId: null,
    } as any);

    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        type: "budget_override_required",
        status: "pending",
      }),
    );
    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        policyId: "policy-1",
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 150,
        approvalId: "approval-1",
      }),
    );
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        pauseReason: "budget",
        pausedAt: expect.any(Date),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "budget.hard_threshold_crossed",
        entityId: "incident-1",
      }),
    );
    expect(cancelWorkForScope).toHaveBeenCalledWith({
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
    });
  });

  it("blocks new work when an agent hard-stop remains exceeded even if the agent is not paused yet", async () => {
    const agentPolicy = {
      id: "policy-agent-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };

    const dbStub = createDbStub([
      [{
        status: "running",
        pauseReason: null,
        companyId: "company-1",
        name: "Budget Agent",
      }],
      [{
        status: "active",
        name: "Paperclip",
      }],
      [],
      [agentPolicy],
      [{ total: 120 }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toEqual({
      scopeType: "agent",
      scopeId: "agent-1",
      scopeName: "Budget Agent",
      reason: "Agent cannot start because its budget hard-stop is still exceeded.",
    });
  });

  it("surfaces a budget-owned company pause distinctly from a manual pause", async () => {
    const dbStub = createDbStub([
      [{
        status: "idle",
        pauseReason: null,
        companyId: "company-1",
        name: "Budget Agent",
      }],
      [{
        status: "paused",
        pauseReason: "budget",
        name: "Paperclip",
      }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toEqual({
      scopeType: "company",
      scopeId: "company-1",
      scopeName: "Paperclip",
      reason: "Company is paused because its budget hard-stop was reached.",
    });
  });

  it("uses live observed spend when raising a budget incident", async () => {
    const dbStub = createDbStub([
      [{
        id: "incident-1",
        companyId: "company-1",
        policyId: "policy-1",
        amountObserved: 120,
        approvalId: "approval-1",
      }],
      [{
        id: "policy-1",
        companyId: "company-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
      }],
      [{ total: 150 }],
    ]);

    const service = budgetService(dbStub.db as any);

    await expect(
      service.resolveIncident(
        "company-1",
        "incident-1",
        { action: "raise_budget_and_resume", amount: 140 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");
  });

  it("syncs company monthly budget when raising and resuming a company incident", async () => {
    const now = new Date();
    const dbStub = createDbStub([
      [{
        id: "incident-1",
        companyId: "company-1",
        policyId: "policy-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        windowStart: now,
        windowEnd: now,
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 120,
        status: "open",
        approvalId: "approval-1",
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      }],
      [{
        id: "policy-1",
        companyId: "company-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
      }],
      [{ total: 120 }],
      [{ id: "approval-1", status: "approved" }],
      [{
        companyId: "company-1",
        name: "Paperclip",
        status: "paused",
        pauseReason: "budget",
        pausedAt: now,
      }],
    ]);

    const service = budgetService(dbStub.db as any);
    await service.resolveIncident(
      "company-1",
      "incident-1",
      { action: "raise_budget_and_resume", amount: 175 },
      "board-user",
    );

    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetMonthlyCents: 175,
        updatedAt: expect.any(Date),
      }),
    );
  });

  it("does not act on a non-terminal heartbeat run", async () => {
    const dbStub = createDbStub([]);

    const service = budgetService(dbStub.db as any);
    await service.evaluateHeartbeatRunFinalized({
      companyId: "company-1",
      agentId: "agent-1",
      status: "running",
    });

    expect(dbStub.db.select).not.toHaveBeenCalled();
  });

  it("creates a hard-stop incident and pauses an agent when heartbeat-count cap is reached", async () => {
    const policy = {
      id: "policy-hb-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "heartbeat_count",
      windowKind: "calendar_day_utc",
      amount: 20,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const dbStub = createDbStub([
      [policy],
      [{ total: 20 }],
      [],
      [{
        companyId: "company-1",
        name: "Compliance-1",
        status: "running",
        pauseReason: null,
      }],
    ]);

    dbStub.queueInsert([{
      id: "approval-hb-1",
      companyId: "company-1",
      status: "pending",
    }]);
    dbStub.queueInsert([{
      id: "incident-hb-1",
      companyId: "company-1",
      policyId: "policy-hb-1",
      approvalId: "approval-hb-1",
    }]);
    dbStub.queueUpdate([]);
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);

    const service = budgetService(dbStub.db as any, { cancelWorkForScope });
    await service.evaluateHeartbeatRunFinalized({
      companyId: "company-1",
      agentId: "agent-1",
      status: "succeeded",
    });

    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        type: "budget_override_required",
        status: "pending",
      }),
    );
    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        policyId: "policy-hb-1",
        thresholdType: "hard",
        amountLimit: 20,
        amountObserved: 20,
        approvalId: "approval-hb-1",
      }),
    );
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        pauseReason: "budget",
        pausedAt: expect.any(Date),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "budget.hard_threshold_crossed",
        entityId: "incident-hb-1",
        details: expect.objectContaining({
          metric: "heartbeat_count",
          windowKind: "calendar_day_utc",
        }),
      }),
    );
    expect(cancelWorkForScope).toHaveBeenCalledWith({
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
    });
  });

  /**
   * F-113 (THE-643): worst-case race at the cap boundary.
   *
   * Scenario: cap=20. Heartbeat run #20 and run #21 finalize within milliseconds
   * of each other.  Both `evaluateHeartbeatRunFinalized` invocations read
   * `count=20` before either commits the pause (stale read — pause txn from the
   * other path has not yet flushed).  Both must independently take the
   * hard-stop branch: queue an approval, write an incident, pause the agent
   * via `update(agents)`, and call `cancelWorkForScope`.
   *
   * On the real DB this is idempotent: `SELECT ... FOR UPDATE` serialises the
   * pause txn, and the second pause is a no-op (status is already "paused" so
   * the `inArray(agents.status, ["active","idle","running","error"])` guard
   * filters it out).  Each call must independently *try* the pause — that is
   * what this test asserts.
   */
  it("F-113: both concurrent heartbeat finalizations at the cap boundary trigger hard-stop (race: stale count=cap on both paths)", async () => {
    const makePolicy = () => ({
      id: "policy-hb-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "heartbeat_count",
      windowKind: "calendar_day_utc",
      amount: 20,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    });

    const makeStub = (approvalId: string, incidentId: string) => {
      const dbStub = createDbStub([
        [makePolicy()],
        [{ total: 20 }], // stale read — concurrent path has not yet committed its pause
        [],
        [{
          companyId: "company-1",
          name: "Compliance-1",
          status: "running",
          pauseReason: null,
        }],
      ]);
      dbStub.queueInsert([{ id: approvalId, companyId: "company-1", status: "pending" }]);
      dbStub.queueInsert([{
        id: incidentId,
        companyId: "company-1",
        policyId: "policy-hb-1",
        approvalId,
      }]);
      dbStub.queueUpdate([]);
      return dbStub;
    };

    const cancelWorkForScope1 = vi.fn().mockResolvedValue(undefined);
    const cancelWorkForScope2 = vi.fn().mockResolvedValue(undefined);

    const stub1 = makeStub("approval-race-1", "incident-race-1");
    const stub2 = makeStub("approval-race-2", "incident-race-2");

    const service1 = budgetService(stub1.db as any, { cancelWorkForScope: cancelWorkForScope1 });
    const service2 = budgetService(stub2.db as any, { cancelWorkForScope: cancelWorkForScope2 });

    await Promise.all([
      service1.evaluateHeartbeatRunFinalized({
        companyId: "company-1",
        agentId: "agent-1",
        status: "succeeded",
      }),
      service2.evaluateHeartbeatRunFinalized({
        companyId: "company-1",
        agentId: "agent-1",
        status: "succeeded",
      }),
    ]);

    // Both paths must reach the pause UPDATE — real DB makes the second a no-op.
    expect(stub1.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused", pauseReason: "budget" }),
    );
    expect(stub2.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused", pauseReason: "budget" }),
    );
    // Both paths must enqueue scope cancel — cancelWorkForScope is idempotent.
    expect(cancelWorkForScope1).toHaveBeenCalledWith({
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
    });
    expect(cancelWorkForScope2).toHaveBeenCalledWith({
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
    });
  });

  /**
   * F-113 (THE-643): +1–2 overrun bound after a boundary race.
   *
   * The race can lose at most 2 finalize events to stale reads before the pause
   * txn commits (one in-flight when the cap is hit, plus one that started
   * concurrently).  After both commit, the heartbeat_runs count reflects
   * `cap+2`.  The next finalize-eval must still take the hard-stop branch and
   * the incident must record `amountObserved = cap+2` — not `cap` — so the
   * overrun is auditable.
   *
   * This test pins that bound: with `total=22` (cap=20 + 2), the system writes
   * a hard incident with `amountObserved: 22`, queues the approval, pauses the
   * agent, and cancels in-flight work.  If the bound widens beyond +2 this
   * test still passes (the system tolerates arbitrary overrun), but any silent
   * regression that *drops* the overrun-aware incident write would fail here.
   */
  it("F-113: records the actual count when finalize sees count=cap+2 (worst-case post-race state, +1–2 overrun bound)", async () => {
    const policy = {
      id: "policy-hb-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "heartbeat_count",
      windowKind: "calendar_day_utc",
      amount: 20,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const dbStub = createDbStub([
      [policy],
      [{ total: 22 }], // worst-case post-race overrun: cap=20 + 2 lost-to-race finalizes
      [],
      [{
        companyId: "company-1",
        name: "Compliance-1",
        status: "running",
        pauseReason: null,
      }],
    ]);
    dbStub.queueInsert([{
      id: "approval-overrun",
      companyId: "company-1",
      status: "pending",
    }]);
    dbStub.queueInsert([{
      id: "incident-overrun",
      companyId: "company-1",
      policyId: "policy-hb-1",
      approvalId: "approval-overrun",
    }]);
    dbStub.queueUpdate([]);
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);

    const service = budgetService(dbStub.db as any, { cancelWorkForScope });
    await service.evaluateHeartbeatRunFinalized({
      companyId: "company-1",
      agentId: "agent-1",
      status: "succeeded",
    });

    // Incident must record the actual overrun amount, not just the cap.
    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        policyId: "policy-hb-1",
        thresholdType: "hard",
        amountLimit: 20,
        amountObserved: 22,
        approvalId: "approval-overrun",
      }),
    );
    // Pause + cancel still fire on the overrun read — the +1–2 bound does not
    // weaken enforcement.
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        pauseReason: "budget",
        pausedAt: expect.any(Date),
      }),
    );
    expect(cancelWorkForScope).toHaveBeenCalledWith({
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
    });
  });

  it("blocks new work when an agent heartbeat-count cap is still exceeded", async () => {
    const policy = {
      id: "policy-hb-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "heartbeat_count",
      windowKind: "calendar_day_utc",
      amount: 20,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };

    const dbStub = createDbStub([
      [{
        status: "running",
        pauseReason: null,
        companyId: "company-1",
        name: "Compliance-1",
      }],
      [{
        status: "active",
        name: "Paperclip",
      }],
      [],
      [policy],
      [{ total: 20 }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toEqual({
      scopeType: "agent",
      scopeId: "agent-1",
      scopeName: "Compliance-1",
      reason: "Agent cannot start because its budget hard-stop is still exceeded.",
    });
  });

  it("F-111: does NOT auto-resume a budget-paused agent when operator has set manualPauseOverride", async () => {
    // Scenario: budget paused agent, operator also explicitly paused (manualPauseOverride=true),
    // then budget window resets — agent must stay paused despite observed < amount.
    const policy = {
      id: "policy-hb-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "heartbeat_count",
      windowKind: "calendar_day_utc",
      amount: 20,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };

    const dbStub = createDbStub([
      [{
        status: "paused",
        pauseReason: "budget",
        manualPauseOverride: true,
        companyId: "company-1",
        name: "Compliance-1",
      }],
      [{ status: "active", name: "Paperclip" }],
      [],
      [policy],
      [{ total: 0 }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    // Budget block is cleared (window reset), so getInvocationBlock returns null.
    expect(block).toBeNull();

    // resumeScopeFromBudget IS called, but its WHERE clause now includes
    // `eq(agents.manualPauseOverride, false)`.  In a real DB that WHERE
    // condition would match 0 rows (override=true) so the agent stays paused.
    // Here we confirm the set call happened for the resume path…
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "idle", pauseReason: null }),
    );
    // …and that the WHERE arg passed to the chained where() references the
    // manualPauseOverride column guard in its Drizzle SQL expression tree.
    const whereSpyFn = dbStub.updateSet.mock.results[0]?.value?.where as ReturnType<typeof vi.fn>;
    expect(whereSpyFn).toBeDefined();
    const whereCondition = whereSpyFn?.mock?.calls?.[0]?.[0];
    expect(whereCondition).toBeDefined();
    // Drizzle SQL expressions are circular; walk with a visited-set guard.
    function containsColumn(node: unknown, col: string, visited = new WeakSet()): boolean {
      if (!node || typeof node !== "object") return false;
      if (visited.has(node as object)) return false;
      visited.add(node as object);
      const obj = node as Record<string, unknown>;
      if (typeof obj["name"] === "string" && obj["name"] === col) return true;
      return Object.values(obj).some((v) => containsColumn(v, col, visited));
    }
    expect(containsColumn(whereCondition, "manual_pause_override")).toBe(true);
  });

  it("lazy-unblocks a budget-paused agent once its heartbeat-count window resets", async () => {
    const policy = {
      id: "policy-hb-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "heartbeat_count",
      windowKind: "calendar_day_utc",
      amount: 20,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };

    const dbStub = createDbStub([
      [{
        status: "paused",
        pauseReason: "budget",
        companyId: "company-1",
        name: "Compliance-1",
      }],
      [{
        status: "active",
        name: "Paperclip",
      }],
      [],
      [policy],
      [{ total: 0 }],
    ]);
    dbStub.queueUpdate([]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toBeNull();
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "idle",
        pauseReason: null,
        pausedAt: null,
      }),
    );
  });

  /**
   * F-111: operator manually re-pauses a budget-paused agent (pauseReason becomes 'manual'
   * after the updateAgent fix).  When the budget window resets next day, getInvocationBlock
   * must NOT auto-resume — the operator's intent must survive.
   */
  it("F-111: does not auto-resume an agent that was re-paused manually after a budget pause", async () => {
    const policy = {
      id: "policy-hb-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "heartbeat_count",
      windowKind: "calendar_day_utc",
      amount: 20,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    // pauseReason='manual' simulates: budget pause → operator PATCH status=paused
    // → updateAgent stamps pauseReason='manual' → budget window resets (total=0).
    const dbStub = createDbStub([
      [{
        status: "paused",
        pauseReason: "manual",
        companyId: "company-1",
        name: "Compliance-1",
      }],
      [{ status: "active", name: "Paperclip" }],
      [],
      [policy],
      [{ total: 0 }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    // No budget block (budget is clear), but resumeScopeFromBudget must NOT fire.
    expect(block).toBeNull();
    expect(dbStub.updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "idle" }),
    );
  });
});
