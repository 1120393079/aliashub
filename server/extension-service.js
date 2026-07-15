import crypto from "node:crypto";
import { officialCandidate, normalizeMicrosoftEmail } from "./address-generator.js";
import { parseJson, publicAccount, syncOfficialAddresses } from "./account-service.js";
import { audit, getSetting, nowIso } from "./db.js";

const MICROSOFT_ALIAS_URL = "https://account.live.com/names/manage";

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireMicrosoftAccount(account) {
  if (account?.provider !== "microsoft") {
    throw Object.assign(new Error("Google 账号不支持 Microsoft 官方别名功能"), {
      status: 409,
      code: "OFFICIAL_ALIASES_UNSUPPORTED",
    });
  }
  return account;
}

export class ExtensionService {
  constructor(db, { apiKey } = {}) {
    this.db = db;
    this.apiKeyOverride = apiKey || process.env.EXTENSION_API_KEY || "";
  }

  get apiKey() {
    return this.apiKeyOverride || getSetting(this.db, "extension_api_key", "");
  }

  officialUrl(account) {
    requireMicrosoftAccount(account);
    const params = new URLSearchParams({
      id: "38936",
      wa: "wsignin1.0",
      wreply: MICROSOFT_ALIAS_URL,
      username: account.email,
    });
    return `https://login.live.com/login.srf?${params}`;
  }

  setTarget(accountId, jobId = null) {
    const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(Number(accountId));
    if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
    requireMicrosoftAccount(account);
    if (jobId) {
      const job = this.db.prepare("SELECT account_id, type FROM automation_jobs WHERE id = ?").get(Number(jobId));
      if (!job || job.type !== "official_fill" || job.account_id !== account.id) {
        throw Object.assign(new Error("官方别名任务与源头邮箱不匹配"), { status: 409 });
      }
    }
    const now = nowIso();
    const save = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    this.db.transaction(() => {
      save.run("extension_target_account_id", String(account.id), now);
      save.run("extension_target_job_id", jobId ? String(jobId) : "", now);
    })();
    return { account, jobId: jobId ? Number(jobId) : null, officialUrl: this.officialUrl(account) };
  }

  connectorTarget() {
    const explicitAccountId = Number(getSetting(this.db, "extension_target_account_id", ""));
    if (explicitAccountId) {
      const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(explicitAccountId);
      if (account?.provider === "microsoft") {
        const storedJobId = Number(getSetting(this.db, "extension_target_job_id", ""));
        const job = storedJobId
          ? this.db.prepare(`
            SELECT id FROM automation_jobs
            WHERE id = ? AND account_id = ? AND type = 'official_fill'
              AND status IN ('queued', 'running', 'waiting_user')
          `).get(storedJobId, account.id)
          : null;
        return { account, jobId: job?.id || null };
      }
    }
    const active = this.db.prepare(`
      SELECT source_accounts.*, automation_jobs.id AS connector_job_id
      FROM automation_jobs
      JOIN source_accounts ON source_accounts.id = automation_jobs.account_id
      WHERE automation_jobs.type = 'official_fill'
        AND source_accounts.provider = 'microsoft'
        AND automation_jobs.status IN ('queued', 'running', 'waiting_user')
      ORDER BY automation_jobs.updated_at DESC, automation_jobs.id DESC
      LIMIT 1
    `).get();
    return active ? { account: active, jobId: active.connector_job_id } : null;
  }

  requireKey(req, res, next) {
    const provided = req.get("X-AliasHub-Extension-Key") || req.query.key;
    if (this.apiKey && safeEqual(provided, this.apiKey)) return next();
    return res.status(401).json({ error: "浏览器扩展配对密钥无效" });
  }

  accounts() {
    const target = this.connectorTarget();
    if (!target) return [];
    const aliases = this.db.prepare(`
      SELECT address FROM addresses
      WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active'
      ORDER BY kind = 'primary' DESC, created_at
    `).all(target.account.id).map((item) => item.address.toLowerCase());
    return [{
      id: target.account.id,
      email: target.account.email,
      display_name: target.account.display_name,
      status: target.account.status,
      aliases,
      jobId: target.jobId,
      officialUrl: this.officialUrl(target.account),
    }];
  }

  claimTask(email) {
    const normalized = normalizeMicrosoftEmail(email);
    const account = normalized
      ? this.db.prepare("SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE AND provider = 'microsoft'").get(normalized)
      : null;
    if (!account) return null;
    const target = this.connectorTarget();
    if (!target || target.account.id !== account.id || !target.jobId) return null;
    const job = this.db.prepare(`
      SELECT * FROM automation_jobs
      WHERE id = ? AND account_id = ? AND type = 'official_fill'
        AND status IN ('queued', 'running', 'waiting_user')
    `).get(target.jobId, account.id);
    if (!job) return null;
    if (!job.progress_target) {
      this.db.prepare("UPDATE automation_jobs SET status = 'completed', message = '官方别名已经达到上限', finished_at = ?, updated_at = ? WHERE id = ?")
        .run(nowIso(), nowIso(), job.id);
      return null;
    }

    const config = parseJson(job.config);
    const result = { created: [], attempts: 0, ...parseJson(job.result) };
    if (!result.pendingCandidate) {
      result.attempts += 1;
      const used = this.db.prepare("SELECT COUNT(*) AS count FROM addresses WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active'").get(account.id).count;
      result.pendingCandidate = officialCandidate({
        prefix: config.prefix,
        mode: config.mode,
        sequence: used + result.attempts,
      });
    }
    const now = nowIso();
    this.db.prepare(`
      UPDATE automation_jobs SET status = 'running', message = ?, result = ?,
        started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?
    `).run(`官网扩展正在尝试 ${result.pendingCandidate}@outlook.com`, JSON.stringify(result), now, now, job.id);
    return {
      id: job.id,
      accountId: account.id,
      email: account.email,
      candidate: result.pendingCandidate,
      address: `${result.pendingCandidate}@outlook.com`,
      progressCurrent: job.progress_current,
      progressTarget: job.progress_target,
      attempts: result.attempts,
    };
  }

  report(jobId, input = {}) {
    const job = this.db.prepare("SELECT * FROM automation_jobs WHERE id = ? AND type = 'official_fill'").get(Number(jobId));
    if (!job) throw Object.assign(new Error("官方别名任务不存在"), { status: 404 });
    if (!["queued", "running", "waiting_user"].includes(job.status)) {
      throw Object.assign(new Error("官方别名任务已结束，拒绝扩展继续上报"), { status: 409 });
    }
    const target = this.connectorTarget();
    if (!target || target.account.id !== job.account_id || target.jobId !== job.id) {
      throw Object.assign(new Error("这个任务已不再是当前连接器任务"), { status: 409 });
    }
    const account = this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(job.account_id);
    if (!account) throw Object.assign(new Error("源头邮箱不存在"), { status: 404 });
    requireMicrosoftAccount(account);
    const config = parseJson(job.config);
    const result = { created: [], attempts: 0, ...parseJson(job.result) };
    const candidate = result.pendingCandidate;
    if (!candidate) throw Object.assign(new Error("任务当前没有待确认地址"), { status: 409 });
    const now = nowIso();

    if (input.status === "created") {
      const address = String(input.address || `${candidate}@outlook.com`).trim().toLowerCase();
      if (address !== `${candidate}@outlook.com`) throw Object.assign(new Error("扩展上报的别名与当前任务不匹配"), { status: 409 });
      this.db.prepare(`
        INSERT INTO addresses (account_id, address, kind, status, strategy, label, purpose, remote_confirmed, created_at, updated_at)
        VALUES (?, ?, 'official', 'active', 'official', ?, ?, 1, ?, ?)
        ON CONFLICT(account_id, address) DO UPDATE SET status = 'active', remote_confirmed = 1, updated_at = excluded.updated_at
      `).run(account.id, address, config.label || "微软官方别名", config.purpose || "", now, now);
      if (!result.created.includes(address)) result.created.push(address);
      result.pendingCandidate = "";
      const progress = Math.min(job.progress_target, job.progress_current + 1);
      const completed = progress >= job.progress_target;
      this.db.prepare(`
        UPDATE automation_jobs SET status = ?, progress_current = ?, message = ?, result = ?,
          finished_at = ?, updated_at = ? WHERE id = ?
      `).run(
        completed ? "completed" : "running",
        progress,
        completed ? `已创建 ${progress} 个官方别名` : `已创建 ${address}`,
        JSON.stringify(result),
        completed ? now : null,
        now,
        job.id,
      );
      this.db.prepare("UPDATE source_accounts SET status = 'connected', last_synced_at = ?, updated_at = ? WHERE id = ?").run(now, now, account.id);
      audit(this.db, account.id, "alias", "创建微软官方别名", address, { jobId: job.id, source: "browser_extension" });
    } else if (input.status === "taken") {
      result.pendingCandidate = "";
      const exhausted = result.attempts >= Math.max(40, job.progress_target * 20);
      this.db.prepare("UPDATE automation_jobs SET status = ?, message = ?, stop_reason = ?, result = ?, finished_at = ?, updated_at = ? WHERE id = ?")
        .run(exhausted ? "failed" : "running", exhausted ? "可用别名尝试次数已用完" : `${candidate}@outlook.com 已被占用，继续尝试`, exhausted ? "candidate_exhausted" : "", JSON.stringify(result), exhausted ? now : null, now, job.id);
    } else if (input.status === "limited") {
      const message = String(input.message || "微软限制了继续创建别名");
      this.db.prepare("UPDATE automation_jobs SET status = 'limited', message = ?, stop_reason = 'provider_limit', result = ?, finished_at = ?, updated_at = ? WHERE id = ?")
        .run(message, JSON.stringify(result), now, now, job.id);
      this.db.prepare("UPDATE source_accounts SET limit_reason = ?, updated_at = ? WHERE id = ?").run(message, now, account.id);
    } else if (input.status === "interaction") {
      this.db.prepare("UPDATE automation_jobs SET status = 'waiting_user', message = ?, stop_reason = 'interaction', result = ?, updated_at = ? WHERE id = ?")
        .run(String(input.message || "请在微软官网完成当前验证"), JSON.stringify(result), now, job.id);
    } else {
      const message = String(input.message || "浏览器扩展无法确认创建结果");
      this.db.prepare("UPDATE automation_jobs SET status = 'failed', message = ?, stop_reason = 'extension_error', result = ?, finished_at = ?, updated_at = ? WHERE id = ?")
        .run(message, JSON.stringify(result), now, now, job.id);
    }
    return this.db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(job.id);
  }

  syncAliases(email, aliases) {
    const normalizedEmail = normalizeMicrosoftEmail(email);
    const account = normalizedEmail
      ? this.db.prepare("SELECT * FROM source_accounts WHERE email = ? COLLATE NOCASE AND provider = 'microsoft'").get(normalizedEmail)
      : null;
    if (!account) throw Object.assign(new Error("扩展中的微软账号尚未绑定 AliasHub"), { status: 404 });
    const observedAliases = [...new Set((Array.isArray(aliases) ? aliases : [])
      .map((value) => normalizeMicrosoftEmail(value)).filter(Boolean))];
    const knownAliases = new Set(this.db.prepare(`
      SELECT address FROM addresses
      WHERE account_id = ? AND kind IN ('primary', 'official') AND status = 'active'
    `).all(account.id).map((item) => item.address.toLowerCase()));
    if (!observedAliases.some((address) => knownAliases.has(address))) {
      throw Object.assign(new Error(`当前微软官网不是 ${account.email}，已停止同步`), { status: 409 });
    }
    const validAliases = [...new Set([account.email, ...observedAliases])];
    const items = syncOfficialAddresses(this.db, account, validAliases);
    return { items, account: publicAccount(this.db, this.db.prepare("SELECT * FROM source_accounts WHERE id = ?").get(account.id)) };
  }
}
