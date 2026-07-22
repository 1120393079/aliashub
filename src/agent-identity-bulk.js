const busyStatuses = new Set(["pending", "importing"]);
const importResultActions = new Set(["created", "updated", "skipped"]);

function idKey(value) {
  return String(value ?? "").trim();
}

function nfapiStatus(item = {}) {
  const details = item.nfapi && typeof item.nfapi === "object" ? item.nfapi : {};
  return String(item.nfapi_status || details.status || "not_imported").trim().toLowerCase();
}

export function planAgentIdentityBulk(accounts = [], selectedIds = []) {
  const accountById = new Map(
    (Array.isArray(accounts) ? accounts : [])
      .filter((item) => idKey(item?.id))
      .map((item) => [idKey(item.id), item]),
  );
  const uniqueIds = [...new Set((Array.isArray(selectedIds) ? selectedIds : []).map(idKey).filter(Boolean))];
  const plan = { ids: uniqueIds, total: uniqueIds.length, selected: [], actionable: [], blocked: [] };

  for (const id of uniqueIds) {
    const item = accountById.get(id);
    if (!item?.email) {
      plan.blocked.push({ id, reason: "账号已不存在，请刷新列表后重试" });
      continue;
    }
    plan.selected.push(item);
    if (busyStatuses.has(nfapiStatus(item))) {
      plan.blocked.push({ id, item, reason: "账号正在进行 OAuth，请先完成或取消单账号导入" });
      continue;
    }
    if (!item.access_token_available) {
      plan.blocked.push({ id, item, reason: "账号没有可用 AT，请使用单账号导入设置" });
      continue;
    }
    plan.actionable.push(item);
  }

  return plan;
}

function publicProgress(progress) {
  return {
    total: progress.total,
    current: progress.current,
    created: progress.created,
    updated: progress.updated,
    skipped: progress.skipped,
    failed: progress.failed,
  };
}

export async function runAgentIdentityBulk(items, { importAccount, onProgress } = {}) {
  if (typeof importAccount !== "function") throw new TypeError("importAccount must be a function");
  const queue = Array.isArray(items) ? [...items] : [];
  const progress = {
    total: queue.length,
    current: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    completedIds: [],
    failedIds: [],
    errors: [],
  };
  const report = () => onProgress?.(publicProgress(progress));
  report();

  for (const item of queue) {
    const id = idKey(item?.id);
    try {
      const result = await importAccount(item);
      const action = String(result?.action || "").trim().toLowerCase();
      if (!importResultActions.has(action)) {
        throw new Error(`NFapi 返回了未知操作结果：${action || "empty"}`);
      }
      if (action === "created") progress.created += 1;
      else if (action === "skipped") progress.skipped += 1;
      else progress.updated += 1;
      progress.completedIds.push(id);
    } catch (error) {
      progress.failed += 1;
      progress.failedIds.push(id);
      progress.errors.push({
        id,
        message: String(error?.message || "导入失败").slice(0, 500),
      });
    }
    progress.current += 1;
    report();
  }

  return progress;
}
