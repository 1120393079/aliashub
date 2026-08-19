import {
  NETEASE_ALIAS_STRATEGY,
  normalizeNeteaseAliasEmail,
} from "./address-generator.js";
import { audit, nowIso } from "./db.js";

const MAX_ALIASES = 5_000;

function errorWithStatus(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

export { NETEASE_ALIAS_STRATEGY };
export const normalizeNeteaseAlias = normalizeNeteaseAliasEmail;

export function importNeteaseAliases(db, account, values = [], {
  replace = false,
  purpose = "网易替身邮箱导入",
} = {}) {
  if (account?.provider !== "netease") {
    throw errorWithStatus("这个源头邮箱不是网易邮箱账号", 409, "NETEASE_ACCOUNT_REQUIRED");
  }
  const raw = Array.isArray(values) ? values : [];
  if (raw.length > MAX_ALIASES) {
    throw errorWithStatus(`单次最多提交 ${MAX_ALIASES} 个网易替身邮箱`, 400, "NETEASE_ALIAS_LIMIT");
  }
  const invalid = raw
    .map((value) => String(value || "").trim())
    .filter((value) => value && !normalizeNeteaseAlias(value));
  if (invalid.length) {
    throw errorWithStatus(
      `网易替身邮箱必须使用 @aka.yeah.net 后缀：${invalid[0]}`,
      400,
      "INVALID_NETEASE_ALIAS",
    );
  }

  const aliases = [...new Set(raw.map(normalizeNeteaseAlias).filter(Boolean))];
  if (!aliases.length && !replace) {
    throw errorWithStatus("请至少填写一个 @aka.yeah.net 替身邮箱", 400, "NETEASE_ALIAS_REQUIRED");
  }

  const activeRows = db.prepare(`
    SELECT address, strategy FROM addresses
    WHERE account_id = ? AND kind = 'official' AND status = 'active'
  `).all(account.id);
  const currentAliases = activeRows
    .filter((row) => row.strategy === NETEASE_ALIAS_STRATEGY)
    .map((row) => row.address.toLowerCase());
  const finalAliases = replace
    ? aliases
    : [...new Set([...currentAliases, ...aliases])];

  const duplicate = db.prepare(`
    SELECT source_accounts.email AS source_email
    FROM addresses
    JOIN source_accounts ON source_accounts.id = addresses.account_id
    WHERE addresses.address = ? COLLATE NOCASE AND addresses.account_id != ?
    LIMIT 1
  `);
  const assigned = finalAliases
    .map((address) => ({ address, row: duplicate.get(address, account.id) }))
    .find((item) => item.row);
  if (assigned) {
    throw errorWithStatus(
      `${assigned.address} 已映射到母号 ${assigned.row.source_email}，不能重复导入`,
      409,
      "NETEASE_ALIAS_ALREADY_ASSIGNED",
    );
  }

  const now = nowIso();
  const insert = db.prepare(`
    INSERT INTO addresses (
      account_id, address, kind, status, strategy, label, purpose,
      remote_confirmed, created_at, updated_at
    ) VALUES (?, ?, 'official', 'active', ?, '网易替身邮箱', ?, 1, ?, ?)
    ON CONFLICT(account_id, address) DO UPDATE SET
      kind = CASE WHEN addresses.kind = 'primary' THEN 'primary' ELSE 'official' END,
      status = 'active', strategy = excluded.strategy, label = excluded.label,
      purpose = excluded.purpose, remote_confirmed = 1, updated_at = excluded.updated_at
  `);
  const findAddress = db.prepare(`
    SELECT id FROM addresses
    WHERE account_id = ? AND address = ? COLLATE NOCASE
  `);
  const relinkRegistrationHistory = db.prepare(`
    UPDATE registration_jobs
    SET address_id = ?, base_address_id = ?
    WHERE account_id = ? AND email = ? COLLATE NOCASE
  `);

  let removed = 0;
  db.transaction(() => {
    db.prepare(`
      UPDATE source_accounts
      SET official_limit = MAX(official_limit, ?), updated_at = ?
      WHERE id = ?
    `).run(Math.max(1, finalAliases.length + 1), now, account.id);
    for (const address of finalAliases) {
      insert.run(account.id, address, NETEASE_ALIAS_STRATEGY, purpose, now, now);
      const addressId = findAddress.get(account.id, address)?.id;
      if (addressId) relinkRegistrationHistory.run(addressId, addressId, account.id, address);
    }
    if (replace) {
      const placeholders = finalAliases.map(() => "?").join(",");
      const sql = finalAliases.length
        ? `DELETE FROM addresses
           WHERE account_id = ? AND kind = 'official' AND strategy = ?
             AND address NOT IN (${placeholders})`
        : `DELETE FROM addresses
           WHERE account_id = ? AND kind = 'official' AND strategy = ?`;
      removed = db.prepare(sql)
        .run(account.id, NETEASE_ALIAS_STRATEGY, ...finalAliases).changes;
    }
    audit(
      db,
      account.id,
      "alias",
      replace ? "同步网易替身邮箱" : "导入网易替身邮箱",
      `当前保存 ${finalAliases.length} 个 @aka.yeah.net 地址，移除 ${removed} 个本地映射`,
      { count: finalAliases.length, removed },
    );
  })();

  return db.prepare(`
    SELECT * FROM addresses
    WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active'
    ORDER BY kind = 'primary' DESC, created_at
  `).all(account.id);
}
