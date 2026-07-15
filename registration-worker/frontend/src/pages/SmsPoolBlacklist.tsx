import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/utils'
import { useI18n } from '@/lib/i18n-context'
import { formatDateTime } from '@/lib/i18n'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, Trash2, RotateCcw, ShieldAlert } from 'lucide-react'

type BlacklistItem = {
  id: number
  phone_e164: string
  relay_url: string
  relay_host: string
  reason: string
  error_code: string
  task_id: string
  fail_count: number
  last_error_message: string
  created_at: string | null
  last_attempted_at: string | null
}

export default function SmsPoolBlacklist() {
  const { t, language } = useI18n()
  const [items, setItems] = useState<BlacklistItem[]>([])
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/sms-pool/blacklist')
      setItems(Array.isArray(data?.items) ? data.items : [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const restore = async (phone: string) => {
    if (!window.confirm(t('smsPool.confirmRestore'))) return
    await apiFetch(`/sms-pool/blacklist/${encodeURIComponent(phone)}`, {
      method: 'DELETE',
    })
    load()
  }

  const clearAll = async () => {
    if (!window.confirm(t('smsPool.confirmClearAll'))) return
    await apiFetch('/sms-pool/blacklist', { method: 'DELETE' })
    load()
  }

  const renderReason = (item: BlacklistItem) => {
    if (item.reason === 'oas_error') {
      return (
        <Badge variant="danger" className="gap-1">
          <ShieldAlert className="h-3 w-3" />
          {t('smsPool.reason.oas_error')}
        </Badge>
      )
    }
    if (item.reason === 'manual') {
      return <Badge variant="secondary">{t('smsPool.reason.manual')}</Badge>
    }
    return <Badge variant="secondary">{item.reason || '-'}</Badge>
  }

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-[var(--text-primary)]">
              {t('smsPool.title')}
            </div>
            <Badge variant="default">
              {t('common.total')} {items.length}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={load}
              disabled={loading}
            >
              <RefreshCw
                className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`}
              />
              {t('smsPool.refresh')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={clearAll}
              disabled={loading || items.length === 0}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              {t('smsPool.action.clearAll')}
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          {t('smsPool.subtitle')}
        </p>
      </Card>

      {items.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-[var(--text-muted)]">
            {t('smsPool.empty')}
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--bg-hover)]">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium text-[var(--text-secondary)]">
                    {t('smsPool.col.phone')}
                  </th>
                  <th className="px-3 py-2 font-medium text-[var(--text-secondary)]">
                    {t('smsPool.col.relayHost')}
                  </th>
                  <th className="px-3 py-2 font-medium text-[var(--text-secondary)]">
                    {t('smsPool.col.reason')}
                  </th>
                  <th className="px-3 py-2 font-medium text-[var(--text-secondary)]">
                    {t('smsPool.col.errorCode')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-[var(--text-secondary)]">
                    {t('smsPool.col.failCount')}
                  </th>
                  <th className="px-3 py-2 font-medium text-[var(--text-secondary)]">
                    {t('smsPool.col.lastAttemptedAt')}
                  </th>
                  <th className="px-3 py-2 font-medium text-[var(--text-secondary)]">
                    {t('smsPool.col.taskId')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-[var(--text-secondary)]">
                    {t('smsPool.col.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-hover)]"
                  >
                    <td className="px-3 py-2 font-mono text-[var(--text-primary)]">
                      {item.phone_e164}
                    </td>
                    <td className="px-3 py-2 text-[var(--text-secondary)]">
                      {item.relay_host || '-'}
                    </td>
                    <td className="px-3 py-2">{renderReason(item)}</td>
                    <td className="px-3 py-2 font-mono text-xs text-[var(--text-muted)]">
                      {item.error_code || '-'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--text-secondary)]">
                      {item.fail_count}
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--text-muted)]">
                      {item.last_attempted_at
                        ? formatDateTime(item.last_attempted_at, language)
                        : '-'}
                    </td>
                    <td
                      className="px-3 py-2 text-xs text-[var(--text-muted)]"
                      title={item.last_error_message}
                    >
                      {item.task_id || '-'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => restore(item.phone_e164)}
                      >
                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                        {t('smsPool.action.restore')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
