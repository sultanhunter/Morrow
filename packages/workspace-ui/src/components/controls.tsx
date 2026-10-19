// Controls: buttons, labelled fields, the native modal dialog and in-app links.
// Links are built only by `buildWorkspacePath`; no href is built from record data.
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { buildWorkspacePath, workspaceRoutes } from "@morrow/contracts/routes";
import { copy } from "../copy";
import { useServices } from "../services";
import { Icon } from "./display";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "className"> & {
  readonly variant?: "primary" | "secondary" | "quiet";
  readonly type?: "button" | "submit";
};
export function Button({ variant = "secondary", type = "button", children, ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} className={`button button-${variant}`}>
      {children}
    </button>
  );
}

export function useRouteHref(route: string, params: Readonly<Record<string, string>>): string {
  return buildWorkspacePath(workspaceRoutes, route, params);
}
/** An in-app link. Plain clicks navigate through the router and its leave guard. */
export function RouteLink({
  route,
  params,
  children,
  current = false,
  className,
  onNavigate,
}: {
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
  readonly children: ReactNode;
  readonly current?: boolean;
  readonly className?: string;
  readonly onNavigate?: () => void;
}) {
  const services = useServices();
  const href = useRouteHref(route, params);
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    onNavigate?.();
    services.navigate(href);
  };
  return (
    <a
      href={href}
      className={className}
      aria-current={current ? "page" : undefined}
      onClick={click}
    >
      {children}
    </a>
  );
}

interface FieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly error?: string | null;
  readonly disabled?: boolean;
  readonly maxLength?: number;
  readonly required?: boolean;
}
function describedBy(hintId: string, errorId: string, hint?: string, error?: string | null) {
  const ids = [hint ? hintId : null, error ? errorId : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}
export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  disabled,
  maxLength,
  required,
}: FieldProps) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        dir="auto"
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id + "-hint", id + "-error", hint, error)}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <small id={id + "-hint"}>{hint}</small> : null}
      {error ? (
        <p id={id + "-error"} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
export function TextArea({
  label,
  value,
  onChange,
  hint,
  error,
  disabled,
  maxLength,
  required,
}: FieldProps) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        dir="auto"
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id + "-hint", id + "-error", hint, error)}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <small id={id + "-hint"}>{hint}</small> : null}
      {error ? (
        <p id={id + "-error"} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
export function focusableWithin(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusable)].filter(
    (element) => element.getClientRects().length > 0 && !element.closest("[inert]"),
  );
}
/** Tab and Shift+Tab cycle inside `root` (drawer and dialogs only). */
export function trapTab(event: KeyboardEvent<HTMLElement>, root: HTMLElement | null) {
  if (event.key !== "Tab" || !root) return;
  const items = focusableWithin(root);
  if (!items.length) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/** Native modal dialog: background inert, Escape closes, focus returns to the opener. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  closeLabel = copy.dialogClose,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly closeLabel?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      const preferred = dialog.querySelector<HTMLElement>("[data-initial-focus]");
      (preferred ?? focusableWithin(dialog)[0])?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      if (opener.current?.isConnected) opener.current.focus();
    }
  }, [open]);
  useEffect(
    () => () => {
      if (ref.current?.open && opener.current?.isConnected) opener.current.focus();
    },
    [],
  );
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => trapTab(event, ref.current)}
    >
      {open ? (
        <>
          <div className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button
              type="button"
              className="button button-quiet icon-button"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="dialog-body">{children}</div>
          {footer ? <div className="dialog-footer">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}
