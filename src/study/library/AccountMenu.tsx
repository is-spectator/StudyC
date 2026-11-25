import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Archive, LogOut } from "lucide-react";
export default function AccountMenu({
  onNavigate,
  onLogout,
}: {
  onNavigate: (path: string) => boolean;
  onLogout: () => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null),
    [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        ref.current.open = false;
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const link = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    if (onNavigate("/platform/local-data") && ref.current)
      ref.current.open = false;
  };
  return (
    <details
      ref={ref}
      className="cloud-account-menu"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary role="button" aria-label="账户菜单" title="账户菜单">
        <span className="cloud-account-dot">C</span>
      </summary>
      <div>
        <a href="/platform/local-data" onClick={link}>
          <Archive size={15} />
          导入与本机数据
        </a>
        <button
          onClick={() => {
            if (ref.current) ref.current.open = false;
            onLogout();
          }}
        >
          <LogOut size={15} />
          退出登录
        </button>
      </div>
    </details>
  );
}
