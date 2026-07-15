import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch, triggerBrowserDownload } from "@/lib/utils";
import { useI18n } from "@/lib/i18n-context";
import { TaskLogPanel } from "@/components/tasks/TaskLogPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Copy,
  Download,
  ExternalLink,
  Gauge,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";

/**
 * GPT Plus 统一管理页
 * ----------------------------------------------------------------
 * CTF 生成 GPTPlus 和 GoPay 生成 GPTPlus 两条线生成的 Plus 账号都落在
 * accounts 表 platform=chatgpt，这里统一拉取并管理：搜索 / 状态徽章 /
 * 导出 / 刷新配额（plus/free） / 绑定手机号 / Codex OAuth。
 *
 * 绑定手机号 + Codex OAuth 复用 CtfGptPlus 页同名功能（``/api/tasks/phone-bind``
 * 与 ``/api/tasks/codex-oauth``），仅拷贝 UI 与状态机，不改后端协议。
 */

const BROWSER_MODE_OPTIONS = [
  { value: "camoufox_headed", label: "Camoufox 前台" },
  { value: "camoufox_headless", label: "Camoufox 后台" },
  { value: "bitbrowser_headed", label: "BitBrowser 前台" },
  { value: "bitbrowser_hidden", label: "BitBrowser 隐藏" },
  { value: "bitbrowser_headless", label: "BitBrowser 后台" },
];

function getAccountOverview(acc: any) {
  return acc?.overview && typeof acc.overview === "object" ? acc.overview : {};
}
function getDisplaySummary(acc: any) {
  return acc?.display_summary && typeof acc.display_summary === "object"
    ? acc.display_summary
    : {};
}
function getPlanState(acc: any) {
  return (
    getDisplaySummary(acc)?.status?.plan_state ||
    acc?.plan_state ||
    acc?.overview?.plan_state ||
    "unknown"
  );
}
function getPlanName(acc: any) {
  return getAccountOverview(acc)?.plan_name || acc?.plan_name || "";
}
function getCashierUrl(acc: any) {
  return acc?.cashier_url || getAccountOverview(acc)?.cashier_url || "";
}
function getPaidVia(acc: any) {
  return getAccountOverview(acc)?.paid_via || "";
}
function isPhoneBound(acc: any) {
  const binding = getAccountOverview(acc)?.phone_binding;
  return Boolean(
    binding && typeof binding === "object" && binding.status === "bound",
  );
}

function isPlusAccount(acc: any) {
  const overview = getAccountOverview(acc);
  const chips = Array.isArray(overview?.chips) ? overview.chips.join(" ") : "";
  const planText = [
    getPlanState(acc),
    getPlanName(acc),
    overview?.plan,
    overview?.membership_type,
    chips,
  ]
    .join(" ")
    .toLowerCase();
  if (planText.includes("plus") || planText.includes("team")) return true;
  if (getPlanState(acc) === "subscribed") return true;
  if (getCashierUrl(acc)) return true;
  if (planText.includes("free") || planText.includes("expired")) return true;
  return false;
}

function planBadge(acc: any): { label: string; variant: any } {
  const ps = String(getPlanState(acc)).toLowerCase();
  const overview = getAccountOverview(acc);
  const chips = Array.isArray(overview?.chips)
    ? overview.chips.join(" ").toLowerCase()
    : "";
  if (ps === "subscribed" || chips.includes("plus")) return { label: "Plus", variant: "success" };
  if (chips.includes("team")) return { label: "Team", variant: "success" };
  if (ps === "expired" || chips.includes("expired")) return { label: "Expired", variant: "warning" };
  if (ps === "free" || chips.includes("free")) return { label: "Free", variant: "secondary" };
  return { label: ps || "unknown", variant: "secondary" };
}

function escapeCsv(v: any): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function PlusManager() {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");
  const [error, setError] = useState("");
  const [bindFilter, setBindFilter] = useState<"all" | "bound" | "unbound">(
    "all",
  );

  // 绑定手机号
  const [showBind, setShowBind] = useState(false);
  const [phoneLines, setPhoneLines] = useState("");
  const [binding, setBinding] = useState(false);
  const [bindTaskId, setBindTaskId] = useState("");
  const [bindResult, setBindResult] = useState<any>(null);

  // Codex OAuth
  const [browserMode, setBrowserMode] = useState("camoufox_headed");
  const [actionConcurrency, setActionConcurrency] = useState(1);
  const [oauthTaskId, setOauthTaskId] = useState("");
  const [oauthModal, setOauthModal] = useState<any>(null);
  const [oauthCallbackUrl, setOauthCallbackUrl] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthConfirmOpen, setOauthConfirmOpen] = useState(false);

  const load = useCallback(async (s = debouncedSearch) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        platform: "chatgpt",
        page: "1",
        page_size: "200",
      });
      if (s) params.set("email", s);
      const data = await apiFetch(`/accounts?${params}`);
      const items = (data.items || []).filter(isPlusAccount);
      setAccounts(items);
    } catch (exc: any) {
      setError(exc?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    load(debouncedSearch);
  }, [debouncedSearch, load]);

  const filteredAccounts = useMemo(
    () =>
      accounts.filter((acc) => {
        if (bindFilter === "all") return true;
        if (bindFilter === "bound") return isPhoneBound(acc);
        return !isPhoneBound(acc);
      }),
    [accounts, bindFilter],
  );

  // 切换搜索 / 过滤后清理掉不再可见账户的勾选状态
  useEffect(() => {
    const visibleIds = new Set(filteredAccounts.map((acc) => Number(acc.id)));
    setSelectedIds(
      (current) => new Set([...current].filter((id) => visibleIds.has(id))),
    );
  }, [filteredAccounts]);

  const toggleOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const pageIds = filteredAccounts.map((a) => Number(a.id));
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const togglePage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const copy = (text: string) => {
    if (navigator.clipboard) navigator.clipboard.writeText(text);
  };

  const exportCsv = () => {
    const header = "email,password,plan_state,plan_name,paid_via,cashier_url,created_at";
    const src =
      selectedIds.size > 0
        ? filteredAccounts.filter((a) => selectedIds.has(Number(a.id)))
        : filteredAccounts;
    const rows = src.map((a) =>
      [
        a.email,
        a.password,
        getPlanState(a),
        getPlanName(a),
        getPaidVia(a),
        getCashierUrl(a),
        a.created_at,
      ]
        .map(escapeCsv)
        .join(","),
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    triggerBrowserDownload(blob, "gpt_plus_accounts.csv");
  };

  const refreshQuota = async () => {
    const ids =
      selectedIds.size > 0 ? [...selectedIds] : filteredAccounts.map((a) => Number(a.id));
    if (ids.length === 0) return;
    setRefreshing(true);
    setRefreshMsg("");
    setError("");
    try {
      const res = await apiFetch("/accounts/refresh-plan?platform=chatgpt", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      const updated = res?.updated ?? res?.success ?? 0;
      const timedOut = res?.timed_out ?? 0;
      setRefreshMsg(`已刷新 ${updated}/${ids.length}${timedOut ? `，${timedOut} 超时` : ""}`);
      await load();
    } catch (err: any) {
      setRefreshMsg(`刷新失败: ${err?.message || err}`);
    } finally {
      setRefreshing(false);
    }
  };

  // ---- 绑定手机号 -----------------------------------------------------------
  const startPhoneBind = async () => {
    setError("");
    const ids = [...selectedIds];
    const fallbackIds = filteredAccounts
      .filter((acc) => !isPhoneBound(acc))
      .map((acc) => Number(acc.id));
    if (!phoneLines.trim()) {
      setError("请先输入手机号和 SMS API");
      return;
    }
    if (ids.length === 0 && fallbackIds.length === 0) {
      setError("没有可绑定的未绑账户");
      return;
    }
    setBinding(true);
    try {
      const result = await apiFetch("/tasks/phone-bind", {
        method: "POST",
        body: JSON.stringify({
          platform: "chatgpt",
          ids,
          fallback_ids: ids.length > 0 ? [] : fallbackIds,
          phone_lines: phoneLines,
          browser_mode: browserMode,
          concurrency: Math.max(Number(actionConcurrency || 1), 1),
        }),
      });
      setBindTaskId(result.task_id || result.id || "");
    } catch (exc: any) {
      setError(exc?.message || "提交失败");
      setBinding(false);
    }
  };

  const handleBindTaskDone = useCallback(async () => {
    if (!bindTaskId) return;
    setBinding(false);
    try {
      const task = await apiFetch(`/tasks/${bindTaskId}`);
      const result = task?.result?.data || task?.data;
      if (result) setBindResult(result);
      setShowBind(false);
      setBindTaskId("");
      setPhoneLines("");
      setSelectedIds(new Set());
      await load();
    } catch {
      await load();
    }
  }, [bindTaskId, load]);

  // ---- Codex OAuth ----------------------------------------------------------
  const startCodexOAuth = async () => {
    setError("");
    const ids = [...selectedIds];
    if (ids.length === 0) {
      setError("请选择至少 1 个账户进行 Codex OAuth");
      return;
    }
    setOauthBusy(true);
    try {
      const data = await apiFetch("/tasks/codex-oauth", {
        method: "POST",
        body: JSON.stringify({
          platform: "chatgpt",
          ids,
          browser_mode: browserMode,
          concurrency: Math.max(Number(actionConcurrency || 1), 1),
        }),
      });
      setOauthTaskId(data.task_id || data.id || "");
    } catch (exc: any) {
      setError(exc?.message || "提交失败");
    } finally {
      setOauthBusy(false);
    }
  };

  const handleOAuthTaskDone = useCallback(async () => {
    setOauthBusy(false);
    setSelectedIds(new Set());
    await load();
  }, [load]);

  const completeCodexOAuth = async () => {
    if (!oauthModal?.account_id || !oauthCallbackUrl.trim()) return;
    setOauthBusy(true);
    setError("");
    try {
      await apiFetch(`/accounts/${oauthModal.account_id}/codex-oauth/complete`, {
        method: "POST",
        body: JSON.stringify({ callback_url: oauthCallbackUrl.trim() }),
      });
      setOauthModal(null);
      setOauthCallbackUrl("");
      setSelectedIds(new Set());
      await load();
    } catch (exc: any) {
      setError(exc?.message || "提交失败");
    } finally {
      setOauthBusy(false);
    }
  };

  const counts = useMemo(() => {
    let plus = 0,
      free = 0,
      expired = 0,
      bound = 0;
    for (const a of accounts) {
      const b = planBadge(a).label.toLowerCase();
      if (b === "plus" || b === "team") plus++;
      else if (b === "free") free++;
      else if (b === "expired") expired++;
      if (isPhoneBound(a)) bound++;
    }
    return { plus, free, expired, bound };
  }, [accounts]);

  // 留作未来 i18n 字串占位，保证 t 引用不被 tsc strict 标 unused
  void t;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      {/* 绑定手机号弹窗 */}
      {showBind &&
        createPortal(
          <div
            className="dialog-backdrop"
            onClick={() => !binding && setShowBind(false)}
          >
            <div
              className="dialog-panel flex max-h-[80vh] flex-col"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)]">
                    绑定手机号
                  </h2>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    已选 {selectedIds.size} 个账户；未勾选时按当前列表未绑账户顺序绑定。
                  </div>
                </div>
                <button
                  onClick={() => !binding && setShowBind(false)}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3 px-6 py-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs font-medium text-[var(--text-secondary)]">
                    浏览器模式
                    <select
                      value={browserMode}
                      onChange={(event) => setBrowserMode(event.target.value)}
                      disabled={binding}
                      className="control-surface control-surface-compact mt-1 w-full"
                    >
                      {BROWSER_MODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs font-medium text-[var(--text-secondary)]">
                    并发数
                    <input
                      type="number"
                      min={1}
                      value={actionConcurrency}
                      onChange={(event) =>
                        setActionConcurrency(
                          Math.max(Number(event.target.value || 1), 1),
                        )
                      }
                      disabled={binding}
                      className="control-surface control-surface-compact mt-1 w-full text-center"
                    />
                  </label>
                </div>
                {browserMode.startsWith("bitbrowser_") && (
                  <div className="rounded border border-[var(--border)] bg-[var(--bg-pane)] px-3 py-2 text-xs text-[var(--text-muted)]">
                    将自动从“设置 → BitBrowser”的号池取一个最少使用的 profile。
                  </div>
                )}
                <textarea
                  value={phoneLines}
                  onChange={(event) => setPhoneLines(event.target.value)}
                  rows={7}
                  spellCheck={false}
                  disabled={binding}
                  placeholder="+12025550101----https://relay.example.invalid/api/sms/recordText?key=..."
                  className="control-surface control-surface-compact w-full font-mono text-xs leading-relaxed"
                />
                <p className="text-xs text-[var(--text-muted)]">
                  支持多行；每个手机号最多绑定 3 个 Codex 账户。
                </p>
                {bindTaskId && (
                  <div className="h-[360px] min-h-0 rounded border border-[var(--border)] p-3">
                    <TaskLogPanel taskId={bindTaskId} onDone={handleBindTaskDone} />
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2 border-t border-[var(--border)] px-6 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowBind(false)}
                  disabled={binding}
                >
                  关闭
                </Button>
                <Button size="sm" onClick={startPhoneBind} disabled={binding}>
                  {binding ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Smartphone className="mr-2 h-4 w-4" />
                  )}
                  开始绑定
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 绑定结果弹窗 */}
      {bindResult &&
        createPortal(
          <div className="dialog-backdrop" onClick={() => setBindResult(null)}>
            <div
              className="dialog-panel"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
                <h2 className="text-base font-semibold text-[var(--text-primary)]">
                  绑定结果
                </h2>
                <button
                  onClick={() => setBindResult(null)}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3 px-6 py-4 text-sm">
                <div className="text-[var(--text-secondary)]">
                  成功 {bindResult.success_count || 0}，失败{" "}
                  {bindResult.failure_count || 0}
                </div>
                <div className="overflow-hidden rounded border border-[var(--border)]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[var(--bg-pane)] text-[var(--text-muted)]">
                      <tr>
                        <th className="px-3 py-2">手机号</th>
                        <th className="px-3 py-2">使用</th>
                        <th className="px-3 py-2">成功</th>
                        <th className="px-3 py-2">失败</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(bindResult.phones || []).map((item: any) => (
                        <tr
                          key={item.phone}
                          className="border-t border-[var(--border)]/40"
                        >
                          <td className="px-3 py-2 font-mono">{item.phone}</td>
                          <td className="px-3 py-2">{item.used || 0}</td>
                          <td className="px-3 py-2">{item.success || 0}</td>
                          <td className="px-3 py-2">{item.failed || 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="flex justify-end border-t border-[var(--border)] px-6 py-3">
                <Button size="sm" onClick={() => setBindResult(null)}>
                  关闭
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Codex OAuth 任务日志弹窗 */}
      {oauthTaskId &&
        createPortal(
          <div className="dialog-backdrop" onClick={() => setOauthTaskId("")}>
            <div
              className="dialog-panel flex max-h-[82vh] flex-col"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)]">
                    Codex OAuth
                  </h2>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    任务会调用已写好的 OAuth 认证流程，并把日志输出到这里。
                  </div>
                </div>
                <button
                  onClick={() => setOauthTaskId("")}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 px-6 py-4">
                <div className="h-[420px] min-h-0 rounded border border-[var(--border)] p-3">
                  <TaskLogPanel taskId={oauthTaskId} onDone={handleOAuthTaskDone} />
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-[var(--border)] px-6 py-3">
                <Button variant="outline" size="sm" onClick={() => setOauthTaskId("")}>
                  关闭
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Codex OAuth 单账户回调粘贴弹窗 */}
      {oauthModal &&
        createPortal(
          <div
            className="dialog-backdrop"
            onClick={() => !oauthBusy && setOauthModal(null)}
          >
            <div
              className="dialog-panel flex max-h-[82vh] flex-col"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)]">
                    Codex OAuth
                  </h2>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    {oauthModal.email || ""} 登录完成后粘贴回调 URL 刷新 token。
                  </div>
                </div>
                <button
                  onClick={() => !oauthBusy && setOauthModal(null)}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3 px-6 py-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    window.open(oauthModal.auth_url, "_blank", "noopener,noreferrer")
                  }
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  打开 OAuth 链接
                </Button>
                <textarea
                  value={oauthCallbackUrl}
                  onChange={(event) => setOauthCallbackUrl(event.target.value)}
                  rows={6}
                  spellCheck={false}
                  placeholder="粘贴之前 OAuth 认证返回的带 access_token / refresh_token 的回调 URL"
                  className="control-surface control-surface-compact w-full font-mono text-xs leading-relaxed"
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-[var(--border)] px-6 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOauthModal(null)}
                  disabled={oauthBusy}
                >
                  关闭
                </Button>
                <Button
                  size="sm"
                  onClick={completeCodexOAuth}
                  disabled={oauthBusy || !oauthCallbackUrl.trim()}
                >
                  {oauthBusy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="mr-2 h-4 w-4" />
                  )}
                  刷新 token
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Codex OAuth 启动选项弹窗 */}
      {oauthConfirmOpen &&
        createPortal(
          <div
            className="dialog-backdrop"
            onClick={() => !oauthBusy && setOauthConfirmOpen(false)}
          >
            <div
              className="dialog-panel flex max-h-[82vh] flex-col"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)]">
                    Codex OAuth 启动选项
                  </h2>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    已选 {selectedIds.size} 个账户。配置浏览器模式和并发数后启动批量 OAuth。
                  </div>
                </div>
                <button
                  onClick={() => !oauthBusy && setOauthConfirmOpen(false)}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-4 px-6 py-4">
                <div>
                  <label className="mb-1 block text-xs text-[var(--text-muted)]">
                    浏览器模式
                  </label>
                  <select
                    value={browserMode}
                    onChange={(event) => setBrowserMode(event.target.value)}
                    className="control-surface control-surface-compact w-full"
                  >
                    {BROWSER_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--text-muted)]">
                    并发数
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={actionConcurrency}
                    onChange={(event) =>
                      setActionConcurrency(
                        Math.max(Number(event.target.value || 1), 1),
                      )
                    }
                    className="control-surface control-surface-compact w-full text-center"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-[var(--border)] px-6 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOauthConfirmOpen(false)}
                  disabled={oauthBusy}
                >
                  关闭
                </Button>
                <Button
                  size="sm"
                  onClick={async () => {
                    setOauthConfirmOpen(false);
                    await startCodexOAuth();
                  }}
                  disabled={oauthBusy || selectedIds.size === 0}
                >
                  {oauthBusy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="mr-2 h-4 w-4" />
                  )}
                  启动
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 顶部工具栏 */}
      <Card className="shrink-0 bg-[var(--bg-pane)]/40 border border-[var(--border)] shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 px-5 py-4 border-b border-[var(--border)]/50">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
              GPT Plus 管理
            </h1>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-[var(--text-muted)]">共 {accounts.length} 条</span>
              {counts.plus > 0 && (
                <span className="rounded-full bg-blue-500/10 px-2 py-0.5 font-medium text-blue-500 ring-1 ring-inset ring-blue-500/20">
                  Plus {counts.plus}
                </span>
              )}
              {counts.free > 0 && (
                <span className="rounded-full bg-[var(--text-primary)]/10 px-2 py-0.5 font-medium text-[var(--text-secondary)] ring-1 ring-inset ring-[var(--text-primary)]/20">
                  Free {counts.free}
                </span>
              )}
              {counts.expired > 0 && (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-500 ring-1 ring-inset ring-amber-500/20">
                  Expired {counts.expired}
                </span>
              )}
              {counts.bound > 0 && (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-500 ring-1 ring-inset ring-emerald-500/20">
                  已绑 {counts.bound}
                </span>
              )}
              {selectedIds.size > 0 && (
                <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 font-medium text-[var(--accent)]">
                  已选 {selectedIds.size}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索邮箱"
              className="control-surface control-surface-compact h-8"
              style={{ width: 240 }}
            />
            <Button size="sm" variant="outline" onClick={() => load()} disabled={loading} className="h-8">
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              刷新
            </Button>
            <Button size="sm" variant="outline" onClick={refreshQuota} disabled={refreshing} className="h-8">
              {refreshing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Gauge className="mr-1.5 h-3.5 w-3.5" />}
              刷新配额
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowBind(true)}
              className="h-8"
            >
              <Smartphone className="mr-1.5 h-3.5 w-3.5" />
              绑定手机号
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setError("");
                if (selectedIds.size === 0) {
                  setError("请选择至少 1 个账户进行 Codex OAuth");
                  return;
                }
                setOauthConfirmOpen(true);
              }}
              disabled={oauthBusy || selectedIds.size === 0}
              className="h-8"
            >
              <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
              Codex OAuth
            </Button>
            <Button size="sm" onClick={exportCsv} className="h-8">
              <Download className="mr-1.5 h-3.5 w-3.5" />
              导出 CSV
            </Button>
          </div>
        </div>

        {/* 过滤条 + 状态条 */}
        <div className="flex flex-wrap items-center gap-2 px-5 py-2 text-xs">
          {(["all", "bound", "unbound"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={bindFilter === value ? "default" : "outline"}
              onClick={() => setBindFilter(value)}
              className="h-7"
            >
              {value === "all" ? "全部" : value === "bound" ? "已绑" : "未绑"}
            </Button>
          ))}
          {refreshMsg && (
            <span className="text-[var(--text-muted)]">{refreshMsg}</span>
          )}
          {error && (
            <span className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-red-300">
              {error}
            </span>
          )}
        </div>
      </Card>

      <Card className="flex flex-col min-h-0 flex-1 bg-[var(--bg-pane)]/40 border border-[var(--border)]">
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[var(--bg-card)] z-10">
              <tr className="text-left text-[var(--text-muted)]">
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" checked={allSelected} onChange={togglePage} className="h-4 w-4 accent-[var(--accent)]" />
                </th>
                <th className="px-3 py-2">邮箱</th>
                <th className="px-3 py-2">套餐</th>
                <th className="px-3 py-2">手机</th>
                <th className="px-3 py-2">来源</th>
                <th className="px-3 py-2">支付链接</th>
                <th className="px-3 py-2">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {filteredAccounts.map((acc) => {
                const badge = planBadge(acc);
                const cashier = getCashierUrl(acc);
                const paidVia = getPaidVia(acc);
                const phoneBound = isPhoneBound(acc);
                return (
                  <tr key={acc.id} className="hover:bg-[var(--bg-hover)]">
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(Number(acc.id))}
                        onChange={() => toggleOne(Number(acc.id))}
                        className="h-4 w-4 accent-[var(--accent)]"
                      />
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-primary)]">
                      <button
                        onClick={() => copy(acc.email)}
                        className="inline-flex items-center gap-1 hover:text-[var(--accent)]"
                        title="复制邮箱"
                      >
                        {acc.email}
                        <Copy className="h-3 w-3 opacity-50" />
                      </button>
                    </td>
                    <td className="px-3 py-1.5">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </td>
                    <td className="px-3 py-1.5">
                      {phoneBound ? (
                        <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-300">
                          已绑
                        </span>
                      ) : (
                        <span className="text-[var(--text-muted)]">-</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">
                      {paidVia === "gopay" ? "GoPay" : "CTF"}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">
                      {cashier ? (
                        <a href={cashier} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                          链接
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">{acc.created_at || "-"}</td>
                  </tr>
                );
              })}
              {filteredAccounts.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-[var(--text-muted)]">
                    {loading ? "加载中…" : "暂无 Plus 账号"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
