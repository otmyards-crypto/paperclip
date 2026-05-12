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

  it("applies hard-stop for both concurrent heartbeat finalizations at boundary (race: both read count=cap before pause commits)", async () => {
    // Scenario (F-113): cap=20. Run #20 and run #21 finalize simultaneously.
    // Both see total=20 before either commits the pause — both must trigger hard-stop.
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
        [{ total: 20 }], // stale read — pause not yet committed by the other concurrent call
        [],              // resolveOpenSoftIncidents
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
      service1.evaluateHeartbeatRunFinalized({ companyId: "company-1", agentId: "agent-1", status: "succeeded" }),
      service2.evaluateHeartbeatRunFinalized({ companyId: "company-1", agentId: "agent-1", status: "succeeded" }),
    ]);

    // Both concurrent evaluations must independently trigger pause+cancel (idempotent on real DB)
    expect(stub1.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused", pauseReason: "budget" }),
    );
    expect(stub2.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused", pauseReason: "budget" }),
    );
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

    // pauseReason='manual' — simulates: budget pause → operator PATCH status=paused
    // (updateAgent fix stamps pauseReason='manual') → budget window resets (total=0).
    const dbStub = createDbStub([
      [{
        status: "paused",
        pauseReason: "manual",
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

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    // No budget block (budget is clear), but resumeScopeFromBudget must NOT fire.
    expect(block).toBeNull();
    expect(dbStub.updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "idle" }),
    );
  });
});
