import { useEffect, useRef, useState } from "react";
import {
  MoreHorizontal,
  Pencil,
  FolderInput,
  Copy,
  Trash2,
} from "lucide-react";
import type { StudySet } from "../api";
export default function SetActions({
  set,
  onRename,
  onNavigate,
}: {
  set: StudySet;
  onRename: (s: StudySet) => void;
  onNavigate: (path: string) => boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && ref.current)
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
  const act = (fn: () => unknown) => {
    if (ref.current) ref.current.open = false;
    fn();
  };
  return (
    <details
      ref={ref}
      className={`set-actions ${above ? "opens-above" : ""}`}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        if (e.currentTarget.open)
          setAbove(
            e.currentTarget.getBoundingClientRect().bottom + 210 > innerHeight,
          );
      }}
    >
      <summary
        role="button"
        aria-label={`更多操作：${set.title}`}
        title="更多操作"
      >
        <MoreHorizontal size={19} />
      </summary>
      <div className="set-action-menu">
        <button onClick={() => act(() => onRename(set))}>
          <Pencil size={15} />
          重命名
        </button>
        <button
          onClick={() =>
            act(() => onNavigate("/platform/folders?moveSetId=" + set.id))
          }
        >
          <FolderInput size={15} />
          移动到文件夹
        </button>
        <button
          onClick={() =>
            act(() => onNavigate("/platform/copy?setId=" + set.id))
          }
        >
          <Copy size={15} />
          复制文本资料
        </button>
        <button
          className="set-danger"
          onClick={() =>
            act(() => onNavigate("/platform/trash?setId=" + set.id))
          }
        >
          <Trash2 size={15} />
          移入回收站
        </button>
      </div>
    </details>
  );
}
export function setTone(id: string) {
  return ["sage", "lilac", "sand", "sky"][
    Array.from(id).reduce((n, c) => n + c.charCodeAt(0), 0) % 4
  ];
}
export function studyDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
