import { useEffect, useRef } from "react";
import { registerStudyLeaveGuard } from "../navigation";
export function useDraftGuard(dirty: boolean) {
  const ref = useRef(dirty);
  ref.current = dirty;
  useEffect(() => {
    const clear = registerStudyLeaveGuard(
      () => !ref.current || confirm("有尚未保存的修改，确定离开吗？"),
    );
    const unload = (e: BeforeUnloadEvent) => {
      if (ref.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      clear();
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  return () => {
    ref.current = false;
  };
}
