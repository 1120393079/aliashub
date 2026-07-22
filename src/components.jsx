import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, ChevronLeft, ChevronRight, Cloud, LoaderCircle, X } from "lucide-react";

const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const notify = useCallback((message, type = "success") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, type }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3200);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast toast-${toast.type}`} key={toast.id}>
            {toast.type === "error" ? <AlertCircle size={17} /> : <Check size={17} />}
            <span>{toast.message}</span>
            <button className="bare-button" aria-label="关闭提示" onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}><X size={15} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

export function MicrosoftMark({ size = 34 }) {
  return <span className="provider-mark microsoft-mark" style={{ "--mark-size": `${size}px` }} aria-hidden="true"><i /><i /><i /><i /></span>;
}

export function GoogleMark({ size = 34 }) {
  return <span className="provider-mark google-mark" style={{ "--mark-size": `${size}px` }} aria-hidden="true"><b>G</b></span>;
}

export function ICloudMark({ size = 34 }) {
  return <span className="provider-mark icloud-mark" style={{ "--mark-size": `${size}px` }} aria-hidden="true"><Cloud size={Math.max(12, Number(size) * 0.62)} /></span>;
}

export function ProviderMark({ provider, size = 34 }) {
  if (provider === "google") return <GoogleMark size={size} />;
  if (provider === "icloud") return <ICloudMark size={size} />;
  return <MicrosoftMark size={size} />;
}

export function Button({ children, variant = "secondary", size = "md", icon: Icon, loading = false, disabled = false, className = "", ...props }) {
  return (
    <button className={`button button-${variant} button-${size} ${className}`} {...props} disabled={loading || disabled}>
      {loading ? <LoaderCircle className="spin" size={16} /> : Icon ? <Icon size={16} /> : null}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon: Icon, label, variant = "ghost", size = 34, className = "", ...props }) {
  return (
    <button className={`icon-button icon-button-${variant} ${className}`} style={{ "--icon-size": `${size}px` }} aria-label={label} title={label} {...props}>
      <Icon size={17} />
    </button>
  );
}

export function Modal({ open, onClose, title, description, children, footer, size = "md" }) {
  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", closeOnEscape);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.classList.remove("modal-open");
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={`modal-backdrop modal-backdrop-${size}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="empty-state">
      {Icon && <div className="empty-icon"><Icon size={24} /></div>}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

export function LoadingBlock({ rows = 4 }) {
  return <div className="loading-block">{Array.from({ length: rows }, (_, index) => <div className="skeleton-line" key={index} />)}</div>;
}

export function StatusBadge({ status, children }) {
  return <span className={`status-badge status-${status}`}><i />{children || status}</span>;
}

export function Toggle({ checked, onChange, label }) {
  return (
    <label className="toggle-wrap">
      <input type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle" aria-hidden="true"><span /></span>
      {label && <span>{label}</span>}
    </label>
  );
}

export function Pagination({ page, pages, onChange, disabled = false }) {
  if (pages <= 1) return null;
  return (
    <div className="pagination">
      <IconButton icon={ChevronLeft} label="上一页" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)} />
      <span>{page} / {pages}</span>
      <IconButton icon={ChevronRight} label="下一页" disabled={disabled || page >= pages} onClick={() => onChange(page + 1)} />
    </div>
  );
}

export function Segmented({ value, onChange, items, ariaLabel, disabled = false }) {
  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button key={item.value} type="button" className={value === item.value ? "active" : ""} disabled={disabled || item.disabled} onClick={() => onChange(item.value)} role="tab" aria-selected={value === item.value}>
          {item.icon && <item.icon size={15} />}
          <span>{item.label}</span>
          {item.count !== undefined && <b>{item.count}</b>}
        </button>
      ))}
    </div>
  );
}

export function FormField({ label, hint, error, children, className = "" }) {
  return (
    <label className={`form-field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <small className="field-error">{error}</small> : hint ? <small>{hint}</small> : null}
    </label>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title = "确认操作", description, confirmText = "确认", danger = false, loading = false }) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size="sm" footer={<><Button onClick={onClose}>取消</Button><Button variant={danger ? "danger" : "primary"} loading={loading} onClick={onConfirm}>{confirmText}</Button></>}>
      <div className={`confirm-symbol ${danger ? "danger" : ""}`}><AlertCircle size={24} /></div>
    </Modal>
  );
}

export function useAsync(load, dependencies = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const execute = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await load();
      setState({ data, loading: false, error: null });
      return data;
    } catch (error) {
      setState({ data: null, loading: false, error });
      throw error;
    }
  }, dependencies); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { execute().catch(() => {}); }, [execute]);
  return useMemo(() => ({ ...state, reload: execute }), [state, execute]);
}
