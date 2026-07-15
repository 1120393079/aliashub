/**
 * BitBrowser Profile ID 池管理面板。
 *
 * 业务逻辑很简单：列表 + 添加输入框 + 单条删除按钮 + 批量编辑（textarea）。
 * 后端 in-memory 维护使用计数（``in_use``），UI 只读地展示出来，方便用户
 * 调试并发分配。
 *
 * 不在这里做"测试连接"按钮。BitBrowser 本地 API 的连通性由实际跑 checkout
 * 时来验证更可靠（profile 状态 / 占用 / 代理可用 这些都需要等真起 Chromium
 * 才能确定）。
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react";

import { useI18n } from "@/lib/i18n-context";
import { apiFetch } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type ProfileItem = {
  profile_id: string;
  in_use: number;
};

export default function BitBrowserProfiles() {
  const { t } = useI18n();
  const [items, setItems] = useState<ProfileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [newId, setNewId] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/bitbrowser/profiles");
      const list: ProfileItem[] = Array.isArray(data?.items) ? data.items : [];
      setItems(list);
      setBulkText(list.map((it) => it.profile_id).join("\n"));
    } catch (exc: any) {
      setError(exc?.message || "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addOne = async () => {
    const id = newId.trim();
    if (!id) return;
    setSaving(true);
    setError("");
    try {
      await apiFetch("/bitbrowser/profiles", {
        method: "POST",
        body: JSON.stringify({ profile_id: id }),
      });
      setNewId("");
      await refresh();
    } catch (exc: any) {
      setError(exc?.message || "add failed");
    } finally {
      setSaving(false);
    }
  };

  const removeOne = async (id: string) => {
    setSaving(true);
    setError("");
    try {
      await apiFetch(`/bitbrowser/profiles/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      await refresh();
    } catch (exc: any) {
      setError(exc?.message || "delete failed");
    } finally {
      setSaving(false);
    }
  };

  const saveBulk = async () => {
    setSaving(true);
    setError("");
    try {
      const ids = bulkText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      await apiFetch("/bitbrowser/profiles", {
        method: "PUT",
        body: JSON.stringify({ profile_ids: ids }),
      });
      setShowBulk(false);
      await refresh();
    } catch (exc: any) {
      setError(exc?.message || "save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">
          {t("settings.bitbrowser.title")}
        </h3>
        <p className="mt-0.5 text-[13px] text-[var(--text-muted)]">
          {t("settings.bitbrowser.desc")}
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={newId}
          onChange={(event) => setNewId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addOne();
            }
          }}
          placeholder={t("settings.bitbrowser.placeholder")}
          className="control-surface control-surface-compact flex-1 min-w-[220px]"
        />
        <Button onClick={addOne} disabled={saving || !newId.trim()} size="sm">
          {saving ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="mr-1 h-3.5 w-3.5" />
          )}
          {t("settings.bitbrowser.add")}
        </Button>
        <Button
          onClick={() => setShowBulk((prev) => !prev)}
          variant="outline"
          size="sm"
        >
          {showBulk
            ? t("settings.bitbrowser.bulkClose")
            : t("settings.bitbrowser.bulkEdit")}
        </Button>
        <Button onClick={refresh} variant="ghost" size="sm" disabled={loading}>
          <RefreshCw
            className={`mr-1 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          {t("common.refresh")}
        </Button>
      </div>

      {showBulk && (
        <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3">
          <div className="text-xs text-[var(--text-muted)]">
            {t("settings.bitbrowser.bulkHelp")}
          </div>
          <textarea
            value={bulkText}
            onChange={(event) => setBulkText(event.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={t("settings.bitbrowser.bulkPlaceholder")}
            className="control-surface control-surface-compact w-full font-mono text-xs leading-relaxed"
          />
          <div className="flex justify-end">
            <Button onClick={saveBulk} disabled={saving} size="sm">
              {saving ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.bitbrowser.bulkSave")}
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-md border border-[var(--border)] bg-[var(--bg-card)]">
        {items.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">
            {t("settings.bitbrowser.empty")}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]/50">
            {items.map((item) => (
              <li
                key={item.profile_id}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="flex flex-1 items-center gap-3 overflow-hidden">
                  <span className="truncate font-mono text-sm text-[var(--text-primary)]">
                    {item.profile_id}
                  </span>
                  {item.in_use > 0 && (
                    <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                      {t("settings.bitbrowser.inUse")} ({item.in_use})
                    </span>
                  )}
                </div>
                <button
                  onClick={() => removeOne(item.profile_id)}
                  disabled={saving}
                  className="text-[var(--text-muted)] hover:text-red-500 disabled:opacity-50"
                  title={t("settings.bitbrowser.remove")}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="text-[11px] leading-relaxed text-[var(--text-muted)]">
        {t("settings.bitbrowser.note")}
      </div>
    </div>
  );
}
