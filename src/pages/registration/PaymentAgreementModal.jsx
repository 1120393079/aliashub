import { AlertTriangle, CreditCard, KeyRound, LoaderCircle, Settings2, ShieldCheck, Smartphone } from "lucide-react";
import { Button, Modal, StatusBadge } from "../../components.jsx";

const WORKBENCH_URL = "/alias-hub/paypal-pay/?auto_sms=1&embedded=1&auto_start=1&managed_config=1";

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function targetValue(target, name) {
  return firstValue(
    target?.[name],
    target?.account?.[name],
    target?.paymentLink?.[name],
    target?.payment_link?.[name],
  );
}

export default function PaymentAgreementModal({
  open,
  onClose,
  target,
  settings,
  onOpenSettings,
  iframeKey,
}) {
  const loadingSettings = settings === null;
  const configured = Boolean(firstValue(
    settings?.configured,
    settings?.api_key_configured,
    settings?.apiKeyConfigured,
    false,
  ));
  const protocolConfigured = settings?.protocol_configured !== false;
  const account = String(firstValue(
    targetValue(target, "email"),
    targetValue(target, "account_email"),
    targetValue(target, "display_name"),
    "未选择账号",
  ));
  const country = String(firstValue(
    targetValue(target, "protocol_country"),
    "--",
  )).toUpperCase();
  const proxyCount = Number(firstValue(targetValue(target, "protocol_proxy_count"), 0)) || 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="PayPal 自动协议授权"
      description="自动使用已保存的协议国家与代理池，购买对应国家号码并启动授权"
      size="protocol"
    >
      <div className="payment-agreement-modal">
        <section className="payment-agreement-summary">
          <div className="payment-agreement-summary-item">
            <span className="payment-agreement-summary-icon"><CreditCard size={18} /></span>
            <span className="payment-agreement-summary-copy"><small>BA 账号</small><b title={account}>{account}</b></span>
          </div>
          <div className="payment-agreement-summary-item">
            <span className="payment-agreement-summary-icon"><ShieldCheck size={18} /></span>
            <span className="payment-agreement-summary-copy"><small>协议配置</small><b>{country} · {proxyCount} 条代理</b></span>
            <StatusBadge status="active">自动使用</StatusBadge>
          </div>
          <div className="payment-agreement-summary-item">
            <span className="payment-agreement-summary-icon"><Smartphone size={18} /></span>
            <span className="payment-agreement-summary-copy"><small>HeroSMS</small><b>{loadingSettings ? "正在读取接码设置" : configured ? "API Key 已配置" : "请到系统设置配置"}</b></span>
            <StatusBadge status={loadingSettings ? "queued" : configured ? "active" : "warning"}>{loadingSettings ? "读取中" : configured ? "可接码" : "未配置"}</StatusBadge>
          </div>
          {!loadingSettings && <Button className="payment-agreement-settings-toggle" size="sm" icon={Settings2} onClick={onOpenSettings}>HeroSMS 设置</Button>}
        </section>

        <div className="payment-agreement-warning">
          <AlertTriangle size={16} />
          <span>任务会自动使用已保存的 {country} 协议配置；HeroSMS 购买同国家号码并自动接收验证码，账单国家不参与协议流程。</span>
        </div>

        {loadingSettings ? (
          <section className="payment-agreement-loading">
            <LoaderCircle className="spin" size={28} />
            <div><b>正在检查 HeroSMS 接码配置</b><small>检查完成后将自动启动协议授权。</small></div>
          </section>
        ) : !configured ? (
          <section className="payment-agreement-settings-required">
            <span><KeyRound size={24} /></span>
            <div><h3>HeroSMS API Key 尚未配置</h3><p>{settings?.error || settings?.api_key_error || "请在系统设置的 HeroSMS 接码页面保存 API Key，协议工作台不再单独保存密钥。"}</p></div>
            <Button variant="primary" icon={Settings2} onClick={onOpenSettings}>前往 HeroSMS 设置</Button>
          </section>
        ) : !protocolConfigured ? (
          <section className="payment-agreement-settings-required">
            <span><AlertTriangle size={24} /></span>
            <div><h3>协议服务未连接</h3><p>请检查 PayPal 协议服务运行状态。</p></div>
          </section>
        ) : (
          <section className="payment-agreement-workbench">
            <iframe
              key={iframeKey}
              className="payment-agreement-frame"
              src={WORKBENCH_URL}
              title="PayPal 协议支付工作台"
              allow="clipboard-read; clipboard-write"
              referrerPolicy="same-origin"
            />
          </section>
        )}
      </div>
    </Modal>
  );
}
