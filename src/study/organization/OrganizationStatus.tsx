export default function OrganizationStatus({
  busy,
  error,
  retry,
  onRetry,
}: {
  busy: boolean;
  error: string;
  retry: (() => Promise<void>) | null;
  onRetry: () => void;
}) {
  return (
    <>
      {busy ? <p role="status">正在处理…</p> : null}
      {error ? (
        <div className="org-error" role="alert">
          <p>{error}</p>
          <button className="btn" disabled={busy} onClick={onRetry}>
            {retry ? "重试同一次请求" : "重新读取"}
          </button>
        </div>
      ) : null}
    </>
  );
}
