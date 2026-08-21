import {
  ICLOUD_CUSTOM_DOMAIN_STRATEGY,
  ICLOUD_HIDE_MY_EMAIL_STRATEGY,
  ICLOUD_MAIL_ALIAS_STRATEGY,
  MAILCOM_ALIAS_STRATEGY,
  NETEASE_ALIAS_STRATEGY,
  isIcloudPrivateRelay,
  isIcloudImportedStrategy,
  isMailcomAliasStrategy,
  isNeteaseAliasStrategy,
  normalizeIcloudAliasEmail,
  normalizeIcloudCustomDomainEmail,
  normalizeMailcomEmail,
  normalizeTag,
  splitAddress,
} from "./address-generator.js";
import { audit, nowIso } from "./db.js";

export function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function publicAccount(db, row) {
  if (!row) return null;
  const provider = row.provider || "microsoft";
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN kind = 'primary' THEN 1 ELSE 0 END) AS primary_count,
      SUM(CASE WHEN kind = 'official' AND status = 'active' THEN 1 ELSE 0 END) AS official_count,
      SUM(CASE WHEN kind = 'official' AND status = 'active' AND strategy = 'icloud_mail_alias' THEN 1 ELSE 0 END) AS icloud_mail_alias_count,
      SUM(CASE WHEN kind = 'official' AND status = 'active' AND strategy = 'icloud_hide_my_email' THEN 1 ELSE 0 END) AS icloud_hide_my_email_count,
      SUM(CASE WHEN kind = 'official' AND status = 'active' AND strategy = 'icloud_custom_domain' THEN 1 ELSE 0 END) AS icloud_custom_domain_count,
      SUM(CASE WHEN kind = 'official' AND status = 'active' AND strategy = 'mailcom_alias' THEN 1 ELSE 0 END) AS mailcom_alias_count,
      SUM(CASE WHEN kind = 'official' AND status = 'active' AND strategy = 'netease_alias' THEN 1 ELSE 0 END) AS netease_alias_count,
      SUM(CASE WHEN kind = 'split' AND status = 'active' THEN 1 ELSE 0 END) AS split_count,
      COUNT(*) AS address_count
    FROM addresses WHERE account_id = ?
  `).get(row.id);
  const officialUsed = (counts.primary_count || 0) + (counts.official_count || 0);
  const credentialConnected = provider === "google"
    ? Boolean(db.prepare("SELECT 1 FROM google_tokens WHERE account_id = ?").get(row.id))
    : provider === "microsoft"
      ? Boolean(db.prepare("SELECT 1 FROM microsoft_tokens WHERE account_id = ?").get(row.id))
      : provider === "icloud"
        ? Boolean(db.prepare("SELECT 1 FROM icloud_credentials WHERE account_id = ?").get(row.id))
        : provider === "mailcom"
          ? Boolean(db.prepare("SELECT 1 FROM mailcom_credentials WHERE account_id = ?").get(row.id))
        : provider === "netease"
          ? Boolean(db.prepare("SELECT 1 FROM netease_credentials WHERE account_id = ?").get(row.id))
        : provider === "inbox_link"
          ? Boolean(db.prepare("SELECT 1 FROM inbox_link_mailboxes WHERE source_account_id = ? AND status = 'active'").get(row.id))
          : false;
  const oauthConnected = !["icloud", "mailcom", "netease", "inbox_link"].includes(provider) && credentialConnected;
  return {
    ...row,
    provider,
    official_used: officialUsed,
    official_remaining: Math.max(0, row.official_limit - officialUsed),
    official_aliases: counts.official_count || 0,
    icloud_mail_aliases: counts.icloud_mail_alias_count || 0,
    icloud_hide_my_emails: counts.icloud_hide_my_email_count || 0,
    icloud_custom_domain_emails: counts.icloud_custom_domain_count || 0,
    mailcom_aliases: counts.mailcom_alias_count || 0,
    netease_aliases: counts.netease_alias_count || 0,
    split_count: counts.split_count || 0,
    address_count: counts.address_count || 0,
    oauth_connected: oauthConnected,
    credential_connected: credentialConnected,
    connection_connected: credentialConnected,
    auth_mode: provider === "icloud" ? "app_password" : provider === "mailcom" ? "password" : provider === "netease" ? "imap_auth_code" : provider === "inbox_link" ? "inbox_link" : "oauth",
    supports_official_aliases: provider === "microsoft",
    supports_plus_aliases: ["microsoft", "google"].includes(provider),
    supports_imported_aliases: ["icloud", "mailcom", "netease"].includes(provider),
    supports_direct_registration: ["icloud", "mailcom", "netease"].includes(provider),
    supports_mailcom_aliases: provider === "mailcom",
    supports_netease_aliases: provider === "netease",
  };
}

export function importMailcomAliases(db, account, values = [], {
  replace = false,
  purpose = "Mail.com 手工导入",
  trustedRemoteSync = false,
} = {}) {
  if (account?.provider !== "mailcom") {
    throw Object.assign(new Error("这个源头邮箱不是 Mail.com 账号"), { status: 409, code: "MAILCOM_ACCOUNT_REQUIRED" });
  }
  const raw = Array.isArray(values) ? values : [];
  if (!trustedRemoteSync && raw.length > 100) {
    throw Object.assign(new Error("单次最多提交 100 个 Mail.com 别名"), { status: 400 });
  }
  const invalid = raw.map((value) => String(value || "").trim())
    .filter((value) => value && !normalizeMailcomEmail(value));
  if (invalid.length) {
    throw Object.assign(new Error(`不是 signup.mail.com 支持的邮箱地址：${invalid[0]}`), { status: 400 });
  }
  const aliases = [...new Set(raw.map(normalizeMailcomEmail).filter(Boolean))]
    .filter((address) => address !== account.email.toLowerCase());
  if (!aliases.length && !replace) {
    throw Object.assign(new Error("请至少填写一个 Mail.com 官方别名"), { status: 400 });
  }
  const existingRows = db.prepare(`
    SELECT address, strategy FROM addresses
    WHERE account_id = ? AND kind = 'official' AND status = 'active'
  `).all(account.id);
  const existing = existingRows.filter((item) => isMailcomAliasStrategy(item.strategy))
    .map((item) => item.address.toLowerCase());
  const finalAliases = replace ? aliases : [...new Set([...existing, ...aliases])];
  const duplicate = db.prepare(`
    SELECT source_accounts.email AS source_email
    FROM addresses
    JOIN source_accounts ON source_accounts.id = addresses.account_id
    WHERE addresses.address = ? COLLATE NOCASE AND addresses.account_id != ?
    LIMIT 1
  `);
  const assigned = finalAliases.map((address) => ({ address, row: duplicate.get(address, account.id) }))
    .find((item) => item.row);
  if (assigned) {
    throw Object.assign(
      new Error(`${assigned.address} 已属于源头邮箱 ${assigned.row.source_email}，不能重复导入`),
      { status: 409, code: "MAILCOM_ALIAS_ALREADY_ASSIGNED" },
    );
  }

  const now = nowIso();
  const insert = db.prepare(`
    INSERT INTO addresses (
      account_id, address, kind, status, strategy, label, purpose, remote_confirmed, created_at, updated_at
    ) VALUES (?, ?, 'official', 'active', ?, 'Mail.com 官方别名', ?, 1, ?, ?)
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
    db.prepare("UPDATE source_accounts SET official_limit = 10, updated_at = ? WHERE id = ?")
      .run(now, account.id);
    finalAliases.forEach((address) => {
      insert.run(
        account.id,
        address,
        MAILCOM_ALIAS_STRATEGY,
        purpose,
        now,
        now,
      );
      const addressId = findAddress.get(account.id, address)?.id;
      if (addressId) {
        relinkRegistrationHistory.run(addressId, addressId, account.id, address);
      }
    });
    if (replace) {
      const placeholders = finalAliases.map(() => "?").join(",");
      const statement = finalAliases.length
        ? `UPDATE addresses
           SET status = 'disabled', remote_confirmed = 0, updated_at = ?
           WHERE account_id = ? AND kind = 'official' AND strategy = ?
             AND status = 'active' AND address NOT IN (${placeholders})`
        : `UPDATE addresses
           SET status = 'disabled', remote_confirmed = 0, updated_at = ?
           WHERE account_id = ? AND kind = 'official' AND strategy = ? AND status = 'active'`;
      removed = db.prepare(statement).run(now, account.id, MAILCOM_ALIAS_STRATEGY, ...finalAliases).changes;
    }
    audit(db, account.id, "alias", replace ? "同步 Mail.com 官方别名" : "导入 Mail.com 官方别名", `本次保存 ${finalAliases.length} 个地址，移除 ${removed} 个本地映射`, {
      count: finalAliases.length,
      removed,
    });
  })();
  return db.prepare(`
    SELECT * FROM addresses
    WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active'
    ORDER BY kind = 'primary' DESC, created_at
  `).all(account.id);
}

export function importIcloudAliases(db, account, values = [], {
  type = "",
  replace = false,
  purpose = "iCloud 手工导入",
  remoteConfirmed = false,
} = {}) {
  if (account?.provider !== "icloud") {
    throw Object.assign(new Error("这个源头邮箱不是 iCloud 账号"), { status: 409, code: "ICLOUD_ACCOUNT_REQUIRED" });
  }
  const raw = Array.isArray(values) ? values : [];
  if (raw.length > 500) throw Object.assign(new Error("单次最多导入 500 个 iCloud 地址"), { status: 400 });
  if (!["", "mail_alias", "hide_my_email", "custom_domain"].includes(type)) {
    throw Object.assign(new Error("iCloud 地址类型无效"), { status: 400 });
  }
  const normalizeAddress = type === "custom_domain"
    ? normalizeIcloudCustomDomainEmail
    : normalizeIcloudAliasEmail;
  const invalid = raw.map((value) => String(value || "").trim()).filter((value) => value && !normalizeAddress(value));
  if (invalid.length) {
    const prefix = type === "custom_domain"
      ? "自定义域名邮箱必须使用已在 iCloud 激活的非 Apple 域名"
      : "不支持的 iCloud 地址";
    throw Object.assign(new Error(`${prefix}：${invalid[0]}`), { status: 400 });
  }
  const aliases = [...new Set(raw.map(normalizeAddress).filter(Boolean))]
    .filter((address) => address !== account.email.toLowerCase());
  if (!aliases.length && !replace) {
    throw Object.assign(new Error("请至少填写一个 iCloud 地址"), { status: 400 });
  }
  const wrongType = aliases.find((address) => {
    const isHiddenEmail = isIcloudPrivateRelay(address);
    const domain = address.split("@")[1];
    return (type === "mail_alias" && isHiddenEmail)
      || (type === "hide_my_email" && domain !== "icloud.com" && !isHiddenEmail);
  });
  if (wrongType) {
    const message = type === "hide_my_email"
      ? "隐藏邮箱必须是 @icloud.com 或 @privaterelay.appleid.com 地址"
      : "iCloud 邮箱别名必须是 @icloud.com、@me.com 或 @mac.com 地址";
    throw Object.assign(new Error(`${message}：${wrongType}`), { status: 400 });
  }
  const duplicate = db.prepare(`
    SELECT source_accounts.email AS source_email
    FROM addresses
    JOIN source_accounts ON source_accounts.id = addresses.account_id
    WHERE addresses.address = ? COLLATE NOCASE AND addresses.account_id != ?
    LIMIT 1
  `);
  const assigned = aliases.map((address) => ({ address, row: duplicate.get(address, account.id) })).find((item) => item.row);
  if (assigned) {
    throw Object.assign(
      new Error(`${assigned.address} 已属于源头邮箱 ${assigned.row.source_email}，不能重复导入`),
      { status: 409, code: "ICLOUD_ALIAS_ALREADY_ASSIGNED" },
    );
  }
  const now = nowIso();
  const targetStrategy = type === "custom_domain"
    ? ICLOUD_CUSTOM_DOMAIN_STRATEGY
    : type === "hide_my_email" ? ICLOUD_HIDE_MY_EMAIL_STRATEGY : ICLOUD_MAIL_ALIAS_STRATEGY;
  const insert = db.prepare(`
    INSERT INTO addresses (
      account_id, address, kind, status, strategy, label, purpose, remote_confirmed, created_at, updated_at
    ) VALUES (?, ?, 'official', 'active', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, address) DO UPDATE SET
      kind = CASE WHEN addresses.kind = 'primary' THEN 'primary' ELSE 'official' END,
      status = 'active', strategy = excluded.strategy, label = excluded.label,
      purpose = excluded.purpose, updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    aliases.forEach((address) => {
      const hidden = type === "hide_my_email"
        || (type !== "mail_alias" && isIcloudPrivateRelay(address));
      const customDomain = type === "custom_domain";
      insert.run(
        account.id,
        address,
        customDomain
          ? ICLOUD_CUSTOM_DOMAIN_STRATEGY
          : hidden ? ICLOUD_HIDE_MY_EMAIL_STRATEGY : ICLOUD_MAIL_ALIAS_STRATEGY,
        customDomain
          ? "iCloud 自定义域名邮箱"
          : hidden ? "iCloud 隐藏邮箱" : "iCloud 邮箱别名",
        purpose,
        remoteConfirmed ? 1 : 0,
        now,
        now,
      );
    });
    let removed = 0;
    if (replace && type) {
      const placeholders = aliases.map(() => "?").join(",");
      const statement = aliases.length
        ? `DELETE FROM addresses
           WHERE account_id = ? AND kind = 'official' AND strategy = ?
             AND address NOT IN (${placeholders})`
        : `DELETE FROM addresses
           WHERE account_id = ? AND kind = 'official' AND strategy = ?`;
      removed = db.prepare(statement).run(account.id, targetStrategy, ...aliases).changes;
    }
    const auditAction = type === "custom_domain"
      ? `${replace ? "同步" : "导入"} iCloud 自定义域名邮箱`
      : type === "hide_my_email"
        ? `${replace ? "同步" : "导入"} iCloud 隐藏邮箱`
        : `${replace ? "同步" : "导入"} iCloud 邮箱别名`;
    audit(
      db,
      account.id,
      "alias",
      auditAction,
      `本次保存 ${aliases.length} 个地址，移除 ${removed} 个本地映射`,
      { count: aliases.length, removed },
    );
  })();
  return db.prepare(`
    SELECT * FROM addresses
    WHERE account_id = ? AND kind IN ('primary', 'official')
    ORDER BY kind = 'primary' DESC, created_at
  `).all(account.id);
}

export function syncOfficialAddresses(db, account, aliases) {
  const now = nowIso();
  const normalized = [...new Set((aliases || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  const insert = db.prepare(`
    INSERT INTO addresses (account_id, address, kind, status, strategy, label, remote_confirmed, created_at, updated_at)
    VALUES (?, ?, ?, 'active', 'official', ?, 1, ?, ?)
    ON CONFLICT(account_id, address) DO UPDATE SET
      status = 'active', remote_confirmed = 1, updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    normalized.forEach((address) => insert.run(
      account.id,
      address,
      address === account.email ? "primary" : "official",
      address === account.email ? "源头地址" : "微软官方别名",
      now,
      now,
    ));
    db.prepare("UPDATE source_accounts SET status = 'connected', last_synced_at = ?, limit_reason = '', updated_at = ? WHERE id = ?")
      .run(now, now, account.id);
    const used = db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active'").get(account.id).count;
    const remaining = Math.max(0, account.official_limit - used);
    if (remaining) {
      db.prepare(`
        UPDATE automation_jobs SET progress_target = progress_current + ?, updated_at = ?
        WHERE account_id = ? AND type = 'official_fill' AND status IN ('queued', 'running', 'waiting_user')
      `).run(remaining, now, account.id);
    } else {
      db.prepare(`
        UPDATE automation_jobs SET status = 'completed', progress_target = progress_current,
          message = '官方别名已经达到上限', stop_reason = '', finished_at = ?, updated_at = ?
        WHERE account_id = ? AND type = 'official_fill' AND status IN ('queued', 'running', 'waiting_user')
      `).run(now, now, account.id);
    }
    audit(db, account.id, "alias", "同步微软官方别名", `当前共 ${normalized.length} 个基础地址`, { aliases: normalized });
  })();
  return db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind IN ('primary', 'official') ORDER BY kind = 'primary' DESC, created_at").all(account.id);
}

export function generateSplits(db, account, input = {}) {
  const requestedIds = Array.isArray(input.baseAddressIds) ? input.baseAddressIds.map(Number).filter(Boolean) : [];
  const placeholders = requestedIds.length ? requestedIds.map(() => "?").join(",") : "";
  const bases = requestedIds.length
    ? db.prepare(`SELECT * FROM addresses WHERE account_id = ? AND id IN (${placeholders}) AND kind IN ('primary', 'official') AND status = 'active'`).all(account.id, ...requestedIds)
    : db.prepare("SELECT * FROM addresses WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active' ORDER BY kind = 'primary' DESC").all(account.id);
  if (!bases.length) throw Object.assign(new Error("请选择至少一个可用的基础地址"), { status: 400 });
  const countPerBase = Math.max(1, Math.min(2_000, Number(input.countPerBase) || 1));
  if (bases.length * countPerBase > 5_000) throw Object.assign(new Error("单次最多生成 5000 个分裂地址"), { status: 400 });
  const customSuffixRaw = String(input.customSuffix || "").trim();
  const customSuffix = normalizeTag(customSuffixRaw);
  if (customSuffixRaw.length > 24) throw Object.assign(new Error("自定义后缀最多 24 个字符"), { status: 400 });
  if (customSuffixRaw && !customSuffix) throw Object.assign(new Error("自定义后缀需包含字母、数字、点、下划线或连字符"), { status: 400 });
  const now = nowIso();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO addresses (account_id, parent_address_id, address, kind, status, strategy, label, purpose, remote_confirmed, created_at, updated_at)
    VALUES (?, ?, ?, 'split', 'active', 'plus', ?, ?, 0, ?, ?)
  `);
  const createdIds = [];
  db.transaction(() => {
    for (const base of bases) {
      let sequence = db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE parent_address_id = ? AND kind = 'split'").get(base.id).count + 1;
      let createdForBase = 0;
      let attempts = 0;
      while (createdForBase < countPerBase && attempts < countPerBase * 20) {
        attempts += 1;
        let customTag = "";
        if (customSuffix) {
          const local = String(base.address).split("@")[0] || "";
          const counter = countPerBase > 1 ? `-${String(attempts).padStart(2, "0")}` : "";
          const maxTagLength = 63 - local.length;
          if (maxTagLength <= counter.length) throw Object.assign(new Error("基础地址过长，无法使用自定义后缀"), { status: 400 });
          const baseTag = normalizeTag(`${input.prefix || "alias"}-${customSuffix}`);
          customTag = `${baseTag.slice(0, maxTagLength - counter.length)}${counter}`;
        }
        const address = splitAddress(base.address, {
          prefix: input.prefix,
          mode: input.mode,
          sequence,
          randomLength: input.randomLength,
          customTag,
        });
        sequence += 1;
        const result = insert.run(
          account.id,
          base.id,
          address,
          String(input.label || input.prefix || "分裂地址"),
          String(input.purpose || ""),
          now,
          now,
        );
        if (result.changes) {
          createdIds.push(Number(result.lastInsertRowid));
          createdForBase += 1;
        } else if (customSuffix && countPerBase === 1) {
          throw Object.assign(new Error(`自定义后缀已存在：${customSuffix}`), { status: 409 });
        }
      }
      if (customSuffix && createdForBase < countPerBase) {
        throw Object.assign(new Error("自定义后缀可用编号不足，请更换后缀"), { status: 409 });
      }
    }
    audit(db, account.id, "split", "批量生成分裂地址", `${bases.length} 个基础地址，共生成 ${createdIds.length} 个`, { baseAddressIds: bases.map((item) => item.id), count: createdIds.length });
  })();
  if (!createdIds.length) return [];
  const ids = createdIds.map(() => "?").join(",");
  return db.prepare(`
    SELECT addresses.*, parent.address AS parent_address
    FROM addresses LEFT JOIN addresses parent ON parent.id = addresses.parent_address_id
    WHERE addresses.id IN (${ids}) ORDER BY addresses.id
  `).all(...createdIds);
}

export function deleteSplitAddresses(db, { ids = [], accountId, all = false } = {}) {
  const normalizedIds = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (normalizedIds.length > 5_000) throw Object.assign(new Error("单次最多删除 5000 个分裂地址"), { status: 400 });
  if (!all && !normalizedIds.length) throw Object.assign(new Error("请选择要删除的分裂地址"), { status: 400 });

  const conditions = ["kind = 'split'"];
  const params = [];
  if (accountId) {
    conditions.push("account_id = ?");
    params.push(Number(accountId));
  }
  if (!all) {
    conditions.push(`id IN (${normalizedIds.map(() => "?").join(",")})`);
    params.push(...normalizedIds);
  }
  const items = db.prepare(`SELECT id, account_id FROM addresses WHERE ${conditions.join(" AND ")}`).all(...params);
  if (!items.length) return { deleted: 0, accountIds: [] };

  const byAccount = new Map();
  items.forEach((item) => byAccount.set(item.account_id, (byAccount.get(item.account_id) || 0) + 1));
  const remove = db.prepare("DELETE FROM addresses WHERE id = ? AND kind = 'split'");
  db.transaction(() => {
    items.forEach((item) => remove.run(item.id));
    byAccount.forEach((count, sourceAccountId) => {
      audit(db, sourceAccountId, "split", "批量删除分裂地址", `共删除 ${count} 个`, { count });
    });
  })();
  return { deleted: items.length, accountIds: [...byAccount.keys()] };
}

export function deleteSelectedAddresses(db, { ids = [], accountId } = {}) {
  const normalizedIds = [...new Set((Array.isArray(ids) ? ids : []).map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
  if (normalizedIds.length > 5_000) throw Object.assign(new Error("单次最多删除 5000 个地址"), { status: 400 });
  if (!normalizedIds.length) throw Object.assign(new Error("请选择要删除的地址"), { status: 400 });

  const conditions = [`addresses.id IN (${normalizedIds.map(() => "?").join(",")})`];
  const params = [...normalizedIds];
  if (accountId) {
    conditions.push("addresses.account_id = ?");
    params.push(Number(accountId));
  }
  const items = db.prepare(`
    SELECT addresses.id, addresses.account_id, addresses.address, addresses.kind,
      addresses.strategy, source_accounts.provider AS source_provider
    FROM addresses
    JOIN source_accounts ON source_accounts.id = addresses.account_id
    WHERE ${conditions.join(" AND ")}
  `).all(...params);
  const typed = items.map((item) => ({
    ...item,
    imported_icloud: item.source_provider === "icloud"
      && item.kind === "official"
      && isIcloudImportedStrategy(item.strategy),
    imported_mailcom: item.source_provider === "mailcom"
      && item.kind === "official"
      && isMailcomAliasStrategy(item.strategy),
    imported_netease: item.source_provider === "netease"
      && item.kind === "official"
      && isNeteaseAliasStrategy(item.strategy),
  }));
  if (typed.some((item) => item.kind !== "split" && !item.imported_icloud && !item.imported_mailcom && !item.imported_netease)) {
    throw Object.assign(new Error("所选地址包含不能从本地删除的源头号或官方别名"), { status: 409 });
  }
  if (!typed.length) return {
    deleted: 0,
    split_deleted: 0,
    imported_icloud_deleted: 0,
    imported_mailcom_deleted: 0,
    imported_netease_deleted: 0,
    imported_alias_deleted: 0,
    accountIds: [],
    ids: [],
  };

  const summaries = new Map();
  const remove = db.prepare("DELETE FROM addresses WHERE id = ?");
  const archiveMailcom = db.prepare(`
    UPDATE addresses
    SET status = 'disabled', remote_confirmed = 0, updated_at = ?
    WHERE id = ? AND kind = 'official' AND strategy = ?
  `);
  db.transaction(() => {
    const removedAt = nowIso();
    for (const item of typed) {
      if (item.imported_mailcom) archiveMailcom.run(removedAt, item.id, MAILCOM_ALIAS_STRATEGY);
      else remove.run(item.id);
      const current = summaries.get(item.account_id) || { split: 0, importedIcloud: 0, importedMailcom: 0, importedNetease: 0 };
      if (item.imported_icloud) current.importedIcloud += 1;
      else if (item.imported_mailcom) current.importedMailcom += 1;
      else if (item.imported_netease) current.importedNetease += 1;
      else current.split += 1;
      summaries.set(item.account_id, current);
    }
    for (const [sourceAccountId, summary] of summaries) {
      const count = summary.split + summary.importedIcloud + summary.importedMailcom + summary.importedNetease;
      audit(db, sourceAccountId, "address", "批量删除本地地址", `共删除 ${count} 个`, {
        count,
        split_count: summary.split,
        imported_icloud_count: summary.importedIcloud,
        imported_mailcom_count: summary.importedMailcom,
        imported_netease_count: summary.importedNetease,
      });
    }
  })();
  const splitDeleted = typed.filter((item) => item.kind === "split").length;
  const importedIcloudDeleted = typed.filter((item) => item.imported_icloud).length;
  const importedMailcomDeleted = typed.filter((item) => item.imported_mailcom).length;
  const importedNeteaseDeleted = typed.filter((item) => item.imported_netease).length;
  return {
    deleted: typed.length,
    split_deleted: splitDeleted,
    imported_icloud_deleted: importedIcloudDeleted,
    imported_mailcom_deleted: importedMailcomDeleted,
    imported_netease_deleted: importedNeteaseDeleted,
    imported_alias_deleted: importedIcloudDeleted + importedMailcomDeleted + importedNeteaseDeleted,
    accountIds: [...summaries.keys()],
    ids: typed.map((item) => item.id),
  };
}

export function persistInboxScanResult(db, account, result = {}) {
  const insertCode = db.prepare(`
    INSERT OR IGNORE INTO verification_codes (account_id, address_id, fingerprint, code, sender, subject, preview, received_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO mail_messages (
      account_id, address_id, fingerprint, graph_message_id, internet_message_id,
      sender_name, sender_address, recipient_address, to_recipients, cc_recipients,
      subject, preview, body, body_content_type, body_truncated, verification_code,
      web_link, is_read, has_attachments, received_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, graph_message_id) DO UPDATE SET
      address_id = excluded.address_id,
      internet_message_id = excluded.internet_message_id,
      sender_name = excluded.sender_name,
      sender_address = excluded.sender_address,
      recipient_address = excluded.recipient_address,
      to_recipients = excluded.to_recipients,
      cc_recipients = excluded.cc_recipients,
      subject = excluded.subject,
      preview = excluded.preview,
      body = excluded.body,
      body_content_type = excluded.body_content_type,
      body_truncated = excluded.body_truncated,
      verification_code = excluded.verification_code,
      web_link = excluded.web_link,
      is_read = excluded.is_read,
      has_attachments = excluded.has_attachments,
      received_at = excluded.received_at,
      updated_at = excluded.updated_at
  `);
  const addresses = db.prepare("SELECT id, address, strategy FROM addresses WHERE account_id = ?").all(account.id);
  const addressByValue = new Map(addresses.map((item) => [item.address.toLowerCase(), item]));
  const findAddress = (item) => {
    const recipients = [item.recipient, ...(Array.isArray(item.recipients) ? item.recipients : [])]
      .map((value) => String(value || "").toLowerCase())
      .filter(Boolean);
    const matches = recipients.map((value) => addressByValue.get(value)).filter(Boolean);
    return matches.find((address) => (
      isIcloudImportedStrategy(address.strategy) || isMailcomAliasStrategy(address.strategy) || isNeteaseAliasStrategy(address.strategy)
    )) || matches[0] || null;
  };
  let addedCodes = 0;
  let addedMessages = 0;
  const foundMessages = Array.isArray(result.messages) ? result.messages : [];
  const foundCodes = Array.isArray(result.items) ? result.items : [];
  db.transaction(() => {
    foundMessages.forEach((item) => {
      if (!item.graphMessageId) return;
      const address = findAddress(item);
      const existed = db.prepare("SELECT 1 FROM mail_messages WHERE account_id = ? AND graph_message_id = ?").get(account.id, item.graphMessageId);
      const now = nowIso();
      const insertResult = insertMessage.run(
        account.id,
        address?.id || null,
        item.fingerprint,
        item.graphMessageId,
        item.internetMessageId || "",
        item.senderName || "",
        item.senderAddress || "",
        address?.address || item.recipient || "",
        JSON.stringify(item.toRecipients || []),
        JSON.stringify(item.ccRecipients || []),
        item.subject || "(无主题)",
        item.preview || "",
        item.body || "",
        item.bodyContentType || "text",
        item.bodyTruncated ? 1 : 0,
        item.verificationCode || "",
        item.webLink || "",
        item.isRead ? 1 : 0,
        item.hasAttachments ? 1 : 0,
        item.receivedAt || now,
        now,
        now,
      );
      if (!existed && insertResult.changes) addedMessages += 1;
    });
    foundCodes.forEach((item) => {
      const address = findAddress(item);
      const insertResult = insertCode.run(account.id, address?.id || null, item.fingerprint, item.code, item.sender, item.subject, item.preview, item.receivedAt, nowIso());
      if (insertResult.changes) {
        addedCodes += 1;
        if (address) db.prepare("UPDATE addresses SET last_code_at = ?, updated_at = ? WHERE id = ?").run(item.receivedAt, nowIso(), address.id);
      }
    });
    db.prepare("UPDATE source_accounts SET last_inbox_scan_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), account.id);
  })();
  return {
    found: foundCodes.length,
    added: addedCodes,
    messages: { found: foundMessages.length, added: addedMessages },
    codes: { found: foundCodes.length, added: addedCodes },
  };
}

export class JobRunner {
  constructor(db, inbox) {
    this.db = db;
    this.inbox = inbox;
    this.running = false;
  }

  createJob(accountId, type, config = {}, target = 0) {
    const now = nowIso();
    const result = this.db.prepare(`
      INSERT INTO automation_jobs (account_id, type, status, progress_target, config, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, ?, ?, ?)
    `).run(accountId, type, target, JSON.stringify(config), now, now);
    const id = Number(result.lastInsertRowid);
    this.schedule();
    return this.getJob(id);
  }

  getJob(id) {
    const row = this.db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(Number(id));
    return row ? { ...row, config: parseJson(row.config), result: parseJson(row.result) } : null;
  }

  schedule() {
    if (this.running) return;
    setImmediate(() => this.drain().catch((error) => console.error("[jobs]", error)));
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      let row;
      while ((row = this.db.prepare("SELECT * FROM automation_jobs WHERE status = 'queued' AND type = 'inbox_scan' ORDER BY created_at LIMIT 1").get())) {
        await this.processInboxScan(row);
      }
    } finally {
      this.running = false;
    }
  }

  updateJob(id, values) {
    const allowed = ["status", "progress_current", "progress_target", "message", "stop_reason", "result", "started_at", "finished_at"];
    const entries = Object.entries(values).filter(([key]) => allowed.includes(key));
    const fields = entries.map(([key]) => `${key} = ?`).join(", ");
    const params = entries.map(([key, value]) => key === "result" && typeof value !== "string" ? JSON.stringify(value) : value);
    this.db.prepare(`UPDATE automation_jobs SET ${fields}, updated_at = ? WHERE id = ?`).run(...params, nowIso(), id);
  }

  async processInboxScan(job) {
    const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(job.account_id);
    if (!account) return this.updateJob(job.id, { status: "failed", message: "源头邮箱不存在", finished_at: nowIso() });
    this.updateJob(job.id, {
      status: "running",
      message: account.provider === "google"
        ? "正在读取 Gmail 收件箱"
        : account.provider === "icloud"
          ? "正在读取 iCloud Mail 收件箱"
          : account.provider === "mailcom"
            ? "正在读取 Mail.com 收件箱"
          : account.provider === "netease"
            ? "正在读取网易邮箱所有文件夹"
          : account.provider === "inbox_link" ? "正在读取链接取件邮箱" : "正在读取 Outlook 收件箱",
      started_at: nowIso(),
    });
    try {
      const result = await this.inbox.scanInbox(account);
      if (result.stage !== "completed") {
        this.updateJob(job.id, { status: "waiting_user", message: result.message, stop_reason: result.stage, result, finished_at: nowIso() });
        return;
      }
      const jobResult = persistInboxScanResult(this.db, account, result);
      this.updateJob(job.id, {
        status: "completed",
        progress_current: jobResult.messages.added,
        progress_target: jobResult.messages.found,
        message: `新增 ${jobResult.messages.added} 封邮件，新增 ${jobResult.codes.added} 条验证码`,
        result: jobResult,
        finished_at: nowIso(),
      });
      audit(this.db, account.id, "mail", "扫描收件箱", `新增 ${jobResult.messages.added} 封邮件，新增 ${jobResult.codes.added} 条验证码`, { jobId: job.id, ...jobResult });
    } catch (error) {
      this.updateJob(job.id, { status: "failed", message: error.message, stop_reason: "mail_read_error", finished_at: nowIso() });
    }
  }
}
